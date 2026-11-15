import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCommand } from '../scripts/process-utils.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'magician-package-'));
try {
  const packed = runCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const manifest = JSON.parse(packed.stdout)[0];
  assert.ok(manifest.files.some((file) => file.path === 'cli.mjs'));
  assert.ok(!manifest.files.some((file) => /^(?:assets|test|checks)\//.test(file.path)), 'The installable package must not include artwork or test fixtures.');
  const target = join(temporary, 'target with spaces');
  mkdirSync(target);
  writeFileSync(join(target, 'package.json'), '{"name":"fixture","private":true}');
  writeFileSync(join(target, 'package-lock.json'), '{}');
  writeFileSync(join(target, '.nvmrc'), '24');
  const install = runCommand('npm', ['exec', '--yes', '--ignore-scripts', '--package', join(temporary, manifest.filename), '--', 'magician-security-check', 'init', '--json'], {
    cwd: target, encoding: 'utf8', timeout: 120_000, env: { ...process.env, npm_config_cache: join(temporary, 'npm-cache') },
  });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.equal(JSON.parse(install.stdout).status, 'ok');
  const inventory = spawnSync(process.execPath, [join(target, '.magician/cli.mjs'), 'inventory', '--json'], { cwd: target, encoding: 'utf8' });
  assert.equal(inventory.status, 0, inventory.stdout + inventory.stderr);
  assert.deepEqual(JSON.parse(inventory.stdout).data.repositories[0].data.inventory.nodeAuditDirectories, ['.']);
  assert.equal(existsSync(join(target, 'node_modules')), false);
  assert.ok(readdirSync(target).includes('AGENTS.md'));
  console.log(`PASS: ${manifest.filename} (${manifest.size} bytes), npm exec installation, standalone JSON CLI and no application dependency installation.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
