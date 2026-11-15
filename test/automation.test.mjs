import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverProjects, dependabotConfig } from '../scripts/project-inventory.mjs';
import { auditProjects } from '../scripts/audit-projects.mjs';
import { auditCommand } from '../scripts/dependency-audit.mjs';
import { automergePolicy, enableAutomerge } from '../scripts/dependabot-policy.mjs';
import { supportedMajors } from '../scripts/node-releases.mjs';

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'rubicon-automation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('discovers mixed stacks, independent lockfiles and npm workspaces without installed dependencies', (t) => {
  const root = fixture(t, {
    'package.json': { workspaces: ['apps/*'] }, 'package-lock.json': '{}',
    'apps/web/package.json': { dependencies: { next: '^16.0.0', react: '^19.0.0' } },
    'services/api/package.json': { packageManager: 'pnpm@10.20.0', dependencies: { fastify: '^5.0.0' } },
    'services/api/pnpm-lock.yaml': '',
    'python/pyproject.toml': '[project]\ndependencies = ["fastapi==0.120.0"]', 'python/uv.lock': '',
    'php/composer.json': { require: { 'laravel/framework': '^12.0' } }, 'php/composer.lock': '{}',
    'rust/Cargo.toml': '[package]\nname = "example"', 'rust/Cargo.lock': '',
    'go/go.mod': 'module example.com/app\n', 'go/go.sum': '',
    Dockerfile: 'FROM node:24', '.github/workflows/ci.yml': 'name: CI\n',
    'node_modules/ignored/package.json': { dependencies: { react: '*' } },
    'dist/package.json': {},
  });
  const inventory = discoverProjects(root);
  assert.deepEqual(inventory.nodeAuditDirectories, ['.', 'services/api']);
  assert.deepEqual(inventory.uncoveredNodeDirectories, []);
  assert.deepEqual(inventory.projects.find((project) => project.directory === 'apps/web').stacks, ['Next.js', 'React']);
  assert.equal(inventory.projects.find((project) => project.directory === 'apps/web').auditDirectory, '.');
  assert.equal(inventory.hasOsvInputs, true);
  assert.ok(!inventory.projects.some((project) => /node_modules|dist/.test(project.directory)));
  const config = dependabotConfig(inventory);
  assert.deepEqual(config.updates.find((update) => update['package-ecosystem'] === 'npm').directories, ['/', '/services/api']);
  assert.deepEqual(config.updates.map((update) => update['package-ecosystem']), ['cargo', 'composer', 'docker', 'github-actions', 'gomod', 'npm', 'uv']);
  assert.ok(config.updates.every((update) => update.schedule.interval === 'daily' && !update.ignore));
  assert.deepEqual(discoverProjects(root), inventory);
});

