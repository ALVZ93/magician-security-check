import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { scan } from './agent-scan.mjs';
import { parseToolJson, runCommand } from './process-utils.mjs';

function dependencyVersions(lock) {
  const versions = new Map();
  if (!lock) return versions;
  const parsed = JSON.parse(lock.toString());
  if (parsed.packages) for (const [path, pkg] of Object.entries(parsed.packages)) {
    if (path && pkg.version) versions.set(path, pkg.version);
  }
  else {
    const visit = (dependencies, prefix = '') => {
      for (const [name, dependency] of Object.entries(dependencies ?? {})) {
        const path = `${prefix}node_modules/${name}`;
        if (dependency.version) versions.set(path, dependency.version);
        visit(dependency.dependencies, `${path}/`);
      }
    };
    visit(parsed.dependencies);
  }
  return versions;
}

export function incompatibleUpdates(before, after) {
  const previous = dependencyVersions(before), current = dependencyVersions(after);
  const changes = [];
  for (const [name, version] of previous) {
    const next = current.get(name);
    if (!next || next === version) continue;
    const oldRelease = version.match(/^(\d+)\.\d+\.\d+$/), newRelease = next.match(/^(\d+)\.\d+\.\d+$/);
    if (!oldRelease || !newRelease || oldRelease[1] !== newRelease[1]) changes.push({ name, from: version, to: next });
  }
  // Hoisting may move a dependency; a new path must not hide a new major.
  const packageName = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  for (const [path, version] of current) {
    if (previous.has(path)) continue;
    const known = [...previous].filter(([oldPath]) => packageName(oldPath) === packageName(path)).map(([, value]) => value);
    if (!known.length) continue;
    const next = version.match(/^(\d+)\.\d+\.\d+$/);
    if (!next || !known.some((value) => value.match(/^(\d+)\.\d+\.\d+$/)?.[1] === next[1])) changes.push({ name: path, from: known.join(', '), to: version });
  }
  return changes;
}

export function planUpdates(audit) {
  const actions = [];
  for (const check of audit.data.checks) {
    if (check.status !== 'findings') continue;
    if (check.id === 'dependencies' && check.report.manager === 'npm') {
      const vulnerabilities = Object.entries(check.report.report?.vulnerabilities ?? {}).filter(([, value]) => ['high', 'critical'].includes(value.severity));
      const compatible = vulnerabilities.filter(([, value]) => value.fixAvailable && value.fixAvailable.isSemVerMajor !== true);
      if (compatible.length) actions.push({ type: 'npm-audit-fix', directory: check.directory, automatic: true,
        packages: compatible.map(([name]) => name), command: 'npm', args: ['audit', 'fix', '--package-lock-only', '--ignore-scripts', '--no-fund', '--audit-level=high', '--json'] });
      const manual = vulnerabilities.filter(([, value]) => !value.fixAvailable || value.fixAvailable.isSemVerMajor === true);
      if (manual.length) actions.push({ type: 'review', directory: check.directory, automatic: false, packages: manual.map(([name]) => name), reason: 'No compatible automatic fix; review the advisory or required major upgrade.' });
      if (!vulnerabilities.length) actions.push({ type: 'review', directory: check.directory, automatic: false, reason: 'Review the package-manager report before changing dependencies.' });
    } else actions.push({ type: 'review', directory: check.directory ?? '.', automatic: false,
      reason: check.id === 'runtime' ? 'Runtime declarations/deployment need review; no automatic major migration.' : 'Use the advisory report and Dependabot security PRs or a reviewed ecosystem-specific update.' });
  }
  return actions;
}

