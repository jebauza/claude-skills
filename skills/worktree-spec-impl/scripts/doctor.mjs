#!/usr/bin/env node
// Uso: node doctor.mjs [--project <dir>]
// Diagnóstico previo: dice qué va a funcionar y qué no ANTES de crear ningún worktree, para
// que un fallo aparezca como informe legible y no a mitad del bootstrap. No deja nada creado.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPgTools, inspectDb } from './db.mjs';
import {
  cloneName, detectEnvFiles, detectPackageManager, detectPortVars, detectVerify,
  loadConfig, loadDriver, loadProjectEnv, readPkg, swapDb,
} from './lib/detect.mjs';
import { git } from './lib/fsx.mjs';
import * as registry from './lib/registry.mjs';

const index = process.argv.indexOf('--project');
const start = path.resolve(index > 0 ? process.argv[index + 1] : process.cwd());

let failures = 0;
const ok = (text) => console.log(`  ✓ ${text}`);
const warn = (text) => console.log(`  ⚠ ${text}`);
const bad = (text) => {
  failures++;
  console.log(`  ✗ ${text}`);
};

console.log(`worktree-doctor — ${start}\n`);

// ── Entorno ─────────────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0]);
(nodeMajor >= 18 ? ok : bad)(`node v${process.versions.node}${nodeMajor >= 18 ? '' : ' (se necesita ≥ 18)'}`);

const gitVersion = git(['--version']);
if (gitVersion.status !== 0) {
  bad('git no está disponible');
  process.exit(1);
}
const gitMinor = gitVersion.stdout.match(/(\d+)\.(\d+)/);
(gitMinor && (Number(gitMinor[1]) > 2 || Number(gitMinor[2]) >= 17) ? ok : bad)(`${gitVersion.stdout} (worktrees estables desde 2.17)`);

let root;
try {
  root = registry.mainRoot(start);
} catch {
  bad('esto no es un repositorio git');
  process.exit(1);
}
ok(`checkout principal: ${root}`);
if (path.resolve(start) !== root && !start.startsWith(root)) warn('estás fuera del checkout principal');

// ── Repositorio ─────────────────────────────────────────────────────────────
const ignored = git(['check-ignore', '-q', '.trees/x'], { cwd: root }).status === 0;
(ignored ? ok : bad)(ignored ? '.trees/ está ignorado' : '.trees/ NO está en .gitignore: añádelo antes de crear worktrees');

const head = git(['rev-parse', '--verify', 'HEAD'], { cwd: root });
(head.status === 0 ? ok : bad)(head.status === 0 ? 'el repo tiene al menos un commit' : 'el repo no tiene commits: un worktree necesita uno');

const currentBranch = git(['branch', '--show-current'], { cwd: root }).stdout;
currentBranch
  ? ok(`rama base por defecto: "${currentBranch}" (la activa en el checkout principal; --base la cambia)`)
  : warn('HEAD desacoplado en el checkout principal: /worktree-spec-impl necesitará --base <rama>');

const dirty = git(['status', '--porcelain'], { cwd: root }).stdout;
if (dirty) warn('el checkout principal tiene cambios sin commitear: no pasan al worktree');

// ── Proyecto ────────────────────────────────────────────────────────────────
const pkg = readPkg(root);
const config = loadConfig(root);
const envFile = config.envFile ?? '.env';
if (!pkg) {
  warn('no hay package.json: el skill funciona, pero sin dependencias ni verificación');
} else {
  const manager = detectPackageManager(root);
  const modules = fs.existsSync(path.join(root, 'node_modules'));
  ok(`gestor: ${manager.pm}${manager.lockfile ? ` (${manager.lockfile})` : ' (sin lockfile)'}`);
  (modules ? ok : warn)(modules ? 'node_modules presente en el principal' : 'no hay node_modules en el principal: cada worktree hará una instalación completa');

  const steps = detectVerify(root);
  steps.length ? ok(`verificación: ${steps.map((step) => step.name).join(', ')}`) : warn('no hay test/lint/typecheck: la verificación no comprobará nada');
}

const envFiles = detectEnvFiles(root);
envFiles.length ? ok(`ficheros de entorno a copiar: ${envFiles.join(', ')}`) : warn('no hay ficheros .env ignorados por git que copiar');

const env = loadProjectEnv(root, envFile);
const portVars = config.portVars ?? detectPortVars(env);
portVars.length
  ? ok(`puerto: ${portVars.join(', ')}=${env[portVars[0]] ?? '?'} → cada worktree recibirá el siguiente libre`)
  : warn('no se detectó variable de puerto (APP_PORT/PORT/...): dos servidores a la vez chocarían; defínela en worktree.json ("portVars")');