test('does not follow directory links outside the repository', (t) => {
  const external = fixture(t, { 'package.json': {}, 'package-lock.json': '{}' });
  const root = fixture(t, {});
  symlinkSync(external, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(discoverProjects(root).projects, []);
});

test('recognizes a plain pnpm workspace list and honors exclusions', (t) => {
  const root = fixture(t, {
    'package.json': {}, 'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - '!apps/standalone'\n",
    'apps/web/package.json': {}, 'apps/standalone/package.json': {},
  });
  const inventory = discoverProjects(root);
  assert.equal(inventory.projects.find((project) => project.directory === 'apps/web').auditDirectory, '.');
  assert.deepEqual(inventory.uncoveredNodeDirectories, ['apps/standalone']);
});

test('does not assume unrelated nested packages belong to an ancestor lockfile', (t) => {
  const root = fixture(t, { 'package.json': {}, 'package-lock.json': '{}', 'separate/package.json': {} });
  assert.deepEqual(discoverProjects(root).uncoveredNodeDirectories, ['separate']);
});

test('does not claim coverage for pnpm workspace syntax it cannot parse', (t) => {
  const root = fixture(t, { 'package.json': {}, 'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': 'packages: ["apps/*"]\n', 'apps/web/package.json': {} });
  assert.deepEqual(discoverProjects(root).uncoveredNodeDirectories, ['apps/web']);
});

test('missing non-Node lockfiles do not produce a clean aggregate audit', (t) => {
  const root = fixture(t, { 'api/pyproject.toml': '[project]\ndependencies = ["fastapi"]', 'php/composer.json': '{}' });
  assert.equal(discoverProjects(root).errors.length, 2);
  assert.equal(auditProjects(root), 1);
});

test('generates a new Dependabot file from detected ecosystems', (t) => {
  const root = fixture(t, { 'python/pyproject.toml': '[project]', 'python/uv.lock': '' });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/project-inventory.mjs', import.meta.url)), '--write-dependabot'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const generated = readFileSync(join(root, '.github/dependabot.yml'), 'utf8');
  assert.match(generated, /package-ecosystem: "uv"/);
  assert.match(generated, /"\/python"/);
  assert.match(generated, /interval: daily/);
});

test('invalid manifest objects remain visible as inventory errors', (t) => {
  const root = fixture(t, { 'package.json': 'null', 'php/composer.json': '[]' });
  assert.equal(discoverProjects(root).errors.filter((error) => error.includes('inválido')).length, 2);
});

test('Dependabot generation refuses to overwrite existing configuration', (t) => {
  const root = fixture(t, { '.github/dependabot.yml': 'original', 'package.json': {}, 'package-lock.json': '{}' });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/project-inventory.mjs', import.meta.url)), '--write-dependabot'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(readFileSync(join(root, '.github/dependabot.yml'), 'utf8'), 'original');
});

test('audits every independent root even after a failed runtime check', (t) => {
  const root = fixture(t, { 'package.json': {}, 'package-lock.json': '{}', 'api/package.json': {}, 'api/package-lock.json': '{}' });
  const calls = [];
  const status = auditProjects(root, { offline: true, run: (command, args, options) => {
    calls.push({ command, args, options });
    return { status: calls.length === 1 ? 1 : 0 };
  } });
  assert.equal(status, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].options.cwd, join(root, 'api'));
  assert.ok(calls[0].args.includes('--repository-root'));
});

test('an uncovered Node manifest prevents a successful aggregate audit', (t) => {
  const root = fixture(t, { 'app/package.json': {} });
  assert.equal(auditProjects(root, { run: () => { throw new Error('Must not start a package manager'); } }), 1);
});

test('npm audit explicitly includes dev, optional and peer packages', () => {
  const command = auditCommand({}, ['package-lock.json']);
  for (const include of ['dev', 'optional', 'peer']) assert.ok(command.args.includes(`--include=${include}`));
  assert.ok(command.args.includes('--ignore-scripts'));
});

for (const packageManager of ['pnpm@latest', 'pnpm@10', 'pnpm@https://example.com/a.js', 'yarn@4.0', 42]) {
  test(`rejects unpinned or executable package manager declaration ${packageManager}`, () => {
    assert.throws(() => auditCommand({ packageManager }, ['pnpm-lock.yaml']), /concrete/);
  });
}
test('rejects npm manager mismatches too', () => {
  assert.throws(() => auditCommand({ packageManager: 'yarn@4.0.0' }, ['package-lock.json']), /does not match/);
});
test('audits modern Yarn workspaces and transitive packages', () => {
  assert.deepEqual(auditCommand({ packageManager: 'yarn@4.9.0' }, ['yarn.lock']).args,
    ['yarn', 'npm', 'audit', '--all', '--recursive', '--severity', 'high']);
  assert.equal(auditCommand({ packageManager: 'pnpm@10.20.0+sha512.abc123' }, ['pnpm-lock.yaml']).command, 'corepack');
});

test('Node support follows release dates, including future EOL transitions', () => {
  const schedule = { v22: { start: '2024-04-24', end: '2027-04-30' }, v24: { start: '2025-05-06', end: '2028-04-30' }, v28: { start: '2027-05-01', end: '2030-04-30' } };
  assert.deepEqual([...supportedMajors(schedule, '2026-11-15')], [22, 24]);
  assert.deepEqual([...supportedMajors(schedule, '2027-05-02')], [24, 28]);
  assert.throws(() => supportedMajors({}, '2026-11-15'), /no supported branches/);
});

