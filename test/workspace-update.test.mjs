import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectProjects, projectScope } from '../scripts/workspace.mjs';
import { incompatibleUpdates, update } from '../scripts/update.mjs';
import { install } from '../scripts/install.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'magician-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}
const packageFiles = { 'package.json': {}, 'package-lock.json': '{}', '.nvmrc': '24' };

test('the same command supports a matrix folder and an individual repository', (t) => {
  const root = fixture(t, { 'one/package.json': {}, 'one/package-lock.json': '{}', 'two/.git': 'gitdir: /worktree',
    'two/package.json': {}, 'two/package-lock.json': '{}', 'one/apps/web/package.json': {} });
  for (const [target, scope, count] of [[root, 'workspace', 2], [join(root, 'two'), 'project', 1]]) {
    const result = spawnSync(process.execPath, [cli, 'matrix', '--root', target, '--json'], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    assert.equal(report.data.scope, scope);
    assert.equal(report.data.repositories.length, count);
    assert.equal(report.data.summary.total, count);
  }
});

test('a Git monorepo is one repository, not each application manifest', (t) => {
  const root = fixture(t, { '.git/marker': '', ...packageFiles, 'apps/web/package.json': {} });
  assert.deepEqual(projectScope(root).roots, [root]);
});

test('workspace discovery does not follow directory links or enter installed dependencies', (t) => {
  const outside = fixture(t, packageFiles);
  const root = fixture(t, { 'real/package.json': {}, 'node_modules/ignored/package.json': {} });
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(projectScope(root).roots, [join(root, 'real')]);
});

test('errors in one repository do not suppress results for the others', (t) => {
  const root = fixture(t, { 'a/package.json': {}, 'b/package.json': {} });
  const result = collectProjects(root, 'auto', (path) => {
    if (path.endsWith('a')) throw new Error('unreadable project');
    return { exitCode: 0, data: {}, errors: [], warnings: [] };
  });
  assert.equal(result.exitCode, 2); assert.equal(result.data.summary.ok, 1); assert.equal(result.data.repositories.length, 2);
});

test('workspace installation leaves the shared CLI without creating parent CI workflows', (t) => {
  const root = fixture(t, { 'repo/package.json': {}, 'repo/package-lock.json': '{}' });
  const result = install(root, { workspace: true, automerge: true });
  assert.ok(existsSync(join(root, '.magician/cli.mjs')));
  assert.ok(!existsSync(join(root, '.github')));
  assert.ok(result.warnings.some((warning) => warning.code === 'WORKSPACE_INSTALL'));
});

const lock = (version) => Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { version } } }));
function auditFixture(root, status = 'findings') {
  return { exitCode: status === 'ok' ? 0 : 1, errors: [], warnings: [], data: {
    inventory: { projects: [{ ecosystem: 'npm', directory: '.', auditDirectory: '.' }] },
    checks: [{ id: 'dependencies', directory: '.', status, report: { manager: 'npm', report: {
      vulnerabilities: status === 'ok' ? {} : { example: { severity: 'high', fixAvailable: true } },
    } } }], coverage: { complete: true },
  } };
}
function toolRunner(root, mutate, { dirty = false } = {}) {
  return (command, args) => {
    if (command === 'git') return { status: 0, stdout: args[0] === 'status' ? dirty ? ' M package.json\n' : '' : join(root, '.git/magician-security-check.lock') };
    assert.equal(command, 'npm'); assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--package-lock-only')); assert.ok(!args.includes('--force'));
    mutate(); return { status: 0, stdout: '{"changed":1}' };
  };
}

test('update plans by default without modifying lockfiles or invoking fix commands', (t) => {
  const root = fixture(t, { ...packageFiles, 'package-lock.json': lock('1.0.0').toString() });
  const before = readFileSync(join(root, 'package-lock.json'));
  const result = update(root, { audit: () => auditFixture(root), runTool: () => { throw new Error('Must not write/run fix commands'); } });
  assert.equal(result.exitCode, 1); assert.equal(result.data.applied, false);
  assert.equal(result.data.actions[0].automatic, true);
  assert.ok(readFileSync(join(root, 'package-lock.json')).equals(before));
});

