// Autodetección: lo que cambia entre proyectos se lee del proyecto, no se configura a mano.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { git, readEnv, readJson } from './fsx.mjs';

export const readPkg = (dir) => readJson(path.join(dir, 'package.json'));

const allDeps = (pkg) => ({ ...pkg?.dependencies, ...pkg?.devDependencies });

// ── Gestor de paquetes (por lockfile) ───────────────────────────────────────
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

export function detectPackageManager(dir) {
  for (const [file, pm] of LOCKFILES) {
    if (fs.existsSync(path.join(dir, file))) return { pm, lockfile: file };
  }
  return { pm: 'npm', lockfile: null };
}

export function installCommand({ pm, lockfile }) {
  if (pm === 'pnpm') return 'pnpm install --frozen-lockfile';
  if (pm === 'yarn') return 'yarn install';
  if (pm === 'bun') return 'bun install';
  return lockfile ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
}

const runScript = (pm, name) => (pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`);
const execBin = (pm, bin) =>
  ({ npm: `npx ${bin}`, pnpm: `pnpm exec ${bin}`, yarn: `yarn ${bin}`, bun: `bunx ${bin}` })[pm];

// ── Verificación: solo lo que el proyecto realmente define ──────────────────
const NPM_DEFAULT_TEST = /no test specified/;

export function detectVerify(dir) {
  const pkg = readPkg(dir);
  if (!pkg) return [];
  const { pm } = detectPackageManager(dir);
  const scripts = pkg.scripts ?? {};
  const steps = [];

  if (scripts.test && !NPM_DEFAULT_TEST.test(scripts.test)) {
    steps.push({ name: 'test', command: pm === 'npm' ? 'npm test' : `${pm} test` });
  }
  if (scripts.lint) steps.push({ name: 'lint', command: runScript(pm, 'lint') });

  // Un proyecto JS no tiene tsc: solo se añade si typescript es dependencia y hay tsconfig.
  if (scripts.typecheck) {
    steps.push({ name: 'typecheck', command: runScript(pm, 'typecheck') });
  } else if (allDeps(pkg).typescript && fs.existsSync(path.join(dir, 'tsconfig.json'))) {
    steps.push({ name: 'typecheck', command: `${execBin(pm, 'tsc')} --noEmit` });
  }
  return steps;
}

// ── Puertos ─────────────────────────────────────────────────────────────────
const PORT_VARS = ['APP_PORT', 'PORT', 'SERVER_PORT', 'HTTP_PORT'];

export function detectPortVars(envMap) {
  const found = PORT_VARS.find((name) => envMap[name] && /^\d+$/.test(envMap[name]));
  return found ? [found] : [];
}

// ── Ficheros ignorados por git que el worktree necesita ─────────────────────
const ENV_TEMPLATE = /\.(example|template|sample|dist)$/;

export function detectEnvFiles(root) {
  return fs
    .readdirSync(root)
    .filter((name) => /^\.env(\..+)?$/.test(name) && !ENV_TEMPLATE.test(name))
    .filter((name) => git(['check-ignore', '-q', name], { cwd: root }).status === 0);
}

// Candidatos a "el .env principal" cuando ese nombre exacto no existe: cualquier fichero
// ignorado por git con pinta de fichero de entorno (.env.local, env.local, app.env...),
// para preguntarle al usuario en vez de asumir en silencio que no hay ninguno.
const ENV_LIKE = /(^\.?env\.|\.env$|^\.env$)/i;

export function findEnvCandidates(root) {
  return fs
    .readdirSync(root)
    .filter((name) => ENV_LIKE.test(name) && !ENV_TEMPLATE.test(name))
    .filter((name) => git(['check-ignore', '-q', name], { cwd: root }).status === 0);
}

// ── Base de datos ───────────────────────────────────────────────────────────
const URL_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'MYSQL_URL', 'MONGO_URL', 'MONGODB_URI', 'MONGODB_URL'];
const FIELD_VARS = {
  host: ['DB_HOST', 'PGHOST', 'POSTGRES_HOST', 'MYSQL_HOST', 'MYSQL_HOSTNAME'],
  port: ['DB_PORT', 'PGPORT', 'POSTGRES_PORT', 'MYSQL_PORT'],
  name: ['DB_NAME', 'DB_DATABASE', 'PGDATABASE', 'POSTGRES_DB', 'POSTGRES_DATABASE', 'MYSQL_DATABASE', 'MONGO_DB_NAME', 'MONGODB_DB', 'MONGO_DB', 'MONGO_DATABASE'],
  user: ['DB_USER', 'DB_USERNAME', 'PGUSER', 'POSTGRES_USER', 'MYSQL_USER'],
  password: ['DB_PASSWORD', 'DB_PASS', 'PGPASSWORD', 'POSTGRES_PASSWORD', 'MYSQL_PASSWORD'],
};

const SCHEME_ENGINE = { postgres: 'pg', postgresql: 'pg', mysql: 'mysql', mariadb: 'mysql', mongodb: 'mongo', 'mongodb+srv': 'mongo', sqlite: 'sqlite', file: 'sqlite' };
const DEP_ENGINE = [['pg', 'pg'], ['mysql2', 'mysql'], ['mongodb', 'mongo'], ['better-sqlite3', 'sqlite'], ['sqlite3', 'sqlite']];
export const DRIVER = { pg: 'pg', mysql: 'mysql2/promise', mongo: 'mongodb', sqlite: null };

const firstSet = (envMap, names) => names.find((name) => envMap[name] !== undefined && envMap[name] !== '');

export function detectDb(projectDir, envMap, override = {}) {
  if (override.skip) return null;
  const pkg = readPkg(projectDir);
  const depEngine = DEP_ENGINE.find(([dep]) => allDeps(pkg)[dep])?.[1];

  const urlVar = override.urlVar ?? firstSet(envMap, URL_VARS);
  if (urlVar && envMap[urlVar]) {
    const url = envMap[urlVar];
    const scheme = url.match(/^([a-z0-9+]+):/i)?.[1]?.toLowerCase();
    // Sin motor NO se devuelve null: hay una BD declarada y tratarla como "sin BD" dejaría al agente
    // compartiendo la base sin saberlo. El llamador falla pidiendo `db.engine`.
    const engine = override.engine ?? SCHEME_ENGINE[scheme] ?? depEngine ?? null;
    // Se quita esquema+autoridad antes de leer el path: `mongodb://host:27017` no tiene BD
    // y un split('/') devolvería `host:27017` como si lo fuera.
    const name =
      engine === 'sqlite'
        ? url.replace(/^(sqlite|file):(\/\/)?/i, '').replace(/\?.*$/, '')
        : decodeURIComponent(url.replace(/^[a-z0-9+.-]+:\/\/[^/]*/i, '').replace(/\?.*$/, '').replace(/^\//, ''));
    if (!name) {
      // Caso típico de Mongo: `MONGO_URL=mongodb://host:27017` + `MONGO_DB_NAME=app`. La URL
      // se conserva para conectar; lo que se reescribe por worktree es la variable del nombre.
      const nameVar = firstSet(envMap, FIELD_VARS.name);
      return nameVar ? { engine, source: nameVar, binding: { kind: 'var', var: nameVar }, base: envMap[nameVar], url } : null;
    }
    return { engine, source: urlVar, binding: { kind: 'url', var: urlVar }, base: name, url };
  }

  const nameVar = override.nameVar ?? firstSet(envMap, FIELD_VARS.name);
  if (!nameVar) return null;
  const engine = override.engine ?? depEngine ?? null;
  const pick = (field) => envMap[firstSet(envMap, FIELD_VARS[field])];
  return {
    engine,
    source: nameVar,
    binding: { kind: 'var', var: nameVar },
    base: envMap[nameVar],
    conn: { host: pick('host') ?? 'localhost', port: pick('port') ? Number(pick('port')) : undefined, user: pick('user'), password: pick('password') },
  };
}

// Carga el driver DEL PROYECTO, no uno propio del skill: createRequire resuelve contra
// el node_modules del proyecto desde cualquier cwd.
export function loadDriver(projectDir, engine) {
  const name = DRIVER[engine];
  if (!name) return null;
  try {
    return createRequire(path.join(projectDir, 'package.json'))(name);
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

// Identificador seguro para Postgres/MySQL: [a-z0-9_], máx. 63 caracteres.
export function cloneName(base, slug) {
  const clean = (text) => text.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `${clean(base)}_${clean(slug)}`.slice(0, 63);
}

export const SAFE_IDENTIFIER = /^[a-z0-9_]{1,63}$/;

export function loadProjectEnv(root, envFile = '.env') {
  return readEnv(path.join(root, envFile));
}

// ── BD remota ───────────────────────────────────────────────────────────────
// Clonar una BD remota copia datos reales a otra BD del mismo servidor, con coste y con datos
// potencialmente sensibles: el bootstrap no lo hace sin que el usuario lo confirme.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

export function dbHosts(detected) {
  if (!detected.url) return detected.conn?.host ? [detected.conn.host] : [];
  const authority = detected.url.match(/^[a-z0-9+.-]+:\/\/([^/?]*)/i)?.[1] ?? '';
  const hostList = authority.slice(authority.lastIndexOf('@') + 1);
  return hostList
    .split(',')
    .map((entry) => {
      if (entry.startsWith('[')) return entry.slice(1, entry.indexOf(']')); // IPv6: [::1]:5432
      return entry.split(':').length === 2 ? entry.split(':')[0] : entry;
    })
    .filter(Boolean);
}

export function isRemote(detected) {
  if (detected.engine === 'sqlite') return false;
  if (detected.url && /^mongodb\+srv:/i.test(detected.url)) return true;
  return dbHosts(detected).some((host) => !(LOCAL_HOSTS.has(host.toLowerCase()) || host.startsWith('/') || /^127\./.test(host)));
}

// Sustituye solo el nombre de la BD de una URL de conexión, respetando credenciales y query.
export function swapDb(url, database) {
  const match = url.match(/^([a-z0-9+.-]+:\/\/[^/?]*)(\/[^?]*)?(\?.*)?$/i);
  if (!match) throw new Error('URL de conexión no reconocible');
  return `${match[1]}/${database}${match[3] ?? ''}`;
}

// .claude/worktree.json es opcional: solo lleva lo que la autodetección no puede saber.
export const loadConfig = (root) => readJson(path.join(root, '.claude', 'worktree.json'), {});
