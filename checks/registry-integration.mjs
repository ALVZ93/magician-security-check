import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/process-utils.mjs';

// Real advisory lookup, isolated from the kit and without dependency installation.
const directory = mkdtempSync(join(tmpdir(), 'rubicon-registry-'));
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'rubicon-audit-fixture', version: '1.0.0', private: true,
    devDependencies: { lodash: '4.17.20' },
    scripts: { preinstall: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\', \'unexpected\')"' },
  }));
  writeFileSync(join(directory, '.nvmrc'), '24');
  const lock = runCommand('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
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
  const agentAudit = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'scan', '--offline', '--json'], {
    cwd: directory, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, NODE_ENV: 'production', npm_config_omit: 'dev', GITHUB_STEP_SUMMARY: '' },
  });
  assert.equal(agentAudit.status, 1, agentAudit.stdout + agentAudit.stderr);
  const report = JSON.parse(agentAudit.stdout);
  assert.equal(report.status, 'findings');
  const projectReport = report.data.repositories[0].data;
  assert.equal(projectReport.checks.find((check) => check.id === 'runtime').status, 'ok');
  assert.equal(projectReport.checks.find((check) => check.id === 'dependencies').status, 'findings');
  assert.equal(existsSync(join(directory, 'lifecycle-ran')), false);
  assert.equal(existsSync(join(directory, 'node_modules')), false);
  console.log('PASS: native and agent JSON audits detect the known vulnerable dev dependency despite production/omit settings; no install or lifecycle scripts.');
  if (process.argv.includes('--osv-fixture')) {
    const target = resolve('.rubicon-osv-fixture');
    mkdirSync(target);
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(directory, name), join(target, name));
  }
  // Keep the vulnerable lock entry but allow a compatible patched release.
  const application = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const applicationLock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  application.devDependencies.lodash = '^4.17.20';
  applicationLock.packages[''].devDependencies.lodash = '^4.17.20';
  writeFileSync(join(directory, 'package.json'), JSON.stringify(application));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(applicationLock));
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Magician Test', '-c', 'user.email=magician-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Isolated vulnerable fixture']]) {
    const result = runCommand('git', ['-c', `core.hooksPath=${join(directory, '.git/no-hooks')}`, ...args], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const updated = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'update', '--apply', '--offline', '--json'], {
    cwd: directory, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  const updatedRepo = JSON.parse(updated.stdout).data.repositories[0];
  assert.equal(updatedRepo.data.applied, true);
  assert.ok(updatedRepo.data.changedFiles.includes('package-lock.json'));
  assert.equal(existsSync(join(directory, 'lifecycle-ran')), false);
  assert.equal(existsSync(join(directory, 'node_modules')), false);
  console.log('PASS: explicit update applied the compatible security patch in a clean Git fixture and the post-audit is clean.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