export function update(root, { apply = false, offline = false, audit = scan, runTool = runCommand } = {}) {
  const initial = audit(root, { offline });
  const actions = planUpdates(initial);
  const data = { ...initial.data, apply, actions, changedFiles: [], applied: false, tests: 'not-run',
    nextActions: actions.some((action) => !action.automatic) ? ['Review manual actions against their advisories; use guarded Dependabot PRs for other ecosystems.'] : [] };
  if (!apply || initial.exitCode === 2 || !actions.some((action) => action.automatic)) return { ...initial, data };
  let lockPath, descriptor;
  const token = randomUUID();
  const snapshots = new Map();
  const bytes = (path) => existsSync(path) ? readFileSync(path) : null;
  const changed = () => [...snapshots].filter(([path, original]) => {
    const current = bytes(path);
    return original === null ? current !== null : !current?.equals(original);
  }).map(([path]) => path);
  const restore = () => {
    for (const path of changed()) {
      const original = snapshots.get(path);
      if (original === null) unlinkSync(path); else writeFileSync(path, original);
    }
  };
  try {
    const state = runTool('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    if (state.error || state.status !== 0) throw Object.assign(new Error('Applying updates requires a Git repository.'), { code: 'GIT_REQUIRED' });
    if (state.stdout.trim()) throw Object.assign(new Error('The repository has local changes. Commit/review them before applying updates.'), { code: 'DIRTY_WORKTREE' });
    const gitPath = runTool('git', ['rev-parse', '--git-path', 'magician-security-check.lock'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    if (gitPath.error || gitPath.status !== 0 || !gitPath.stdout.trim()) throw new Error('Cannot resolve the repository update lock.');
    lockPath = resolve(root, gitPath.stdout.trim());
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
    for (const action of actions.filter((item) => item.automatic)) {
      const directory = resolve(root, action.directory);
      const paths = [join(directory, 'package.json'), join(directory, 'package-lock.json'), join(directory, 'npm-shrinkwrap.json'),
        ...initial.data.inventory.projects.filter((project) => project.ecosystem === 'npm' && project.auditDirectory === action.directory)
          .map((project) => join(root, project.directory, 'package.json'))];
      for (const path of paths) {
        try {
          const entry = lstatSync(path);
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsafe manifest/lockfile: ${path}`);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!snapshots.has(path)) snapshots.set(path, bytes(path));
      }
    }
    for (const action of actions.filter((item) => item.automatic)) {
      const result = runTool(action.command, action.args, { cwd: resolve(root, action.directory), encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'development', npm_config_ignore_scripts: 'true' } });
      if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error(`npm audit fix failed: ${result.error?.message ?? result.stderr ?? result.status}`);
      const report = parseToolJson(result.stdout);
      if (!report || Array.isArray(report) || report.error) throw new Error(`npm audit fix returned an invalid/error report: ${JSON.stringify(report)}`);
    }
    const unsafe = [];
    for (const [path, original] of snapshots) {
      const current = bytes(path);
      if (path.endsWith('package.json') && !current?.equals(original)) unsafe.push({ path, reason: 'Manifest changes require review.' });
      else if (original && current) for (const change of incompatibleUpdates(original, current)) unsafe.push({ path, ...change });
    }
    if (unsafe.length) {
      restore();
      return { ...initial, warnings: [...initial.warnings, { code: 'UPDATE_REQUIRES_REVIEW', message: 'Restored changes that alter manifests, major versions or prerelease versions.' }],
        data: { ...data, rolledBack: true, review: unsafe } };
    }
    const verified = audit(root, { offline });
    if (verified.exitCode === 2) throw new Error(`Post-update auditing failed; restoring dependency files. ${JSON.stringify(verified.errors)}`);
    data.changedFiles = changed().map((path) => relative(root, path));
    data.applied = data.changedFiles.length > 0;
    data.nextActions.push('Review git diff and run the application tests/build before committing, pushing or merging.');
    return { ...verified, data: { ...verified.data, ...data, checks: verified.data.checks } };
  } catch (error) {
    let restoreError;
    try { restore(); } catch (failure) { restoreError = failure.message; }
    return { exitCode: 2, warnings: initial.warnings,
      errors: [...initial.errors, { code: restoreError ? 'RESTORE_FAILED' : error.code === 'EEXIST' ? 'UPDATE_LOCKED' : error.code ?? 'UPDATE_FAILED',
        message: `${error.message}${restoreError ? ` Restore failed: ${restoreError}` : ''}` }],
      data: { ...data, rolledBack: snapshots.size > 0 && !restoreError } };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      if (existsSync(lockPath) && JSON.parse(readFileSync(lockPath, 'utf8')).token === token) unlinkSync(lockPath);
    }
  }
}