function eligibleInput() {
  return {
    repository: { full_name: 'example/app', default_branch: 'main', allow_auto_merge: true },
    pr: { number: 7, user: { login: 'dependabot[bot]', type: 'Bot' }, state: 'open', draft: false, changed_files: 2,
      head: { sha: 'abc123', repo: { full_name: 'example/app' } }, base: { ref: 'main', repo: { full_name: 'example/app' } } },
    expectedHead: 'abc123', updateType: 'version-update:semver-patch',
    files: [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
    configuredChecks: ['Rubicon security', 'Application tests'],
    branch: { protected: true, protection: { required_status_checks: { enforcement_level: 'all', contexts: ['Rubicon security', 'Application tests'] } } },
  };
}

for (const type of ['patch', 'minor']) {
  test(`allows verified ${type} with enforced security and application checks`, () => {
    const input = eligibleInput(); input.updateType = `version-update:semver-${type}`;
    assert.equal(automergePolicy(input).eligible, true);
  });
}
for (const [name, mutate] of [
  ['major update', (x) => { x.updateType = 'version-update:semver-major'; }],
  ['unknown update', (x) => { x.updateType = ''; }],
  ['human author', (x) => { x.pr.user = { login: 'someone', type: 'User' }; }],
  ['fork', (x) => { x.pr.head.repo.full_name = 'someone/app'; }],
  ['non-default base', (x) => { x.pr.base.ref = 'other'; }],
  ['draft', (x) => { x.pr.draft = true; }],
  ['closed PR', (x) => { x.pr.state = 'closed'; }],
  ['stale head', (x) => { x.pr.head.sha = 'new-commit'; }],
  ['source code change', (x) => { x.files[0].filename = 'src/app.js'; }],
  ['workflow change', (x) => { x.files[0].filename = '.github/workflows/ci.yml'; }],
  ['runtime change', (x) => { x.files[0].filename = '.nvmrc'; }],
  ['renamed source file', (x) => { x.files[0].previous_filename = 'src/app.js'; }],
  ['incomplete file list', (x) => { x.pr.changed_files = 3; }],
  ['disabled auto-merge', (x) => { x.repository.allow_auto_merge = false; }],
  ['unconfigured checks', (x) => { x.configuredChecks = []; }],
  ['duplicate checks', (x) => { x.configuredChecks = ['Rubicon security', 'Rubicon security']; }],
  ['unprotected branch', (x) => { x.branch.protected = false; }],
  ['missing application check', (x) => { x.branch.protection.required_status_checks.contexts = ['Rubicon security']; }],
  ['unenforced protection', (x) => { x.branch.protection.required_status_checks.enforcement_level = 'off'; }],
]) {
  test(`does not auto-merge ${name}`, () => { const input = eligibleInput(); mutate(input); assert.equal(automergePolicy(input).eligible, false); });
}

test('recognizes active ruleset required checks as well as classic protection', () => {
  const input = eligibleInput(); input.branch = { protected: true };
  input.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: input.configuredChecks.map((context) => ({ context })) } }];
  assert.equal(automergePolicy(input).eligible, true);
});

test('GitHub API failure prevents the merge request', async () => {
  let merged = false;
  await assert.rejects(enableAutomerge({ event: { pull_request: eligibleInput().pr }, repositoryName: 'example/app',
    api: async () => { throw new Error('HTTP 403'); }, merge: () => { merged = true; } }), /HTTP 403/);
  assert.equal(merged, false);
});

test('manual-only updates skip protection API calls and never request a merge', async () => {
  const input = eligibleInput(); input.files[0].filename = '.github/workflows/ci.yml';
  const decision = await enableAutomerge({ event: { pull_request: input.pr }, repositoryName: 'example/app',
    updateType: input.updateType, configuredChecks: input.configuredChecks,
    api: async (path) => {
      if (path.includes('/files?')) return input.files;
      if (path.includes('/pulls/')) return input.pr;
      assert.equal(path, '/repos/example/app');
      return input.repository;
    }, merge: () => { throw new Error('Must not merge'); },
  });
  assert.equal(decision.eligible, false);
  assert.match(decision.reason, /allowlist/);
});

test('queues an exact head once all server-side policy inputs are validated', async () => {
  const input = eligibleInput(); const merges = [];
  const result = await enableAutomerge({
    event: { pull_request: input.pr }, repositoryName: input.repository.full_name,
    updateType: input.updateType, configuredChecks: input.configuredChecks,
    api: async (path) => {
      if (path.includes('/files?')) return input.files;
      if (path.includes('/rules/')) return [];
      if (path.includes('/branches/')) return input.branch;
      if (path.includes('/pulls/')) return input.pr;
      return input.repository;
    },
    merge: (number, sha) => { merges.push({ number, sha }); },
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(merges, [{ number: 7, sha: 'abc123' }]);
});
