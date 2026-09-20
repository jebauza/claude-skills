#!/usr/bin/env node
// Uso: node bootstrap.mjs <worktree-path> <slug> [--base <rama>] [--confirm-remote]
// Deja un worktree recién creado ejecutable y aislado de los demás: ficheros ignorados,
// dependencias, puerto propio, copia exacta de la BD del .env y pasos de proyecto.
// Idempotente. Solo escribe JSON a stdout; el log va a stderr.
// Código de salida 3 = hace falta que el usuario confirme algo (ver stdout); no hay efectos secundarios.
import fs from 'node:fs';
import path from 'node:path';
import { createDb, inspectDb } from './db.mjs';
import {
  detectEnvFiles, detectPackageManager, detectPortVars, installCommand,
  loadConfig, loadProjectEnv, readPkg, swapDb,
} from './lib/detect.mjs';
import { git, HardlinkUnsupported, linkTree, log, rmWithRetry, runShell, setEnvVar } from './lib/fsx.mjs';
import * as registry from './lib/registry.mjs';

let confirmRemote = false;
let explicitBase;
const positional = [];
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--confirm-remote') confirmRemote = true;
  else if (arg === '--base') explicitBase = rawArgs[++i];
  else if (arg.startsWith('--')) {
    console.error(`Opción desconocida: ${arg}`);
    process.exit(2);
  } else positional.push(arg);
}
const [worktreeArg, slug] = positional;
if (!worktreeArg || !slug) {
  console.error('Uso: bootstrap.mjs <worktree-path> <slug> [--base <rama>] [--confirm-remote]');
  process.exit(2);
}

const worktree = path.resolve(worktreeArg);
const root = registry.mainRoot();
const config = loadConfig(root);
const envFile = config.envFile ?? '.env';
const wtEnv = path.join(worktree, envFile);

function fail(message) {
  log(`[bootstrap] ERROR: ${message}`);
  process.exit(1);
}