// ── Base de datos ───────────────────────────────────────────────────────────
const inspected = inspectDb(root, envFile, config.db ?? {});
const detected = inspected?.detected;
if (!detected) {
  ok('BD: el proyecto no declara ninguna → no se provisiona nada');
} else if (!detected.engine) {
  bad(`BD detectada (${detected.source}) pero sin motor deducible: no hay ningún driver conocido en las dependencias. Indícalo con "db": {"engine": "pg|mysql|mongo|sqlite"} en worktree.json, o "db": {"skip": true}`);
} else if (detected.engine === 'sqlite') {
  const file = path.resolve(root, detected.base);
  ok(`BD: sqlite (${detected.source}) → se clona copiando el fichero`);
  fs.existsSync(file) ? ok(`fichero base: ${file}`) : bad(`el fichero base no existe (${file}): no hay nada que copiar y el bootstrap fallará`);
} else {
  ok(`BD: ${detected.engine} vía ${detected.source}, base "${detected.base}" → copia exacta "${cloneName(detected.base, 'spec-01-ejemplo')}"`);
  if (inspected.remote) {
    warn(`la BD es REMOTA (${inspected.hosts.join(', ')}): clonarla copia datos reales a otra BD de ese servidor. /worktree-spec-impl te preguntará antes de hacerlo`);
  }
  const driver = loadDriver(root, detected.engine);
  if (driver === undefined) {
    bad(`el driver de ${detected.engine} no está instalado en el proyecto: el bootstrap fallará (o desactiva la provisión con "db": {"skip": true})`);
  } else if (detected.engine === 'pg') {
    await checkPostgres(driver);
  } else if (detected.engine === 'mysql') {
    warn('MySQL se copia tabla a tabla con el driver (esquema, claves foráneas y datos); vistas, triggers y rutinas no. Sin verificar contra un servidor real');
  } else {
    warn('MongoDB se copia colección a colección con el driver (documentos e índices). Sin verificar contra un servidor real');
  }
}

async function checkPostgres(driver) {
  const config_ = (database) => (detected.url ? { connectionString: swapDb(detected.url, database), connectionTimeoutMillis: 5000 } : { ...detected.conn, database, connectionTimeoutMillis: 5000 });
  let client;
  for (const database of ['postgres', detected.base]) {
    client = new driver.Client(config_(database));
    try {
      await client.connect();
      break;
    } catch (error) {
      client = null;
      if (database === detected.base) return bad(`no se puede conectar a Postgres: ${error.message}`);
    }
  }
  try {
    ok('conexión a Postgres correcta');
    const role = (await client.query('SELECT rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0];
    (role?.rolcreatedb || role?.rolsuper ? ok : bad)(role?.rolcreatedb || role?.rolsuper ? 'el usuario puede CREATE DATABASE' : 'el usuario NO tiene CREATEDB: no se podrán crear BD por worktree');
    const open = Number((await client.query('SELECT count(*) FROM pg_stat_activity WHERE datname = $1', [detected.base])).rows[0].count);
    open === 0
      ? ok(`"${detected.base}" no tiene conexiones abiertas → el clon por TEMPLATE es viable`)
      : warn(`"${detected.base}" tiene ${open} conexión(es) abierta(s): no se puede clonar por TEMPLATE; se copiará con pg_dump | psql`);

    // pg_dump es el camino cuando la base está ocupada (algo conectado, típicamente `npm run dev`).
    const tools = findPgTools(config.db?.pgBin);
    const serverMajor = Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    if (!tools.ok) {
      warn(`falta ${tools.missing.join(' y ')} en el PATH: con la base ocupada el bootstrap FALLARÁ (no crea una BD vacía). Instala el cliente de PostgreSQL ${serverMajor}+ o indica su carpeta en worktree.json → db.pgBin`);
    } else if (tools.major < serverMajor) {
      bad(`${tools.version} es más antiguo que el servidor (PostgreSQL ${serverMajor}): se niega a volcarlo. Instala el cliente ${serverMajor}+`);
    } else {
      ok(`${tools.version} → la copia con la base ocupada es posible`);
    }
    const size = Number((await client.query('SELECT pg_database_size($1) AS size', [detected.base])).rows[0].size);
    if (size > 500 * 1024 * 1024) warn(`"${detected.base}" pesa ${(size / 1048576).toFixed(0)} MB: cada clon tardará y ocupará lo mismo`);
  } finally {
    await client.end();
  }
}

// ── Sistema de ficheros ─────────────────────────────────────────────────────
const probe = path.join(root, '.trees');
const probeFile = path.join(probe, `.doctor-${process.pid}`);
try {
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(probeFile, 'x');
  fs.linkSync(probeFile, `${probeFile}.link`);
  ok('el volumen admite hardlinks (node_modules se clonará al instante)');
} catch (error) {
  warn(`el volumen no admite hardlinks (${error.code}): se instalará con el gestor en cada worktree`);
} finally {
  fs.rmSync(probeFile, { force: true });
  fs.rmSync(`${probeFile}.link`, { force: true });
}
if (fs.existsSync(probe) && fs.readdirSync(probe).length === 0) fs.rmdirSync(probe);

if (os.platform() === 'win32') {
  const longPaths = git(['config', '--get', 'core.longpaths'], { cwd: root }).stdout === 'true';
  (longPaths ? ok : warn)(longPaths ? 'core.longpaths activo' : 'core.longpaths desactivado: rutas > 260 caracteres fallarán. Actívalo con: git config --global core.longpaths true');
  const room = 260 - path.join(root, '.trees', 'spec-NN-slug-largo').length;
  room < 130 && warn(`la ruta del proyecto deja solo ~${room} caracteres para node_modules dentro del worktree; considera un directorio más corto`);
}

console.log(failures ? `\n${failures} problema(s) bloqueante(s): corrígelos antes de crear un worktree.` : '\nTodo listo para /worktree-spec-impl.');
process.exit(failures ? 1 : 0);
