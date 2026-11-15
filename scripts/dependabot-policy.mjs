#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function dependencyFile(path) {
  if (path.startsWith('.github/') || path.split('/').some((part) => part === '..')) return false;
  return /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|composer\.(?:json|lock)|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|requirements(?:[.-][\w.-]+)?\.txt|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile)$/.test(posix.basename(path));
}

function candidatePolicy({ pr, repository, expectedHead, updateType, files, configuredChecks }) {
  const reject = (reason) => ({ eligible: false, reason });
  if (pr.user?.login !== 'dependabot[bot]' || pr.user?.type !== 'Bot') return reject('Not the Dependabot bot.');
  if (pr.state !== 'open' || pr.draft) return reject('PR must be open and ready for review.');
  if (pr.head?.repo?.full_name !== repository.full_name || pr.base?.repo?.full_name !== repository.full_name) return reject('Fork PRs cannot auto-merge.');
  if (pr.base.ref !== repository.default_branch) return reject('Only the default branch is eligible.');
  if (!expectedHead || pr.head.sha !== expectedHead) return reject('The PR head changed; retry with the new event.');
  if (!['version-update:semver-patch', 'version-update:semver-minor'].includes(updateType)) return reject('Major or unknown update type requires review.');
  if (!files.length || files.length !== pr.changed_files || files.some((file) => !dependencyFile(file.filename) || (file.previous_filename && !dependencyFile(file.previous_filename)))) return reject('PR contains files outside the dependency allowlist or an incomplete file list.');
  if (!repository.allow_auto_merge) return reject('Enable auto-merge in repository settings first.');
  if (!Array.isArray(configuredChecks) || configuredChecks.some((name) => typeof name !== 'string' || !name.trim()) || new Set(configuredChecks).size < 2) return reject('RUBICON_REQUIRED_CHECKS must name at least two distinct checks: security and application tests.');
  return { eligible: true };
}

export function automergePolicy(input) {
  const candidate = candidatePolicy(input);
  if (!candidate.eligible) return candidate;
  const { configuredChecks, branch, rules = [] } = input;
  const enforced = new Set();
  if (branch?.protected && branch.protection?.required_status_checks?.enforcement_level !== 'off') {
    for (const context of branch.protection?.required_status_checks?.contexts ?? []) enforced.add(context);
    for (const check of branch.protection?.required_status_checks?.checks ?? []) enforced.add(check.context);
  }
  for (const rule of rules) {
    if (rule.type === 'required_status_checks') {
      for (const check of rule.parameters?.required_status_checks ?? []) enforced.add(check.context);
    }
  }
  if (configuredChecks.some((check) => !enforced.has(check))) return { eligible: false, reason: 'GitHub does not enforce every configured required check on the target branch.' };
  return { eligible: true, reason: 'Verified patch/minor; GitHub must satisfy all required checks and reviews.' };
}

export async function enableAutomerge({ event, repositoryName, updateType, configuredChecks, api, merge }) {
  const eventPr = event.pull_request;
  if (!eventPr || eventPr.user?.login !== 'dependabot[bot]') return { eligible: false, reason: 'Not a Dependabot PR event.' };
  const base = `/repos/${repositoryName}`;
  const repository = await api(base);
  if (repository.full_name !== repositoryName) throw new Error('Unexpected repository returned by GitHub.');
  const pr = await api(`${base}/pulls/${eventPr.number}`);
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await api(`${base}/pulls/${pr.number}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const input = { pr, repository, expectedHead: eventPr.head.sha, updateType, files, configuredChecks };
  const candidate = candidatePolicy(input);
  if (!candidate.eligible) return candidate;
  const branch = await api(`${base}/branches/${encodeURIComponent(pr.base.ref)}`);
  // This endpoint exposes active rules with Metadata:read; no admin token needed.
  const rules = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await api(`${base}/rules/branches/${encodeURIComponent(pr.base.ref)}?per_page=100&page=${page}`);
    rules.push(...batch);
    if (batch.length < 100) break;
  }
  const decision = automergePolicy({ ...input, branch, rules });
  if (decision.eligible) await merge(pr.number, pr.head.sha);
  return decision;
}

async function main() {
  if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_EVENT_PATH) throw new Error('Run from the Dependabot GitHub Actions workflow.');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const configuredChecks = JSON.parse(process.env.RUBICON_REQUIRED_CHECKS || '[]');
  const repositoryName = process.env.GITHUB_REPOSITORY;
  const api = async (path) => {
    const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}; auto-merge was not enabled.`);
    return response.json();
  };
  const decision = await enableAutomerge({
    event, repositoryName, updateType: process.env.DEPENDABOT_UPDATE_TYPE, configuredChecks, api,
    merge: (number, sha) => {
      const result = spawnSync('gh', ['pr', 'merge', String(number), '--repo', repositoryName,
        '--auto', '--squash', '--match-head-commit', sha], { stdio: 'inherit', shell: false, timeout: 30_000 });
      if (result.error || result.status !== 0) throw new Error(`Could not enable auto-merge: ${result.error?.message ?? result.status}`);
    },
  });
  console.log(`${decision.eligible ? 'AUTO-MERGE' : 'MANUAL REVIEW'}: ${decision.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
