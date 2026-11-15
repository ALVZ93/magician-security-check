#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { install } from './scripts/install.mjs';
import { doctor, scan } from './scripts/agent-scan.mjs';
import { discoverProjects, inventorySummary } from './scripts/project-inventory.mjs';
import { collectProjects, projectScope } from './scripts/workspace.mjs';
import { update } from './scripts/update.mjs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const help = `Magician Security Check ${version}

Usage: magician-security-check <command> [--root <directory>] [--scope auto|project|workspace] [--json]

  init        Install local CLI, CI, Dependabot and agent instructions
              --dry-run: plan without writing; --automerge: include guarded auto-merge
  inventory   Discover stacks, manifests and lockfiles without network access
  matrix      Show the repository/project matrix (also works on one repository)
  doctor      Check project configuration and required local tools
  scan        Check runtime and dependencies; other ecosystems require OSV-Scanner
              --offline: skip runtime network lookups only
  update      Plan security fixes; --apply updates compatible npm lockfiles
              Git must be clean; no install scripts, force, commit or push

  --help      Show help
  --version   Show the pinned version

JSON stdout: one schemaVersion=1 document; no interactive prompts.
Exit codes: 0=ok, 1=findings, 2=error/incomplete coverage.
Installed command: node .magician/cli.mjs scan --json
`;

export function execute(args = process.argv.slice(2)) {
  const json = args.includes('--json');
  let command = args.find((value) => !value.startsWith('-')) ?? 'help';
  let root = process.cwd();
  try {
    const parsed = parseArgs({ args, allowPositionals: true, options: {
      root: { type: 'string' }, json: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
      automerge: { type: 'boolean' }, offline: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
      scope: { type: 'string' }, apply: { type: 'boolean' },
    } });
    command = parsed.values.help ? 'help' : parsed.values.version ? 'version' : parsed.positionals[0] ?? 'help';
    root = resolve(parsed.values.root ?? process.cwd());
    if (Number(process.versions.node.split('.')[0]) < 22) throw Object.assign(new Error('Node 22 or newer is required.'), { code: 'NODE_VERSION_UNSUPPORTED' });
    if (parsed.positionals.length > 1 || !['init', 'inventory', 'matrix', 'doctor', 'scan', 'update', 'help', 'version'].includes(command)) throw new Error('Unknown command or unexpected positional argument. Use --help.');
    if (parsed.values['dry-run'] && !['init', 'update'].includes(command)) throw new Error('--dry-run only applies to init or update.');
    if (parsed.values.automerge && command !== 'init') throw new Error('--automerge only applies to init.');
    if (parsed.values.apply && (command !== 'update' || parsed.values['dry-run'])) throw new Error('--apply only applies to update and cannot be combined with --dry-run.');
    if (parsed.values.offline && !['scan', 'update'].includes(command)) throw new Error('--offline only applies to scan or update. Inventory and doctor do not query registries.');
    let result = { exitCode: 0, errors: [], warnings: [], data: {} };
    if (command === 'help') result.data = { version, help };
    else if (command === 'version') result.data = { version };
    else {
      root = realpathSync(root);
      if (!statSync(root).isDirectory()) throw new Error('--root must be a directory.');
      if (command === 'init') {
        const selected = projectScope(root, parsed.values.scope);
        const installed = install(root, { dryRun: parsed.values['dry-run'], automerge: parsed.values.automerge, workspace: selected.scope === 'workspace' });
        result.data = { version: installed.version, dryRun: installed.dryRun, files: installed.files, nextActions: installed.nextActions };
        result.warnings = installed.warnings;
      } else result = collectProjects(root, parsed.values.scope, (project) => {
        if (['inventory', 'matrix'].includes(command)) {
          const inventory = discoverProjects(project);
          return { exitCode: inventory.errors.length || inventory.uncoveredNodeDirectories.length ? 1 : 0, errors: [],
            warnings: inventory.warnings.map((message) => ({ code: 'INVENTORY_WARNING', message })), data: { inventory } };
        }
        if (command === 'doctor') return doctor(project);
        if (command === 'update') return update(project, { apply: parsed.values.apply, offline: parsed.values.offline });
        return scan(project, { offline: parsed.values.offline });
      });
    }
    return { json, report: { schemaVersion: 1, command, status: result.exitCode === 2 ? 'error' : result.exitCode === 1 ? 'findings' : 'ok', root, ...result } };
  } catch (error) {
    return { json, report: { schemaVersion: 1, command, status: 'error', exitCode: 2, root, data: {}, warnings: [],
      errors: [{ code: error.code ?? 'COMMAND_FAILED', message: error.message, ...(error.paths ? { paths: error.paths } : {}) }] } };
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { json, report } = execute();
  if (json) console.log(JSON.stringify(report));
  else if (report.command === 'help' && report.status === 'ok') process.stdout.write(help);
  else if (report.command === 'version' && report.status === 'ok') console.log(version);
  else {
    console.log(`Magician ${version} · ${report.command}: ${report.status}`);
    if (report.data.repositories) {
      console.log('Repository                       Status      Projects   Planned updates');
      for (const repo of report.data.repositories) console.log(`${repo.relativePath.padEnd(32)} ${repo.status.padEnd(11)} ${String(repo.data.inventory?.projects.length ?? '-').padEnd(10)} ${repo.data.actions?.length ?? '-'}`);
      if (report.data.scope === 'project' && ['inventory', 'matrix'].includes(report.command)) console.log(inventorySummary(report.data.repositories[0].data.inventory));
      for (const repo of report.data.repositories) {
        for (const check of repo.data.checks ?? []) {
          if (check.status !== 'findings') continue;
          for (const failure of check.report?.failures ?? [check.message].filter(Boolean)) console.log(`Finding (${repo.relativePath}): ${failure}`);
          const vulnerable = Object.entries(check.report?.report?.vulnerabilities ?? {}).filter(([, value]) => ['high', 'critical'].includes(value.severity));
          if (vulnerable.length) console.log(`Vulnerable (${repo.relativePath}/${check.directory}): ${vulnerable.map(([name, value]) => `${name} (${value.severity})`).join(', ')}`);
        }
        for (const action of repo.data.actions ?? []) console.log(`Plan (${repo.relativePath}/${action.directory}): ${action.automatic ? `${action.command} ${action.args.join(' ')}` : action.reason}`);
        for (const action of repo.data.nextActions ?? []) console.log(`Next (${repo.relativePath}): ${action}`);
      }
    }
    for (const file of report.data.files ?? []) console.log(`${file.action.padEnd(9)} ${file.path}`);
    for (const error of report.errors) console.error(`${error.code}: ${error.message}${error.paths ? ` (${error.paths.join(', ')})` : ''}`);
    for (const warning of report.warnings) console.warn(`${warning.code}: ${warning.message}`);
    if (report.data.checks) for (const check of report.data.checks) console.log(`${check.id} ${check.directory ?? ''}: ${check.status}`);
    for (const action of report.data.nextActions ?? []) console.log(`Next: ${action}`);
  }
  process.exitCode = report.exitCode;
}
