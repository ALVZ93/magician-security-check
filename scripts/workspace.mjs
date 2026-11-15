import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ignoredDirectories } from './project-inventory.mjs';

const manifests = ['package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'composer.json', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts'];
export const isProject = (root) => existsSync(join(root, '.git')) || manifests.some((name) => existsSync(join(root, name)));

export function projectScope(root, scope = 'auto') {
  if (!['auto', 'project', 'workspace'].includes(scope)) throw new Error('--scope must be auto, project or workspace.');
  if (scope === 'project' || (scope === 'auto' && isProject(root))) return { scope: 'project', roots: [root] };
  const roots = [];
  const errors = [];
  function visit(directory) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { errors.push({ code: 'WORKSPACE_UNREADABLE', message: error.message, repository: directory }); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (isProject(path)) roots.push(path);
      else visit(path);
    }
  }
  visit(root);
  if (!roots.length && !errors.length && scope === 'auto') return { scope: 'project', roots: [root] };
  if (!roots.length && !errors.length) throw new Error('No repositories/projects found in the workspace.');
  return { scope: 'workspace', roots, errors };
}

export function collectProjects(root, scope, operation) {
  const selected = projectScope(root, scope);
  const repositories = selected.roots.map((path) => {
    let result;
    try { result = operation(path); }
    catch (error) { result = { exitCode: 2, errors: [{ code: error.code ?? 'PROJECT_ERROR', message: error.message }], warnings: [], data: {} }; }
    return { name: basename(path), root: path, relativePath: relative(root, path) || '.', status: ['ok', 'findings', 'error'][result.exitCode], ...result };
  });
  const errors = [...(selected.errors ?? []), ...repositories.flatMap((repo) => repo.errors.map((error) => ({ ...error, repository: repo.root })))];
  const warnings = repositories.flatMap((repo) => repo.warnings.map((warning) => ({ ...warning, repository: repo.root })));
  return { exitCode: errors.length || repositories.some((repo) => repo.exitCode === 2) ? 2 : repositories.some((repo) => repo.exitCode === 1) ? 1 : 0,
    errors, warnings, data: { scope: selected.scope, repositories,
      summary: { total: repositories.length, ok: repositories.filter((repo) => repo.exitCode === 0).length,
        findings: repositories.filter((repo) => repo.exitCode === 1).length, errors: repositories.filter((repo) => repo.exitCode === 2).length } } };
}
