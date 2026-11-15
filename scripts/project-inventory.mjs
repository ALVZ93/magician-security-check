#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ignored = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv',
  '.yarn', '.pnpm-store', '__pycache__', '.next', '.nuxt', '.astro', '.svelte-kit',
  'dist', 'build', 'coverage', 'target', 'bin', 'obj', '.rubicon-osv-fixture']);
const nodeLocks = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
const stackPackages = {
  next: 'Next.js', astro: 'Astro', react: 'React', vue: 'Vue', nuxt: 'Nuxt',
  '@angular/core': 'Angular', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit',
  express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS', hono: 'Hono',
  vite: 'Vite', typescript: 'TypeScript', '@supabase/supabase-js': 'Supabase client',
  prisma: 'Prisma', 'drizzle-orm': 'Drizzle', electron: 'Electron',
};
const slash = (path) => path.split('\\').join('/');
const text = (path) => readFileSync(path, 'utf8');

function workspacePatterns(directory, pkg) {
  const configured = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  const pnpm = join(directory, 'pnpm-workspace.yaml');
  if (!existsSync(pnpm)) return Array.isArray(configured) ? configured.filter((value) => typeof value === 'string') : [];
  // Only accept a plain YAML packages list; ambiguous syntax stays uncovered.
  const block = text(pnpm).match(/^packages:\s*\r?\n((?:[ \t]+[^\n]*\r?\n?|\s*\r?\n)*)/m)?.[1];
  if (!block) return [];
  const patterns = [];
  for (const line of block.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'))) {
    const value = line.match(/^\s+-\s+(?:'([^']+)'|"([^"\\]+)"|([^\s#\[\]{}&*][^#]*?))\s*(?:#.*)?$/);
    if (!value) return [];
    patterns.push((value[1] ?? value[2] ?? value[3]).trim());
  }
  return patterns;
}