test('explicit apply accepts compatible lockfile changes, re-audits and releases the Git lock', (t) => {
  const root = fixture(t, { ...packageFiles, '.git/marker': '', 'package-lock.json': lock('1.0.0').toString() });
  let audits = 0;
  const result = update(root, { apply: true, audit: () => auditFixture(root, audits++ ? 'ok' : 'findings'),
    runTool: toolRunner(root, () => writeFileSync(join(root, 'package-lock.json'), lock('1.0.1'))) });
  assert.equal(result.exitCode, 0); assert.equal(result.data.applied, true); assert.equal(audits, 2);
  assert.deepEqual(result.data.changedFiles, ['package-lock.json']);
  assert.equal(result.data.tests, 'not-run');
  assert.ok(!existsSync(join(root, '.git/magician-security-check.lock')));
});

for (const version of ['2.0.0', '1.1.0-beta.1']) {
  test(`automatic ${version} changes are restored for manual review`, (t) => {
    const original = lock('1.0.0');
    const root = fixture(t, { ...packageFiles, '.git/marker': '', 'package-lock.json': original.toString() });
    const result = update(root, { apply: true, audit: () => auditFixture(root), runTool: toolRunner(root, () => writeFileSync(join(root, 'package-lock.json'), lock(version))) });
    assert.equal(result.exitCode, 1); assert.equal(result.data.rolledBack, true);
    assert.ok(readFileSync(join(root, 'package-lock.json')).equals(original));
  });
}

test('dirty worktrees are not changed', (t) => {
  const root = fixture(t, packageFiles);
  const result = update(root, { apply: true, audit: () => auditFixture(root), runTool: toolRunner(root, () => { throw new Error('Must not apply'); }, { dirty: true }) });
  assert.equal(result.exitCode, 2); assert.equal(result.errors[0].code, 'DIRTY_WORKTREE');
});

test('an attempted fix with no file changes is not reported as applied', (t) => {
  const root = fixture(t, { ...packageFiles, '.git/marker': '', 'package-lock.json': lock('1.0.0').toString() });
  const result = update(root, { apply: true, audit: () => auditFixture(root), runTool: toolRunner(root, () => {}) });
  assert.equal(result.exitCode, 1); assert.equal(result.data.applied, false); assert.deepEqual(result.data.changedFiles, []);
});

test('a failed post-update audit restores all affected dependency files', (t) => {
  const original = lock('1.0.0');
  const root = fixture(t, { ...packageFiles, '.git/marker': '', 'package-lock.json': original.toString() });
  let audits = 0;
  const result = update(root, { apply: true, audit: () => audits++ ? { ...auditFixture(root), exitCode: 2, errors: [{ code: 'NETWORK', message: 'unavailable' }] } : auditFixture(root),
    runTool: toolRunner(root, () => writeFileSync(join(root, 'package-lock.json'), lock('1.0.1'))) });
  assert.equal(result.exitCode, 2); assert.equal(result.data.rolledBack, true);
  assert.ok(readFileSync(join(root, 'package-lock.json')).equals(original));
});

test('an existing update lock cannot be removed or bypassed by a second run', (t) => {
  const root = fixture(t, { ...packageFiles, '.git/magician-security-check.lock': '{"token":"other-process"}' });
  const result = update(root, { apply: true, audit: () => auditFixture(root), runTool: toolRunner(root, () => { throw new Error('Must not apply'); }) });
  assert.equal(result.exitCode, 2); assert.equal(result.errors[0].code, 'UPDATE_LOCKED');
  assert.equal(readFileSync(join(root, '.git/magician-security-check.lock'), 'utf8'), '{"token":"other-process"}');
});

test('major detection also covers npm v1 nested dependency trees', () => {
  const original = Buffer.from('{"dependencies":{"a":{"version":"1.0.0","dependencies":{"b":{"version":"1.0.0"}}}}}');
  const changed = Buffer.from('{"dependencies":{"a":{"version":"1.0.0","dependencies":{"b":{"version":"2.0.0"}}}}}');
  assert.equal(incompatibleUpdates(original, changed)[0].name, 'node_modules/a/node_modules/b');
});
