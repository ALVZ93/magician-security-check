import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { install } from '../scripts/install.mjs';
import { scan } from '../scripts/agent-scan.mjs';
import { executable, parseToolJson } from '../scripts/process-utils.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'magician-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}
function invoke(root, args, entry = cli) {
  const result = spawnSync(process.execPath, [entry, ...args, '--root', root, '--json'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.exitCode, result.status);
  assert.equal(report.status, ['ok', 'findings', 'error'][result.status]);
  assert.ok(Array.isArray(report.errors) && Array.isArray(report.warnings));
  return { ...result, report };
}
const valid = { 'package.json': {}, 'package-lock.json': '{}', '.nvmrc': '24' };

test('init dry-run creates no files or directories', (t) => {
  const root = fixture(t, valid); const before = readdirSync(root).sort();
  const result = invoke(root, ['init', '--dry-run', '--automerge']);
  assert.equal(result.status, 0); assert.equal(result.report.data.dryRun, true);
  assert.ok(result.report.data.files.some((file) => file.path === '.github/workflows/dependabot-automerge.yml'));
  assert.deepEqual(readdirSync(root).sort(), before);
});

test('one-command installation creates a working standalone CLI and agent instructions', (t) => {
  const root = fixture(t, valid);
  assert.equal(invoke(root, ['init', '--automerge']).status, 0);
  const inventory = invoke(root, ['inventory'], join(root, '.magician/cli.mjs'));
  assert.equal(inventory.status, 0);
  const project = inventory.report.data.repositories[0].data.inventory;
  assert.deepEqual(project.nodeAuditDirectories, ['.']);
  assert.ok(!project.projects.some((project) => project.directory.includes('.magician')));
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /node \.magician\/cli.mjs scan --json/);
  assert.match(readFileSync(join(root, '.github/workflows/node-security.yml'), 'utf8'), /node \.magician\/scripts\/audit-projects.mjs/);
  assert.match(readFileSync(join(root, '.github/workflows/dependabot-automerge.yml'), 'utf8'), /node \.magician\/scripts\/dependabot-policy.mjs/);
  assert.equal(invoke(root, ['doctor'], join(root, '.magician/cli.mjs')).status, 0);
});

test('reinstall is idempotent and preserves later changes outside the AGENTS section', (t) => {
  const root = fixture(t, { ...valid, 'AGENTS.md': '# Existing\nUse our coding standards.\n' });
  install(root);
  const agents = join(root, 'AGENTS.md');
  writeFileSync(agents, `Additional project rules.\n${readFileSync(agents, 'utf8')}`);
  const result = install(root);
  assert.ok(result.files.every((file) => file.action === 'unchanged'));
  const content = readFileSync(agents, 'utf8');
  assert.ok(content.startsWith('Additional project rules.\n# Existing\nUse our coding standards.\n'));
  assert.equal(content.split('<!-- magician:start -->').length, 2);
});

test('existing Dependabot settings survive and receive a merge candidate', (t) => {
  const original = 'version: 2\nregistries:\n  private: preserved\n';
  const root = fixture(t, { ...valid, '.github/dependabot.yml': original });
  const result = install(root);
  assert.equal(readFileSync(join(root, '.github/dependabot.yml'), 'utf8'), original);
  assert.equal(result.warnings[0].code, 'DEPENDABOT_MERGE_REQUIRED');
  assert.match(readFileSync(join(root, '.github/dependabot.magician.yml'), 'utf8'), /package-ecosystem: "npm"/);
});

test('Git LF/CRLF conversion is not mistaken for user edits on reinstall', (t) => {
  const root = fixture(t, valid); install(root);
  const manifest = JSON.parse(readFileSync(join(root, '.magician/install-manifest.json'), 'utf8'));
  for (const path of [...Object.keys(manifest.files), '.magician/install-manifest.json', 'AGENTS.md']) {
    const file = join(root, path);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  }
  assert.ok(install(root).files.every((file) => file.action === 'unchanged'));
});

test('a custom workflow conflict prevents all installation writes', (t) => {
  const root = fixture(t, { ...valid, '.github/workflows/node-security.yml': 'custom workflow\n' });
  const before = readdirSync(root).sort();
  const result = invoke(root, ['init']);
  assert.equal(result.status, 2); assert.equal(result.report.errors[0].code, 'INSTALL_CONFLICT');
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.equal(readFileSync(join(root, '.github/workflows/node-security.yml'), 'utf8'), 'custom workflow\n');
});

