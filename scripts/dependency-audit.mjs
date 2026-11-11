#!/usr/bin/env node
/**
 * Lockfile-based vulnerability audits. Doesn't install app dependencies or run
 * dependency lifecycle scripts. Scans dev + prod to include build tooling.
 */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function fail(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
if (!existsSync('package.json')) fail('No package.json in working directory.');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const files = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
const locks = files.filter(existsSync);
if (locks.length !== 1) fail(`Expected one lockfile, found ${locks.length}.`);
const lock = locks[0];
const manager = lock === 'pnpm-lock.yaml' ? 'pnpm' : lock === 'yarn.lock' ? 'yarn' : 'npm';
const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
if (manager !== 'npm' && !declared.startsWith(`${manager}@`)) {
  fail(`Set packageManager in package.json to a concrete ${manager} version.`);
}
let command, args;
switch (manager) {
  case 'npm':
    command = 'npm';
    args = ['audit', '--audit-level=high'];
    break;
  case 'pnpm':
    command = 'corepack';
    args = ['pnpm', 'audit', '--audit-level', 'high'];
    break;
  case 'yarn': {
    command = 'corepack';
    const version = Number(declared.match(/^yarn@(\d+)/)?.[1]);
    if (!Number.isFinite(version)) fail('packageManager must be yarn@<major>.<minor>.<patch>.');
    args = version === 1
      ? ['yarn', 'audit', '--level', 'high']
      : ['yarn', 'npm', 'audit', '--all', '--recursive', '--severity', 'high'];
    if (version === 1) console.warn('Yarn Classic: audit can fail for low/moderate too. This is intentionally strict.');
    break;
  }
}
console.log(`Dependency audit: ${command} ${args.join(' ')} (dev + production, no install)`);
const result = spawnSync(command, args, { stdio: 'inherit', shell: false, timeout: 8 * 60 * 1000 });
if (result.error) fail(`${command} could not run: ${result.error.message}`);
if (result.signal) fail(`${command} exited due to signal ${result.signal}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n## Dependency audit\n- Manager: ${manager}\n- Command: \`${command} ${args.join(' ')}\`\n- Status: ${result.status === 0 ? 'PASS' : 'FAILED'}\n`);
}
process.exitCode = result.status ?? 1;
