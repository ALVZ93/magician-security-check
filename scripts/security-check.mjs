#!/usr/bin/env node
/**
 * Node.js project metadata & runtime security checks.
 * No third-party packages. Read-only. Node 22+.
 * It checks intent expressed in the repository, NOT the production server.
 */
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadSupportedMajors } from './node-releases.mjs';

const failures = [];
const warnings = [];
const info = [];
const pinnedVersions = [];
const offline = process.argv.includes('--offline');
let supported = new Set([22, 24, 26]); // Offline snapshot: October 2026.
const clean = (s) => String(s || '').trim().replace(/^v(?=\d)/, '');
const readText = (path) => readFileSync(path, 'utf8').trim();
const add = (level, message) => {
  ({ FAIL: failures, WARN: warnings, INFO: info })[level].push(message);
  console.log(`${level}  ${message}`);
};
const isFullVersion = (s) => /^\d+\.\d+\.\d+$/.test(clean(s));
const versionParts = (s) => clean(s).split('.').map(Number);
const cmp = (a, b) => {
  const pa = versionParts(a), pb = versionParts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

if (offline) add('WARN', 'Modo offline: ramas soportadas según snapshot de octubre de 2026; no se certifica su soporte actual.');
else {
  try { supported = await loadSupportedMajors(); }
  catch (error) { add('FAIL', `No se pudo comprobar el calendario oficial de soporte de Node: ${error.message}`); }
}

const rootIndex = process.argv.indexOf('--repository-root');
const repositoryRoot = rootIndex === -1 ? process.cwd() : resolve(process.argv[rootIndex + 1] ?? '');
const relativeDirectory = relative(repositoryRoot, process.cwd());
if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
  throw new Error('--repository-root must contain the working directory');
}
function runtimeDeclaration(name) {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    const path = join(directory, name);
    if (existsSync(path)) return [relative(process.cwd(), path) || name, readText(path)];
    if (directory === repositoryRoot || dirname(directory) === directory) return [name, ''];
  }
}

if (!existsSync('package.json')) {
  add('FAIL', 'No hay package.json en la raíz. Configura working-directory para este paquete (ver README).');
} else {
  let pkg;
  try {
    pkg = JSON.parse(readText('package.json'));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('expected an object');
  }
  catch (e) { add('FAIL', `package.json inválido: ${e.message}`); }
  if (pkg) {
    const locks = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
      .filter((p) => existsSync(p));
    if (locks.length === 0) add('FAIL', 'Falta un lockfile versionado (npm, pnpm o Yarn).');
    else if (locks.length > 1) add('FAIL', `Hay varios lockfiles incompatibles: ${locks.join(', ')}`);
    else add('INFO', `Lockfile detectado: ${locks[0]}`);
    const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
    if (locks.length === 1 && pm) {
      const expected = locks[0].startsWith('pnpm') ? 'pnpm' : locks[0] === 'yarn.lock' ? 'yarn' : 'npm';
      if (pm !== expected) add('FAIL', `packageManager (${pm}) no coincide con el lockfile (${expected}).`);
    }
    if (locks.length === 1 && ['pnpm-lock.yaml', 'yarn.lock'].includes(locks[0]) && !pm) {
      add('FAIL', 'Declara packageManager (p. ej., "pnpm@10.0.0") para fijar la versión del gestor.');
    }

    const configs = [
      runtimeDeclaration('.nvmrc'),
      runtimeDeclaration('.node-version'),
      ['package.json > volta.node', pkg.volta?.node],
      ['package.json > engines.node', pkg.engines?.node],
    ].filter(([, val]) => typeof val === 'string' && val.trim());

    if (configs.length === 0) add('FAIL', 'Falta declarar la versión de Node: añade .nvmrc o engines.node.');
    else configs.forEach(([location, version]) => add('INFO', `Node en ${location}: ${version}`));

    const concreteMajors = configs
      .filter(([location]) => !location.includes('engines.node'))
      .map(([, v]) => clean(v))
      .filter((v) => /^\d+(?:\.\d+){0,2}$/.test(v))
      .map((v) => Number(v.split('.')[0]));
    if (new Set(concreteMajors).size > 1) {
      add('FAIL', 'Las declaraciones fijas de versión de Node (.nvmrc, .node-version o Volta) no coinciden.');
    }

    // A pin (exact version or major) can be checked reliably; arbitrary semver
    // constraints in engines.node must be reviewed separately.
    for (const [location, raw] of configs) {
      const ver = clean(raw);
      if (/^\d+(?:\.\d+){0,2}$/.test(ver)) {
        const major = Number(ver.split('.')[0]);
        if (!supported.has(major)) add('FAIL', `${location}: Node ${ver} fuera de las ramas soportadas (${[...supported].join('/')}).`);
        if (isFullVersion(ver)) pinnedVersions.push([location, ver]);
      } else if (location.includes('engines.node')) {
        const simpleRange = ver.match(/^[~^](\d+)\.\d+\.\d+$/);
        if (simpleRange && !supported.has(Number(simpleRange[1]))) add('FAIL', `${location}: ${ver} solo permite una rama de Node fuera de soporte.`);
        // Semver ranges must not be mistaken for a runtime pin.
        add('WARN', `${location} usa un rango (${ver}). Comprueba que no permite versiones EOL ni impide parches.`);
      } else {
        add('WARN', `${location}: ${ver} no es un pin numérico; revisa qué runtime se despliega realmente.`);
      }
    }

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) add('INFO', 'Next.js detectado: revisar runtime de servidor, route handlers, server actions y hosting.');
    else if (deps.astro) add('INFO', 'Astro detectado: confirmar si la salida es static o server/SSR.');
    else add('INFO', 'Confirmar si este proyecto ejecuta Node en producción o solo durante build.');
  }
}