export function discoverProjects(root = process.cwd()) {
  root = resolve(root);
  const projects = [];
  const warnings = [];
  const errors = [];
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const location = slash(relative(root, directory)) || '.';
    const add = (ecosystem, manager, manifests, lockfiles, stacks = []) => {
      projects.push({ directory: location, ecosystem, manager, manifests, lockfiles, stacks });
      return projects.at(-1);
    };
    if (names.includes('package.json')) {
      let pkg = {};
      try {
        pkg = JSON.parse(text(join(directory, 'package.json')));
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Expected an object');
      }
      catch { pkg = {}; errors.push(`${location}: package.json inválido.`); }
      const locks = nodeLocks.filter((lock) => names.includes(lock));
      const manager = locks.includes('pnpm-lock.yaml') ? 'pnpm' : locks.includes('yarn.lock') ? 'yarn' : 'npm';
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
      const stacks = Object.keys(stackPackages).filter((name) => Object.hasOwn(dependencies, name)).map((name) => stackPackages[name]);
      const project = add('npm', manager, ['package.json'], locks, stacks.length ? stacks : ['Node.js']);
      project.workspacePatterns = workspacePatterns(directory, pkg);
    }
    else if (nodeLocks.some((lock) => names.includes(lock))) errors.push(`${location}: lockfile Node sin package.json.`);
    const python = names.filter((name) => /^(?:pyproject\.toml|Pipfile|requirements(?:[.-][\w.-]+)?\.txt)$/.test(name));
    if (python.length) {
      const uv = names.includes('uv.lock');
      const source = python.map((name) => text(join(directory, name))).join('\n');
      const stacks = ['Django', 'Flask', 'FastAPI'].filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(source));
      add(uv ? 'uv' : 'pip', uv ? 'uv' : names.includes('poetry.lock') ? 'poetry' : 'pip', python,
        names.filter((name) => /^(?:uv\.lock|poetry\.lock|Pipfile\.lock|requirements(?:[.-][\w.-]+)?\.txt)$/.test(name)), stacks.length ? stacks : ['Python']);
    }
    if (names.includes('composer.json')) {
      let pkg = {};
      try {
        pkg = JSON.parse(text(join(directory, 'composer.json')));
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Expected an object');
      }
      catch { pkg = {}; errors.push(`${location}: composer.json inválido.`); }
      const dependencies = { ...pkg.require, ...pkg['require-dev'] };
      const stacks = [['laravel/framework', 'Laravel'], ['symfony/framework-bundle', 'Symfony']]
        .filter(([name]) => Object.hasOwn(dependencies, name)).map(([, stack]) => stack);
      add('composer', 'composer', ['composer.json'], names.filter((name) => name === 'composer.lock'), stacks.length ? stacks : ['PHP']);
    }
    for (const [manifest, ecosystem, manager, locks, stack] of [
      ['go.mod', 'gomod', 'go', ['go.sum'], 'Go'],
      ['Cargo.toml', 'cargo', 'cargo', ['Cargo.lock'], 'Rust'],
      ['Gemfile', 'bundler', 'bundler', ['Gemfile.lock'], 'Ruby'],
      ['pom.xml', 'maven', 'maven', [], 'Java / Maven'],
      ['build.gradle', 'gradle', 'gradle', ['gradle.lockfile'], 'Java / Gradle'],
      ['build.gradle.kts', 'gradle', 'gradle', ['gradle.lockfile'], 'Kotlin / Gradle'],
    ]) {
      if (names.includes(manifest)) add(ecosystem, manager, [manifest], locks.filter((lock) => names.includes(lock)), [stack]);
    }
    const docker = names.filter((name) => /^Dockerfile(?:\..+)?$/.test(name));
    if (docker.length) add('docker', 'docker', docker, [], ['Docker']);
    for (const entry of entries) {
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(join(directory, entry.name));
    }
  }
  visit(root);
  const nodes = projects.filter((project) => project.ecosystem === 'npm');
  for (const project of nodes) {
    if (project.lockfiles.length) { project.auditDirectory = project.directory; continue; }
    const owners = nodes.filter((candidate) => {
      if (!candidate.lockfiles.length || candidate === project) return false;
      const path = posix.relative(candidate.directory, project.directory);
      if (path.startsWith('../') || path === '..') return false;
      const patterns = candidate.workspacePatterns;
      return patterns.some((pattern) => !pattern.startsWith('!') && posix.matchesGlob(path, pattern.replace(/^\.\//, '')))
        && !patterns.some((pattern) => pattern.startsWith('!') && posix.matchesGlob(path, pattern.slice(1)));
    }).sort((a, b) => b.directory.length - a.directory.length);
    project.auditDirectory = owners[0]?.directory ?? null;
    if (project.auditDirectory === null) warnings.push(`${project.directory}: manifiesto Node sin lockfile propio ni workspace verificable.`);
  }
  for (const project of nodes) delete project.workspacePatterns;
  const uncoveredDependencyProjects = projects.filter((project) => !['npm', 'docker', 'gomod', 'maven'].includes(project.ecosystem) && !project.lockfiles.length);
  for (const project of uncoveredDependencyProjects) errors.push(`${project.directory}: ${project.manager} sin lockfile/artefacto auditable por OSV; cobertura no verificada.`);
  const hasActions = existsSync(join(root, '.github', 'workflows'));
  if (hasActions) projects.push({ directory: '.', ecosystem: 'github-actions', manager: 'github-actions', manifests: ['.github/workflows'], lockfiles: [], stacks: ['GitHub Actions'] });
  return {
    projects,
    nodeAuditDirectories: nodes.filter((project) => project.lockfiles.length).map((project) => project.directory),
    uncoveredNodeDirectories: nodes.filter((project) => project.auditDirectory === null).map((project) => project.directory),
    hasOsvInputs: projects.some((project) => project.lockfiles.length || project.ecosystem === 'gomod' || project.ecosystem === 'maven'),
    warnings,
    errors,
  };
}

export function dependabotConfig(inventory) {
  const ecosystems = new Map([['github-actions', new Set(['/'])]]);
  for (const project of inventory.projects) {
    if (!ecosystems.has(project.ecosystem)) ecosystems.set(project.ecosystem, new Set());
    // Workspace manifests are managed from their lockfile root.
    const directory = project.ecosystem === 'npm' ? project.auditDirectory ?? project.directory : project.directory;
    ecosystems.get(project.ecosystem).add(directory === '.' ? '/' : `/${directory}`);
  }
  return {
    version: 2,
    updates: [...ecosystems].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([ecosystem, directories]) => ({
      'package-ecosystem': ecosystem,
      directories: [...directories].sort(),
      schedule: { interval: 'daily' },
      'open-pull-requests-limit': 10,
      groups: {
        'compatible-updates': { 'applies-to': 'version-updates', patterns: ['*'], 'update-types': ['minor', 'patch'] },
        'security-updates': { 'applies-to': 'security-updates', patterns: ['*'], 'update-types': ['minor', 'patch'] },
      },
    })),
  };
}

export function dependabotYaml(inventory) {
  const lines = ['# Generated by Rubicon; merge with existing registry/settings configuration.', 'version: 2', 'updates:'];
  for (const update of dependabotConfig(inventory).updates) {
    lines.push(`  - package-ecosystem: ${JSON.stringify(update['package-ecosystem'])}`, '    directories:');
    for (const directory of update.directories) lines.push(`      - ${JSON.stringify(directory)}`);
    lines.push('    schedule:', '      interval: daily', '    open-pull-requests-limit: 10', '    groups:');
    for (const [name, group] of Object.entries(update.groups)) {
      lines.push(`      ${name}:`, `        applies-to: ${group['applies-to']}`, '        patterns: ["*"]', '        update-types: [minor, patch]');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function inventorySummary(inventory) {
  const escape = (value) => String(value).replace(/[<>|`\r\n]/g, ' ');
  return ['## Rubicon: inventario de proyectos', '', '| Directorio | Gestor | Stack | Lockfiles |', '| --- | --- | --- | --- |',
    ...inventory.projects.map((project) => `| ${escape(project.directory)} | ${project.manager} | ${project.stacks.join(', ')} | ${project.lockfiles.join(', ') || 'sin lockfile'} |`),
    '', ...inventory.warnings.map((warning) => `- ⚠️ ${escape(warning)}`),
    ...inventory.errors.map((error) => `- ❌ ${escape(error)}`),
    '', 'Las etiquetas de stack son informativas. La auditoría no se limita a esos paquetes.', ''].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const inventory = discoverProjects();
    if (process.argv.includes('--write-dependabot')) {
      const target = resolve('.github/dependabot.yml');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, dependabotYaml(inventory), { flag: 'wx' });
      console.log('Created .github/dependabot.yml');
    } else if (process.argv.includes('--dependabot')) console.log(dependabotYaml(inventory));
    else if (process.argv.includes('--json')) console.log(JSON.stringify(inventory, null, 2));
    else console.log(inventorySummary(inventory));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, inventorySummary(inventory));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `has-osv-inputs=${inventory.hasOsvInputs}\n`);
    if (inventory.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(`Inventory failed: ${error.message}`);
    process.exitCode = 1;
  }
}