// ── 0a. Rama base ───────────────────────────────────────────────────────────
// La rama en la que se integrará el trabajo al final (develop, feature/x, main…). Se captura UNA
// vez, de forma explícita, y se guarda en el registro: la rama activa del checkout principal puede
// cambiar entre una sesión y otra, así que no se puede volver a deducir después.
const existing = registry.get(root, slug);
let base;
if (existing?.base) {
  if (explicitBase && explicitBase !== existing.base) {
    fail(`"${slug}" ya está registrado con la base "${existing.base}"; no se cambia a "${explicitBase}". Si de verdad quieres otra base, deshaz el worktree (teardown.mjs) y créalo de nuevo.`);
  }
  base = existing.base;
} else {
  base = explicitBase ?? git(['branch', '--show-current'], { cwd: root }).stdout;
  if (!base) fail('el checkout principal tiene HEAD desacoplado: indica la rama base con --base <rama>');
  // Un nombre que empieza por "-" se leería como opción de git; check-ref-format valida el resto.
  if (base.startsWith('-') || git(['check-ref-format', '--branch', base], { cwd: root }).status !== 0) {
    fail(`"${base}" no es un nombre de rama válido`);
  }
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { cwd: root }).status !== 0) {
    fail(`la rama base "${base}" no existe en local`);
  }
  // Detecta un worktree creado desde otra rama distinta de la base declarada.
  if (git(['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: worktree }).status !== 0) {
    fail(`la rama base "${base}" no es ancestro de este worktree: parece creado desde otra rama. Créalo con: git worktree add <ruta> -b <rama> ${base}`);
  }
}

// ── 0b. Preflight: BD remota ────────────────────────────────────────────────
// Clonar una BD remota copia datos reales a otra BD del mismo servidor, con coste y con datos
// potencialmente sensibles. Se decide ANTES de copiar, instalar o registrar nada, para que
// negarse no deje restos. Quien lanza el bootstrap pregunta al usuario y repite con --confirm-remote.
const preflight = inspectDb(root, envFile, config.db ?? {});
if (preflight?.remote && !confirmRemote) {
  console.log(
    JSON.stringify({
      status: 'needs-confirmation',
      reason: 'remote-db',
      host: preflight.hosts.join(', '),
      engine: preflight.detected.engine,
      database: preflight.detected.base,
    }),
  );
  process.exit(3);
}

// ── 1. Ficheros ignorados por git (.env...) ─────────────────────────────────
// Se copian, no se enlazan: cada worktree necesita su propio puerto y BD. Sin sobrescribir:
// re-ejecutar no debe pisar el puerto ya reescrito.
const toCopy = [...new Set([...detectEnvFiles(root), ...(config.copy ?? [])])];
for (const file of toCopy) {
  const dest = path.join(worktree, file);
  const source = path.join(root, file);
  if (fs.existsSync(dest)) log(`[bootstrap] ya existe ${file}, se conserva`);
  else if (fs.existsSync(source)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    log(`[bootstrap] copiado ${file}`);
  } else log(`[bootstrap] AVISO: ${file} está en copy[] pero no existe en ${root}`);
}

// ── 2. Dependencias ─────────────────────────────────────────────────────────
const manager = detectPackageManager(worktree);
let installMethod = 'none';

function install() {
  const command = installCommand(manager);
  log(`[bootstrap] ${command}`);
  if (runShell(command, { cwd: worktree }) !== 0) fail(`falló "${command}"`);
}

if (readPkg(worktree) && !fs.existsSync(path.join(worktree, 'node_modules'))) {
  const rootModules = path.join(root, 'node_modules');
  const rootLock = manager.lockfile && path.join(root, manager.lockfile);
  const wtLock = manager.lockfile && path.join(worktree, manager.lockfile);
  const sameLock = Boolean(rootLock) && fs.existsSync(rootLock) && fs.existsSync(wtLock) && fs.readFileSync(rootLock).equals(fs.readFileSync(wtLock));

  // pnpm ya enlaza desde su store global (tan rápido como los hardlinks) y su árbol de
  // symlinks es frágil de copiar a mano; yarn/bun tampoco tienen un layout que convenga clonar.
  if (manager.pm === 'npm' && sameLock && fs.existsSync(rootModules)) {
    try {
      const stats = linkTree(rootModules, path.join(worktree, 'node_modules'));
      installMethod = 'hardlinks';
      log(`[bootstrap] node_modules por hardlinks (${stats.files} ficheros, ${stats.symlinks} symlinks, ${stats.copiedSymlinks} copiados)`);
    } catch (error) {
      if (!(error instanceof HardlinkUnsupported)) throw error;
      log(`[bootstrap] hardlinks no disponibles (${error.message}), se instala con ${manager.pm}`);
      rmWithRetry(path.join(worktree, 'node_modules'));
    }
  }
  if (installMethod === 'none') {
    install();
    installMethod = manager.pm;
  }
}

// ── 3. Puerto propio ────────────────────────────────────────────────────────
const rootEnv = loadProjectEnv(root, envFile);
const portVars = config.portVars ?? detectPortVars(rootEnv);
const basePort = portVars.length ? Number(rootEnv[portVars[0]]) || 3000 : null;
let entry = await registry.allocate(root, slug, basePort, base);
const overrides = {};

if (entry.port != null) {
  for (const name of portVars) {
    setEnvVar(wtEnv, name, entry.port);
    overrides[name] = String(entry.port);
  }
  log(`[bootstrap] puerto ${entry.port} (${portVars.join(', ')})`);
}

// ── 4. Base de datos propia ─────────────────────────────────────────────────
// La BD del worktree es siempre una copia exacta de la base del .env, o el bootstrap falla:
// nunca una BD vacía ni la base compartida por accidente.
let db;
try {
  db = await createDb({ root, worktree, slug, envFile, override: config.db ?? {}, confirmRemote });
} catch (error) {
  fail(`no se pudo copiar la BD del worktree: ${error.message}`);
}

if (db.method === 'none') log(`[bootstrap] BD: ${db.reason}`);
else if (db.method === 'needs-confirmation') fail('la BD es remota y falta --confirm-remote');
else {
  log(`[bootstrap] BD ${db.info}: ${db.method}${db.name ? ` → ${db.name}` : ''}`);
  for (const warning of db.warnings ?? []) log(`[bootstrap] AVISO BD: ${warning}`);
  const patch = { engine: db.engine, dbBase: db.base, db: db.name ?? entry.db };
  // Solo se marca como propia si ESTE run la creó: un re-run que la encuentra existente
  // no debe degradar la marca, y una BD preexistente nunca debe recibirla.
  if (db.created) patch.dbCreated = true;
  entry = registry.update(root, slug, patch);

  const value = db.rewrite ?? db.name;
  if (value && db.binding) {
    if (db.binding.kind === 'var') {
      setEnvVar(wtEnv, db.binding.var, value);
      overrides[db.binding.var] = value;
    } else {
      const current = loadProjectEnv(root, envFile)[db.binding.var];
      const next = db.engine === 'sqlite' ? value : swapDb(current, value);
      setEnvVar(wtEnv, db.binding.var, next);
      overrides[db.binding.var] = next;
    }
  }
}

// Variables explícitas para los hijos: dotenv no pisa variables ya presentes en el entorno,
// así que un DB_NAME/APP_PORT heredado del shell ganaría al .env reescrito.
const childEnv = { ...overrides, WT_SLUG: slug, WT_PATH: worktree, WT_PORT: String(entry.port ?? ''), WT_DB: entry.db ?? '' };

// ── 5. Pasos de proyecto (Redis, colas...) ──────────────────────────────────
// No hay paso de migraciones: la BD copiada ya trae esquema y datos.
for (const step of config.setup ?? []) {
  log(`[bootstrap] setup: ${step}`);
  if (runShell(step, { cwd: worktree, env: childEnv }) !== 0) fail(`falló el paso de setup: ${step}`);
}

console.log(
  JSON.stringify({
    slug,
    path: worktree,
    port: entry.port,
    db: entry.db ?? null,
    dbMethod: db?.method ?? 'none',
    dbWarnings: db?.warnings ?? [],
    install: installMethod,
    packageManager: manager.pm,
    base,
  }),
);