// Docker: basic static hints (not a full Dockerfile parser).
const dockerfiles = readdirSync('.').filter((name) => /^Dockerfile(?:\..+)?$/i.test(name));
for (const path of dockerfiles) {
  const data = readText(path);
  const images = [...data.matchAll(/^\s*FROM\s+(?:--[^\s]+\s+)*([^\s]+)(?:\s+AS\s+\S+)?/gim)].map((match) => match[1]);
  for (const img of images) {
    const m = img.match(/(?:^|\/)node:(\d+)(?:\.(\d+)\.(\d+))?([\w.-]*)?(?:@sha256:[a-f0-9]+)?$/i);
    if (m) {
      const major = Number(m[1]);
      if (!supported.has(major)) add('FAIL', `${path}: imagen ${img} tiene un Node no soportado.`);
      else add('INFO', `${path}: imagen ${img}. Reconstruir y redeplegar tras cada parche.`);
      if (m[2] && m[3]) pinnedVersions.push([path, `${m[1]}.${m[2]}.${m[3]}`]);
    } else if (/node:latest|node:current/i.test(img)) {
      add('WARN', `${path}: imagen móvil ${img}, mejor fijar una rama LTS y reconstruir periódicamente.`);
    }
  }
}
if (existsSync('vercel.json') || existsSync('.vercel')) {
  add('WARN', 'Vercel: comprobar en Project Settings la versión del runtime y redeplegar; este scanner NO inspecciona producción.');
}
if (dockerfiles.length === 0) {
  add('WARN', 'Verifica manualmente el runtime de producción (Vercel, Netlify, Cloudflare o servidor).');
}

async function verifyPatches() {
  if (!pinnedVersions.length) return;
  if (offline) {
    add('WARN', 'Modo offline: no se comprueba si los pines de patch están actualizados.');
    return;
  }
  let versions;
  try {
    const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    versions = await res.json();
  } catch (err) {
    add('FAIL', `No se pudo consultar el índice de versiones oficial de Node: ${err.message}`);
    return;
  }
  const latestByMajor = new Map();
  for (const rel of versions) {
    const ver = clean(rel.version);
    if (!isFullVersion(ver)) continue;
    const major = Number(ver.split('.')[0]);
    if (!supported.has(major) || latestByMajor.has(major)) continue;
    latestByMajor.set(major, ver); // Official index newest first
  }
  for (const [location, value] of pinnedVersions) {
    const major = Number(value.split('.')[0]);
    const latest = latestByMajor.get(major);
    if (!versions.some((release) => clean(release.version) === value)) add('FAIL', `${location}: Node ${value} no figura como versión publicada en el índice oficial.`);
    else if (!latest) add('FAIL', `No se encontró la última versión de Node ${major} en el índice oficial.`);
    else if (cmp(value, latest) < 0) add('FAIL', `${location}: Node ${value} es anterior a ${latest} (último patch de la rama ${major}).`);
    else add('INFO', `${location}: Node ${value} coincide con el último patch publicado para ${major}.`);
  }
}
// Verification runs after the synchronous metadata checks.
await verifyPatches();

if (process.env.GITHUB_STEP_SUMMARY) {
  const row = (items, symbol) => items.map((v) => `- ${symbol} ${v}`).join('\n');
  const text = [
    '## Rubicon Node security: runtime & deployment',
    row(failures, '❌'), row(warnings, '⚠️'), row(info, '✅'),
    '\n**Nota:** verificar también el runtime real desplegado. Escanear un repositorio no equivale a auditar el servidor.',
  ].filter(Boolean).join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}
console.log(`\nResultado: ${failures.length} fallos, ${warnings.length} avisos.`);
process.exitCode = failures.length ? 1 : 0;
