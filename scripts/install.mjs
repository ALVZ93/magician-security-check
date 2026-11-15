import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependabotYaml, discoverProjects } from './project-inventory.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
// Git may convert LF/CRLF on checkout; that is not a user modification.
const hash = (content) => createHash('sha256').update(content.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
const section = '<!-- magician:start -->\n## Magician Security Check\n\nRead [MAGICIAN.md](MAGICIAN.md) before security/dependency work.\nRun commands from the directory containing this AGENTS.md; select another project with --root.\nRun `node .magician/cli.mjs scan --json` for an actionable report (single repo or workspace).\nUse `node .magician/cli.mjs update --json` to plan security fixes; --apply explicitly permits compatible npm lockfile changes.\nExit codes: 0 = clean, 1 = findings, 2 = error/incomplete coverage.\nNever treat exit 2 as a clean scan or bypass required checks.\n<!-- magician:end -->';

function conflict(message, paths = []) {
  return Object.assign(new Error(message), { code: 'INSTALL_CONFLICT', paths });
}

function safePath(root, path) {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw conflict(`Destination escapes project: ${path}`, [path]);
  let current = root;
  for (const part of local.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw conflict(`Refusing symlink destination: ${path}`, [path]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}

function atomicWrite(root, path, content) {
  const target = safePath(root, path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function install(root, { dryRun = false, automerge = false, workspace = false, source = packageRoot } = {}) {
  root = realpathSync(root);
  const manifestPath = '.magician/install-manifest.json';
  const previousPath = safePath(root, manifestPath);
  let previous = { files: {} };
  if (existsSync(previousPath)) {
    previous = JSON.parse(readFileSync(previousPath, 'utf8'));
    if (previous.schemaVersion !== 1 || !previous.files || typeof previous.files !== 'object' || Array.isArray(previous.files)) throw conflict('Unknown installation manifest; review it before reinstalling.', [manifestPath]);
  }
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  const files = new Map();
  for (const path of ['cli.mjs', 'package.json', 'docs/agents.md', 'docs/agent-report.schema.json',
    ...readdirSync(join(source, 'scripts')).filter((name) => name.endsWith('.mjs')).map((name) => `scripts/${name}`),
    ...readdirSync(join(source, 'examples')).filter((name) => name.endsWith('.example')).map((name) => `examples/${name}`)]) {
    files.set(`.magician/${path}`, readFileSync(join(source, path)));
  }
  const scanTemplate = readFileSync(join(source, 'examples/node-security.yml.example'), 'utf8');
  if (!workspace) files.set('.github/workflows/node-security.yml', Buffer.from(scanTemplate.replaceAll('node scripts/', 'node .magician/scripts/')));
  if (!workspace && automerge) files.set('.github/workflows/dependabot-automerge.yml', Buffer.from(
    readFileSync(join(source, 'examples/dependabot-automerge.yml.example'), 'utf8').replaceAll('node scripts/', 'node .magician/scripts/')));
  files.set('MAGICIAN.md', readFileSync(join(source, 'docs/agents.md')));

  const warnings = [];
  const inventory = workspace ? { projects: [] } : discoverProjects(root);
  const yaml = Buffer.from(dependabotYaml(inventory));
  const dependabot = '.github/dependabot.yml';
  const dependabotPath = workspace ? null : safePath(root, dependabot);
  if (workspace) {
    warnings.push({ code: 'WORKSPACE_INSTALL', message: 'Installed the CLI at the workspace root. Run init inside each repository to install its GitHub workflows.' });
  } else if (existsSync(dependabotPath) && !previous.files[dependabot] && hash(readFileSync(dependabotPath)) !== hash(yaml)) {
    files.set('.github/dependabot.magician.yml', yaml);
    warnings.push({ code: 'DEPENDABOT_MERGE_REQUIRED', message: 'Merge .github/dependabot.magician.yml into .github/dependabot.yml, preserving existing settings and registries.' });
  } else files.set(dependabot, yaml);

  const agentsPath = safePath(root, 'AGENTS.md');
  const originalAgents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  if (originalAgents.includes('<!-- magician:')) {
    if (!originalAgents.replaceAll('\r\n', '\n').includes(section)) throw conflict('The Magician section in AGENTS.md was modified; review it before reinstalling.', ['AGENTS.md']);
  } else files.set('AGENTS.md', Buffer.from(`${originalAgents}${originalAgents ? (originalAgents.endsWith('\n') ? '\n' : '\n\n') : ''}${section}\n`));

  const changes = [];
  const hashes = { ...previous.files };
  const conflicts = [];
  for (const [path, content] of files) {
    const target = safePath(root, path);
    const current = existsSync(target) ? readFileSync(target) : null;
    const identical = current && hash(current) === hash(content);
    const adoptedTemplate = path === '.github/workflows/node-security.yml' && current && hash(current) === hash(Buffer.from(scanTemplate));
    // AGENTS.md is an append-only integration; all existing instructions survive.
    if (current && !identical && path !== 'AGENTS.md' && !adoptedTemplate && previous.files[path] !== hash(current)) conflicts.push(path);
    changes.push({ path, action: identical ? 'unchanged' : current ? 'updated' : 'created' });
    if (path !== 'AGENTS.md') hashes[path] = hash(content);
  }
  if (conflicts.length) throw conflict('Existing files were not overwritten. Review the conflicting paths.', conflicts);
  const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, hashAlgorithm: 'sha256-lf', version, files: hashes }, null, 2)}\n`);
  const manifestUnchanged = existsSync(previousPath) && hash(readFileSync(previousPath)) === hash(manifest);
  changes.push({ path: manifestPath, action: manifestUnchanged ? 'unchanged' : existsSync(previousPath) ? 'updated' : 'created' });
  if (!dryRun) {
    for (const change of changes) {
      if (change.action !== 'unchanged') atomicWrite(root, change.path, change.path === manifestPath ? manifest : files.get(change.path));
    }
  }
  return { version, dryRun, files: changes, warnings, nextActions: [
    ...warnings.map((warning) => warning.message),
    'Run node .magician/cli.mjs doctor --json, then node .magician/cli.mjs scan --json.',
    ...(workspace ? ['Use --root <repository> with init to install CI in selected repositories.'] : ['Commit the installed files and enable Dependabot alerts/security updates in GitHub.']),
    ...(!workspace && automerge ? ['Enable squash/auto-merge and require security + application checks on GitHub; set RUBICON_REQUIRED_CHECKS. See MAGICIAN.md.'] : []),
  ] };
}
