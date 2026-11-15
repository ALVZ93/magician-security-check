import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/security-check.mjs', import.meta.url));
function project(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'rubicon-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}
function run(directory, args) {
  return spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
}

for (const [version, status, message] of [
  ['24.10.1', 0, /coincide con el último patch/],
  ['24.10.0', 1, /es anterior a 24.10.1/],
  ['24.999.999', 1, /no figura como versión publicada/],
]) {
  test(`checks published Node pin ${version} against the official index`, (t) => {
    const root = project(t, { 'package.json': '{}', 'package-lock.json': '{}', '.nvmrc': version,
      'mock-fetch.mjs': `globalThis.fetch = async (url) => ({ ok: true, json: async () => String(url).includes('schedule.json')
        ? { v24: { start: '2025-01-01', end: '2099-01-01' } }
        : [{ version: 'v24.10.1' }, { version: 'v24.10.0' }] });`,
    });
    const result = run(root, ['--import', pathToFileURL(join(root, 'mock-fetch.mjs')).href, script]);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stdout, message);
  });
}

test('fails when the current Node support calendar cannot be checked', (t) => {
  const root = project(t, { 'package.json': '{}', 'package-lock.json': '{}', '.nvmrc': '24',
    'mock-fetch.mjs': 'globalThis.fetch = async () => { throw new Error("network down"); };',
  });
  const result = run(root, ['--import', pathToFileURL(join(root, 'mock-fetch.mjs')).href, script]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /No se pudo comprobar el calendario oficial/);
});

test('inherits the nearest runtime declaration within the repository boundary', (t) => {
  const root = project(t, { '.nvmrc': '24', 'apps/api/package.json': '{}', 'apps/api/package-lock.json': '{}' });
  const result = run(join(root, 'apps/api'), [script, '--offline', '--repository-root', root]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Node en .*nvmrc: 24/);
});

test('rejects a caret range restricted to an unsupported Node major', (t) => {
  const root = project(t, { 'package.json': JSON.stringify({ engines: { node: '^20.0.0' } }), 'package-lock.json': '{}' });
  const result = run(root, [script, '--offline']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /solo permite una rama de Node fuera de soporte/);
});
