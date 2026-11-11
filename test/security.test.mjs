import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const validProject = {
  'package.json': JSON.stringify({ name: 'fixture', private: true }),
  'package-lock.json': '{}',
  '.nvmrc': '24',
};

function runFixture(script, files, { summary = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rubicon-security-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      if (content !== null) writeFileSync(join(directory, name), content);
    }
    const summaryPath = join(directory, 'summary.md');
    const result = spawnSync(process.execPath, [join(scripts, script), '--offline'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary ? summaryPath : '' },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      summary: summary ? readFileSync(summaryPath, 'utf8') : '',
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const cases = [
  ['accepts a supported numeric Node pin', {}, 0, /Resultado: 0 fallos/],
  ['rejects a missing package manifest', { 'package.json': null }, 1, /No hay package.json/],
  ['rejects invalid package JSON', { 'package.json': '{' }, 1, /package.json inválido/],
  ['rejects a missing lockfile', { 'package-lock.json': null }, 1, /Falta un lockfile/],
  ['rejects multiple lockfiles', { 'yarn.lock': '' }, 1, /varios lockfiles incompatibles/],
  ['rejects a mismatched package manager', {
    'package.json': JSON.stringify({ packageManager: 'pnpm@10.20.0' }),
  }, 1, /no coincide con el lockfile/],
  ['requires a package manager declaration for pnpm', {
    'package-lock.json': null, 'pnpm-lock.yaml': '',
  }, 1, /Declara packageManager/],
  ['requires a Node version declaration', { '.nvmrc': null }, 1, /Falta declarar la versión de Node/],
  ['rejects an unsupported Node branch', { '.nvmrc': '20' }, 1, /fuera de las ramas soportadas/],
  ['rejects conflicting runtime pins', { '.node-version': '22' }, 1, /no coinciden/],
  ['rejects an unsupported Docker base image', {
    Dockerfile: 'FROM node:18-alpine\n',
  }, 1, /imagen node:18-alpine tiene un Node no soportado/],
  ['warns when offline mode skips patch verification', {
    '.nvmrc': '24.0.0',
  }, 0, /Modo offline: no se comprueba/],
];

for (const [name, overrides, status, message] of cases) {
  test(name, () => {
    const result = runFixture('security-check.mjs', { ...validProject, ...overrides });
    assert.equal(result.status, status, result.output);
    assert.match(result.output, message);
  });
}

test('writes failure details to the GitHub Actions summary', () => {
  const result = runFixture('security-check.mjs', {
    ...validProject, '.nvmrc': '20',
  }, { summary: true });
  assert.equal(result.status, 1, result.output);
  assert.match(result.summary, /❌.*fuera de las ramas soportadas/);
});

for (const [name, overrides, message] of [
  ['missing manifest', { 'package.json': null }, /No package.json/],
  ['ambiguous lockfiles', { 'yarn.lock': '' }, /Expected one lockfile, found 2/],
  ['undeclared pnpm version', {
    'package-lock.json': null, 'pnpm-lock.yaml': '',
  }, /Set packageManager.*concrete pnpm version/],
]) {
  test(`dependency audit rejects ${name} before starting a package manager`, () => {
    const result = runFixture('dependency-audit.mjs', { ...validProject, ...overrides });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, message);
    assert.doesNotMatch(result.output, /Dependency audit:/);
  });
}
