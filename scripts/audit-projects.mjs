#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverProjects } from './project-inventory.mjs';

export function auditProjects(root, { offline = false, run = spawnSync } = {}) {
  root = resolve(root);
  const inventory = discoverProjects(root);
  let failures = inventory.uncoveredNodeDirectories.length + inventory.errors.length;
  for (const error of inventory.errors) console.error(`FAIL ${error}`);
  for (const warning of inventory.warnings) console.warn(`WARN ${warning}`);
  for (const directory of inventory.uncoveredNodeDirectories) console.error(`FAIL ${directory}: no se puede auditar sin lockfile/workspace verificable.`);
  for (const directory of inventory.nodeAuditDirectories) {
    console.log(`\nAuditing Node project: ${directory}`);
    for (const script of ['security-check.mjs', 'dependency-audit.mjs']) {
      const args = [fileURLToPath(new URL(script, import.meta.url)), '--repository-root', root];
      if (offline && script === 'security-check.mjs') args.push('--offline');
      const result = run(process.execPath, args, { cwd: resolve(root, directory), stdio: 'inherit', timeout: 9 * 60 * 1000 });
      if (result.error || result.signal || result.status !== 0) {
        failures++;
        console.error(`FAIL ${directory}/${script}: ${result.error?.message ?? result.signal ?? `exit ${result.status}`}`);
      }
    }
  }
  if (!inventory.nodeAuditDirectories.length && !inventory.uncoveredNodeDirectories.length) console.log('No Node projects detected; see the inventory and OSV results for other ecosystems.');
  return failures ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = auditProjects(process.cwd(), { offline: process.argv.includes('--offline') }); }
  catch (error) { console.error(`Project audit failed: ${error.message}`); process.exitCode = 1; }
}
