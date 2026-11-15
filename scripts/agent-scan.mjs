import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './project-inventory.mjs';
import { executable, parseToolJson, runCommand } from './process-utils.mjs';

export function scan(root, { offline = false, run = spawnSync, runTool = runCommand } = {}) {
  const inventory = discoverProjects(root);
  const checks = [];
  const errors = [];
  const warnings = inventory.warnings.map((message) => ({ code: 'INVENTORY_WARNING', message }));
  for (const message of inventory.errors) checks.push({ id: 'project-configuration', status: 'findings', message });
  for (const directory of inventory.uncoveredNodeDirectories) checks.push({ id: 'lockfile', directory, status: 'findings', message: 'No independent lockfile or verifiable workspace membership.' });
  for (const directory of inventory.nodeAuditDirectories) {
    for (const [id, script] of [['runtime', 'security-check.mjs'], ['dependencies', 'dependency-audit.mjs']]) {
      const args = [fileURLToPath(new URL(script, import.meta.url)), '--json', '--repository-root', root];
      if (offline && id === 'runtime') args.push('--offline');
      const result = run(process.execPath, args, { cwd: resolve(root, directory), encoding: 'utf8', timeout: 9 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' } });
      try {
        if (result.error || result.signal) throw new Error(result.error?.message ?? result.signal);
        const report = JSON.parse(result.stdout);
        if (!['ok', 'findings', 'error'].includes(report.status) || result.status !== { ok: 0, findings: 1, error: 2 }[report.status]) throw new Error('Invalid scanner response or exit code.');
        checks.push({ id, directory, status: report.status, report });
        for (const message of report.warnings ?? []) warnings.push({ code: 'RUNTIME_WARNING', directory, message });
        if (report.status === 'error') errors.push({ code: 'SCANNER_ERROR', directory, message: report.error ?? report.errors?.join('; ') ?? 'Scanner failed.' });
      } catch (error) {
        checks.push({ id, directory, status: 'error' });
        errors.push({ code: 'SCANNER_ERROR', directory, message: error.message });
      }
    }
  }
  const otherProjects = inventory.projects.filter((project) => !['npm', 'docker', 'github-actions'].includes(project.ecosystem));
  if (otherProjects.length) {
    const result = runTool('osv-scanner', ['scan', 'source', '--format=json', '--recursive', '.'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
    });
    try {
      if (result.error || result.signal) throw new Error(result.error?.message ?? result.signal);
      const report = parseToolJson(result.stdout);
      if (![0, 1].includes(result.status) || !Array.isArray(report.results)) throw new Error('OSV did not return a complete scan.');
      checks.push({ id: 'osv', status: result.status === 0 ? 'ok' : 'findings', report });
    } catch (error) {
      checks.push({ id: 'osv', status: 'error' });
      errors.push({ code: 'OSV_UNAVAILABLE', message: `${error.message} Install OSV-Scanner or use the installed GitHub Actions workflow.` });
    }
  }
  const exitCode = errors.length ? 2 : checks.some((check) => check.status === 'findings') ? 1 : 0;
  return { exitCode, errors, warnings, data: { inventory, checks, offline, coverage: { complete: !errors.length && !inventory.uncoveredNodeDirectories.length && !inventory.errors.length,
    scope: 'source-lockfiles-and-node-runtime', excluded: ['deployed-runtime', 'container-image-packages', 'github-actions-advisories'],
    nodeRoots: inventory.nodeAuditDirectories.length, osv: otherProjects.length ? 'required' : 'not-required' } } };
}

export function doctor(root) {
  const inventory = discoverProjects(root);
  const tools = new Set(inventory.projects.filter((project) => project.ecosystem === 'npm').map((project) => project.manager === 'npm' ? 'npm' : 'corepack'));
  if (inventory.projects.some((project) => !['npm', 'docker', 'github-actions'].includes(project.ecosystem))) tools.add('osv-scanner');
  const checks = [...tools].map((name) => ({ name, available: Boolean(executable(name)) }));
  const errors = checks.filter((check) => !check.available).map((check) => ({ code: 'TOOL_NOT_FOUND', message: `${check.name} is required for local scans.` }));
  const findings = [...inventory.errors, ...inventory.uncoveredNodeDirectories.map((directory) => `${directory}: missing lockfile/workspace coverage.`)];
  return { exitCode: errors.length ? 2 : findings.length ? 1 : 0, errors, warnings: inventory.warnings.map((message) => ({ code: 'INVENTORY_WARNING', message })), data: { node: process.versions.node, tools: checks, findings, nextActions: errors.length ? ['Install the missing tools or use the generated GitHub Actions workflow.'] : [] } };
}
