import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real advisory lookup, isolated from the kit and without dependency installation.
const directory = mkdtempSync(join(tmpdir(), 'rubicon-registry-'));
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'rubicon-audit-fixture', version: '1.0.0', private: true,
    devDependencies: { lodash: '4.17.20' },
    scripts: { preinstall: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'unexpected\')"' },
  }));
  const lock = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: directory, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(lock.status, 0, lock.stdout + lock.stderr);
  const audit = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/dependency-audit.mjs', import.meta.url))], {
    cwd: directory, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NODE_ENV: 'production', npm_config_omit: 'dev', GITHUB_STEP_SUMMARY: '' },
  });
  assert.equal(audit.status, 1, audit.stdout + audit.stderr);
  assert.match(audit.stdout + audit.stderr, /lodash/);
  assert.match(audit.stdout + audit.stderr, /high|critical/i);
  assert.equal(existsSync(join(directory, 'lifecycle-ran')), false);
  assert.equal(existsSync(join(directory, 'node_modules')), false);
  console.log('PASS: known vulnerable dev dependency detected despite production/omit settings; no install or lifecycle scripts.');
  if (process.argv.includes('--osv-fixture')) {
    const target = resolve('.rubicon-osv-fixture');
    mkdirSync(target);
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(directory, name), join(target, name));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
