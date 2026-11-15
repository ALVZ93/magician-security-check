import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function executable(command, { platform = process.platform, env = process.env, node = process.execPath } = {}) {
  const directories = [dirname(node), ...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)];
  for (const directory of directories) {
    // Execute Node entry points directly on Windows; never enable a command shell.
    if (platform === 'win32' && ['npm', 'corepack'].includes(command)) {
      const script = command === 'npm' ? 'node_modules/npm/bin/npm-cli.js' : 'node_modules/corepack/dist/corepack.js';
      const entry = join(directory, script);
      if (existsSync(entry) && statSync(entry).isFile()) return { command: node, prefix: [entry] };
    }
    for (const suffix of platform === 'win32' ? ['.exe'] : ['']) {
      const path = join(directory, command + suffix);
      try {
        if (!statSync(path).isFile()) continue;
        accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return { command: path, prefix: [] };
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export function runCommand(command, args, options = {}) {
  const resolved = executable(command, { env: options.env ?? process.env });
  if (!resolved) return { status: null, stdout: '', stderr: '', error: new Error(`${command} is not available on PATH.`) };
  return spawnSync(resolved.command, [...resolved.prefix, ...args], { timeout: 8 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, ...options, shell: false });
}

export function parseToolJson(output) {
  const value = String(output ?? '').trim();
  if (!value) throw new Error('The scanner returned no JSON.');
  try { return JSON.parse(value); }
  catch { return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
}