test('reinstall refuses user-edited managed files without updating any other file', (t) => {
  const root = fixture(t, valid); install(root);
  const script = join(root, '.magician/scripts/security-check.mjs'); writeFileSync(script, '// local customization\n');
  const manifest = readFileSync(join(root, '.magician/install-manifest.json'), 'utf8');
  assert.throws(() => install(root), { code: 'INSTALL_CONFLICT' });
  assert.equal(readFileSync(script, 'utf8'), '// local customization\n');
  assert.equal(readFileSync(join(root, '.magician/install-manifest.json'), 'utf8'), manifest);
});

test('a newer pinned source updates untouched managed files and remains idempotent', (t) => {
  const target = fixture(t, valid); install(target);
  const sourceProject = fixture(t, valid); install(sourceProject);
  const source = join(sourceProject, '.magician');
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  metadata.version = '1.1.0'; writeFileSync(join(source, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(source, 'cli.mjs'), readFileSync(join(source, 'cli.mjs'), 'utf8') + '\n// New pinned version.\n');
  const upgraded = install(target, { source });
  assert.equal(upgraded.version, '1.1.0');
  assert.ok(upgraded.files.some((file) => file.path === '.magician/cli.mjs' && file.action === 'updated'));
  assert.match(readFileSync(join(target, '.magician/cli.mjs'), 'utf8'), /New pinned version/);
  assert.ok(install(target, { source }).files.every((file) => file.action === 'unchanged'));
});

test('installation rejects directory links before writing outside the selected project', (t) => {
  const root = fixture(t, valid); const outside = fixture(t);
  symlinkSync(outside, join(root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => install(root), { code: 'INSTALL_CONFLICT' });
  assert.deepEqual(readdirSync(outside), []);
  assert.ok(!readdirSync(root).includes('.magician'));
});

for (const args of [['missing'], ['init', '--unknown'], ['scan', '--dry-run'], ['inventory', '--offline']]) {
  test(`invalid arguments return one JSON error without prompts: ${args.join(' ')}`, (t) => {
    const result = invoke(fixture(t), args);
    assert.equal(result.status, 2); assert.equal(result.stderr, '');
  });
}

test('missing lockfile is an inventory finding rather than a clean result', (t) => {
  const result = invoke(fixture(t, { 'package.json': {} }), ['inventory']);
  assert.equal(result.status, 1); assert.deepEqual(result.report.data.repositories[0].data.inventory.uncoveredNodeDirectories, ['.']);
});

test('missing OSV produces an explicit incomplete scan for non-Node projects', (t) => {
  const root = fixture(t, { 'composer.json': '{}', 'composer.lock': '{}' });
  const result = scan(root, { runTool: () => ({ error: new Error('not installed') }) });
  assert.equal(result.exitCode, 2); assert.equal(result.data.coverage.complete, false);
  assert.equal(result.errors[0].code, 'OSV_UNAVAILABLE');
});

test('scan continues after findings and errors, with error taking priority', (t) => {
  const root = fixture(t, { ...valid, 'api/package.json': {}, 'api/package-lock.json': '{}' });
  let calls = 0;
  const result = scan(root, { run: () => {
    calls++;
    const status = calls === 1 ? 'findings' : calls === 2 ? 'error' : 'ok';
    return { status: { ok: 0, findings: 1, error: 2 }[status], stdout: JSON.stringify({ status, error: status === 'error' ? 'registry unavailable' : undefined }) };
  } });
  assert.equal(calls, 4); assert.equal(result.exitCode, 2);
  assert.equal(result.data.checks.filter((check) => check.status === 'findings').length, 1);
  assert.equal(result.data.coverage.complete, false);
});

test('inconsistent child JSON/exit status cannot masquerade as a clean scan', (t) => {
  const result = scan(fixture(t, valid), { run: () => ({ status: 1, stdout: '{"status":"ok"}' }) });
  assert.equal(result.exitCode, 2); assert.equal(result.data.coverage.complete, false);
});

test('Windows npm shims resolve to a Node entry point without a command shell', (t) => {
  const root = fixture(t, { 'node_modules/npm/bin/npm-cli.js': '// npm entry' });
  const result = executable('npm', { platform: 'win32', node: join(root, 'node.exe'), env: { PATH: '' } });
  assert.deepEqual(result, { command: join(root, 'node.exe'), prefix: [join(root, 'node_modules/npm/bin/npm-cli.js')] });
});

test('Yarn NDJSON is parsed without losing audit/error entries', () => {
  assert.deepEqual(parseToolJson('{"type":"auditAdvisory"}\n{"type":"auditSummary"}\n'), [{ type: 'auditAdvisory' }, { type: 'auditSummary' }]);
  assert.throws(() => parseToolJson('not json'));
});
