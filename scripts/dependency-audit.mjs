#!/usr/bin/env node
/** Lockfile audits: dev + prod; no application install or lifecycle scripts. */
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function auditCommand(pkg, locks) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json must contain an object.');
  if (locks.length !== 1) throw new Error(`Expected one lockfile, found ${locks.length}.`);
  const manager = locks[0] === 'pnpm-lock.yaml' ? 'pnpm' : locks[0] === 'yarn.lock' ? 'yarn' : 'npm';
  const declared = pkg.packageManager;
  if (manager !== 'npm' && !declared) throw new Error(`Set packageManager in package.json to a concrete ${manager} version.`);
  let version;
  if (declared !== undefined) {
    const match = typeof declared === 'string' && declared.match(/^(npm|pnpm|yarn)@(\d+)\.(\d+)\.(\d+)(?:\+[a-zA-Z0-9._-]+)?$/);
    if (!match) throw new Error('packageManager must specify npm, pnpm or yarn with a concrete major.minor.patch version.');
    if (match[1] !== manager) throw new Error(`packageManager (${match[1]}) does not match the lockfile (${manager}).`);
    version = Number(match[2]);
  }
  if (manager === 'npm') return { manager, command: 'npm', args: ['audit', '--audit-level=high', '--include=dev', '--include=optional', '--include=peer', '--ignore-scripts'] };
  if (manager === 'pnpm') return { manager, command: 'corepack', args: ['pnpm', 'audit', '--audit-level', 'high'] };
  return { manager, command: 'corepack', args: version === 1
    ? ['yarn', 'audit', '--level', 'high']
    : ['yarn', 'npm', 'audit', '--all', '--recursive', '--severity', 'high'] };
}

function main() {
  if (!existsSync('package.json')) throw new Error('No package.json in working directory.');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const locks = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'].filter(existsSync);
  const { manager, command, args } = auditCommand(pkg, locks);
  if (manager === 'yarn' && args[1] === 'audit') console.warn('Yarn Classic audit may also fail for low/moderate findings.');
  console.log(`Dependency audit: ${command} ${args.join(' ')} (dev + production, no install)`);
  const result = spawnSync(command, args, {
    stdio: 'inherit', shell: false, timeout: 8 * 60 * 1000,
    env: { ...process.env, NODE_ENV: 'development', npm_config_ignore_scripts: 'true' },
  });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.signal) throw new Error(`${command} exited due to signal ${result.signal}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\n## Dependency audit\n- Manager: ${manager}\n- Command: \`${command} ${args.join(' ')}\`\n- Status: ${result.status === 0 ? 'PASS' : 'FAILED'}\n`);
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
