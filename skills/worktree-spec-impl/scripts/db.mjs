#!/usr/bin/env node
// Provisión de la BD de cada worktree: SIEMPRE una copia exacta (esquema y datos) de la base
// del .env. Nunca una BD vacía ni la base compartida: o se obtiene la copia, o falla con un
// mensaje que dice qué hacer. Portable: usa el driver que el proyecto ya tiene instalado.
//
// Uso: node db.mjs create|drop --project <raíz> --worktree <dir> --slug <slug> [--confirm-remote]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { log } from './lib/fsx.mjs';
import { cloneName, dbHosts, detectDb, isRemote, loadConfig, loadDriver, loadProjectEnv, SAFE_IDENTIFIER, swapDb } from './lib/detect.mjs';

// ── Conexión ────────────────────────────────────────────────────────────────
function connectionFor(detected, database) {
  if (detected.url) return { connectionString: swapDb(detected.url, database) };
  return { ...detected.conn, database };
}

async function withPg(driver, detected, maintenanceDbs, fn) {
  let lastError;
  for (const database of maintenanceDbs) {
    const client = new driver.Client(connectionFor(detected, database));
    try {
      await client.connect();
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  throw lastError;
}

// Se conecta a la BD de mantenimiento para poder ejecutar el CREATE/DROP; si `postgres`
// no es accesible (algunos servicios gestionados), se intenta con la BD base.
const pgMaintenance = (detected) => ['postgres', detected.base];

const quoteMysql = (identifier) => `\`${identifier.replace(/`/g, '``')}\``;

async function withMysql(driver, detected, fn) {
  const conn = detected.url
    ? await driver.createConnection(swapDb(detected.url, ''))
    : await driver.createConnection({ host: detected.conn.host, port: detected.conn.port, user: detected.conn.user, password: detected.conn.password });
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

function mongoUrl(detected) {
  if (detected.url) return detected.url;
  const { host, port, user, password } = detected.conn;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password ?? '')}@` : '';
  return `mongodb://${auth}${host}:${port ?? 27017}`;
}

// ── Postgres: pg_dump | psql ────────────────────────────────────────────────
// Las credenciales van por entorno, nunca por argv: un password en la línea de comandos es
// visible en la lista de procesos.
function pgEnv(detected, database) {
  const env = { ...process.env, PGDATABASE: database };
  if (detected.url) {
    const url = new URL(detected.url);
    env.PGHOST = url.hostname.replace(/^\[|\]$/g, '');
    if (url.port) env.PGPORT = url.port;
    if (url.username) env.PGUSER = decodeURIComponent(url.username);
    if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
    const sslmode = url.searchParams.get('sslmode');
    if (sslmode) env.PGSSLMODE = sslmode;
  } else {
    const { host, port, user, password } = detected.conn;
    if (host) env.PGHOST = host;
    if (port) env.PGPORT = String(port);
    if (user) env.PGUSER = user;
    if (password) env.PGPASSWORD = password;
  }
  return env;
}

// `pgBin` (worktree.json → db.pgBin) es para Windows, donde PostgreSQL suele instalarse fuera del PATH.
export function findPgTools(pgBin) {
  const bin = (name) => (pgBin ? path.join(pgBin, name) : name);
  const probe = (name) => {
    const result = spawnSync(bin(name), ['--version'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const dumpVersion = probe('pg_dump');
  const psqlVersion = probe('psql');
  if (!dumpVersion || !psqlVersion) {
    return { ok: false, missing: [!dumpVersion && 'pg_dump', !psqlVersion && 'psql'].filter(Boolean) };
  }
  return { ok: true, dump: bin('pg_dump'), psql: bin('psql'), major: Number(dumpVersion.match(/(\d+)/)?.[1]), version: dumpVersion };
}

// pg_dump lee un snapshot consistente (MVCC): no bloquea ni desconecta a quien esté usando la base.
function dumpRestore(tools, detected, from, to) {
  return new Promise((resolve, reject) => {
    const dump = spawn(tools.dump, ['--no-owner', '--no-privileges'], { env: pgEnv(detected, from), stdio: ['ignore', 'pipe', 'pipe'] });
    const restore = spawn(tools.psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], { env: pgEnv(detected, to), stdio: ['pipe', 'ignore', 'pipe'] });
    const stderr = { dump: '', restore: '' };
    const code = {};

    const settle = () => {
      if (code.dump === undefined || code.restore === undefined) return;
      if (code.dump === 0 && code.restore === 0) return resolve();
      // Si pg_dump muere a mitad, psql recibe EOF y puede salir con 0 habiendo aplicado un volcado
      // truncado: por eso se exigen ambos códigos, no solo el de psql.
      const detail = (name) => (stderr[name].trim() ? `\n  ${name}: ${stderr[name].trim().slice(0, 1500)}` : '');
      reject(new Error(`pg_dump | psql falló (pg_dump=${code.dump}, psql=${code.restore})${detail('dump')}${detail('restore')}`));
    };

    dump.stderr.on('data', (chunk) => (stderr.dump += chunk));
    restore.stderr.on('data', (chunk) => (stderr.restore += chunk));
    dump.stdout.pipe(restore.stdin);
    restore.stdin.on('error', () => {}); // EPIPE si psql termina antes que el volcado
    dump.on('error', (error) => {
      stderr.dump += error.message;
      code.dump = -1;
      restore.kill();
      settle();
    });
    restore.on('error', (error) => {
      stderr.restore += error.message;
      code.restore = -1;
      dump.kill();
      settle();
    });
    dump.on('close', (value) => {
      code.dump = value;
      settle();
    });
    restore.on('close', (value) => {
      code.restore = value;
      if (value !== 0) dump.kill();
      settle();
    });
  });
}

async function dropPgOn(client, name) {
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } catch (error) {
    if (error.code !== '42601') throw error; // WITH (FORCE) no existe antes de PG 13
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [name]);
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  }
}

async function createPg(driver, detected, name, { pgBin }) {
  return withPg(driver, detected, pgMaintenance(detected), async (client) => {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount) return { method: 'existing', created: false };

    try {
      await client.query(`CREATE DATABASE "${name}" TEMPLATE "${detected.base}"`);
      return { method: 'template', created: true };
    } catch (error) {
      // 55006: la base tiene conexiones abiertas (p. ej. un `npm run dev`). Postgres exige cero
      // conexiones para usarla como plantilla.
      if (error.code !== '55006') throw error;
    }

    log(`[db] "${detected.base}" tiene conexiones abiertas: se copia con pg_dump | psql`);
    const tools = findPgTools(pgBin);
    if (!tools.ok) {
      throw new Error(
        `"${detected.base}" tiene conexiones abiertas y no se puede clonar por TEMPLATE, y falta ${tools.missing.join(' y ')} para copiarla con datos. ` +
          'Instala el cliente de PostgreSQL (o indica su carpeta en worktree.json → db.pgBin), o cierra las conexiones a la base y repite. No se crea una BD vacía.',
      );
    }
    const serverMajor = Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    if (tools.major < serverMajor) {
      throw new Error(`${tools.version} es más antiguo que el servidor (PostgreSQL ${serverMajor}) y se niega a volcarlo. Instala el cliente de PostgreSQL ${serverMajor} o superior.`);
    }

    await client.query(`CREATE DATABASE "${name}"`);
    try {
      await dumpRestore(tools, detected, detected.base, name);
    } catch (error) {
      // El clon se acaba de crear aquí mismo: borrarlo no puede afectar a nada más, y así un
      // reintento no se topa con una BD a medias que pasaría por "existente".
      await dropPgOn(client, name);
      throw error;
    }
    return { method: 'dump', created: true };
  });
}

// ── MySQL — copia vía driver (NO verificada contra un servidor real) ────────
// SHOW CREATE TABLE conserva claves foráneas, índices y defaults, que `CREATE TABLE … LIKE` no copia.
// Vistas, triggers y rutinas no se copian y se avisa. Sin snapshot consistente: si la app escribe
// durante la copia, el clon puede quedar algo inconsistente.
async function createMysql(driver, detected, name) {
  return withMysql(driver, detected, async (conn) => {
    const [found] = await conn.query('SHOW DATABASES LIKE ?', [name]);
    if (found.length) return { method: 'existing', created: false };

    const source = quoteMysql(detected.base);
    const target = quoteMysql(name);
    const warnings = [];
    await conn.query(`CREATE DATABASE ${target}`);
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const [tables] = await conn.query(`SHOW FULL TABLES FROM ${source} WHERE Table_type = 'BASE TABLE'`);
      for (const row of tables) {
        const table = quoteMysql(Object.values(row)[0]);
        const [[create]] = await conn.query(`SHOW CREATE TABLE ${source}.${table}`);
        await conn.query(`USE ${target}`);
        await conn.query(create['Create Table']);
        await conn.query(`INSERT INTO ${target}.${table} SELECT * FROM ${source}.${table}`);
      }
      const [views] = await conn.query(`SHOW FULL TABLES FROM ${source} WHERE Table_type = 'VIEW'`);
      if (views.length) warnings.push(`${views.length} vista(s) no copiadas`);
      const [triggers] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [detected.base]);
      if (Number(triggers[0].n)) warnings.push(`${triggers[0].n} trigger(s) no copiados`);
      const [routines] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [detected.base]);
      if (Number(routines[0].n)) warnings.push(`${routines[0].n} rutina(s) no copiadas`);
    } catch (error) {
      await conn.query(`DROP DATABASE IF EXISTS ${target}`);
      throw error;
    }
    return { method: 'copy', created: true, warnings };
  });
}

// ── MongoDB — copia vía driver (NO verificada contra un servidor real) ──────
const MONGO_BATCH = 1000;

async function createMongo(driver, detected, name) {
  const client = new driver.MongoClient(mongoUrl(detected));
  await client.connect();
  try {
    try {
      const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
      if (databases.some((database) => database.name === name)) return { method: 'existing', created: false };
    } catch {
      // Sin permiso para listar bases: se continúa; copiar sobre una existente no destruye nada.
    }

    const source = client.db(detected.base);
    const target = client.db(name);
    const warnings = [];
    try {
      for (const info of await source.listCollections().toArray()) {
        if (info.type === 'view' || info.name.startsWith('system.')) {
          warnings.push(`"${info.name}" no copiada (vista o colección de sistema)`);
          continue;
        }
        await target.createCollection(info.name, info.options ?? {});
        let batch = [];
        for await (const doc of source.collection(info.name).find({})) {
          batch.push(doc);
          if (batch.length >= MONGO_BATCH) {
            await target.collection(info.name).insertMany(batch, { ordered: false });
            batch = [];
          }
        }
        if (batch.length) await target.collection(info.name).insertMany(batch, { ordered: false });

        const indexes = (await source.collection(info.name).indexes())
          .filter((index) => index.name !== '_id_')
          .map(({ v, ns, ...spec }) => spec);
        if (indexes.length) await target.collection(info.name).createIndexes(indexes);
      }
    } catch (error) {
      await target.dropDatabase();
      throw error;
    }
    return { method: 'copy', created: true, warnings };
  } finally {
    await client.close();
  }
}

async function dropPg(driver, detected, name) {
  await withPg(driver, detected, pgMaintenance(detected), (client) => dropPgOn(client, name));
}

async function dropMysql(driver, detected, name) {
  await withMysql(driver, detected, (conn) => conn.query(`DROP DATABASE IF EXISTS ${quoteMysql(name)}`));
}

async function dropMongo(driver, detected, name) {
  const client = new driver.MongoClient(mongoUrl(detected));
  try {
    await client.connect();
    await client.db(name).dropDatabase();
  } finally {
    await client.close();
  }
}

// ── SQLite: clonar es copiar el fichero ─────────────────────────────────────
// Una ruta relativa vive dentro del worktree y se borra con él; una absoluta necesita un nombre
// propio y, por tanto, su propio drop.
function sqlitePaths(root, worktree, detected, slug) {
  const source = path.resolve(root, detected.base);
  if (!path.isAbsolute(detected.base)) {
    return { source, dest: path.resolve(worktree, detected.base), rewrite: null };
  }
  const { dir, name, ext } = path.parse(source);
  const dest = path.join(dir, `${name}_${slug.replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`);
  return { source, dest, rewrite: detected.binding.kind === 'url' ? `sqlite:${dest}` : dest };
}

function createSqlite(root, worktree, detected, slug) {
  const { source, dest, rewrite } = sqlitePaths(root, worktree, detected, slug);
  if (fs.existsSync(dest)) return { method: 'existing', created: false, name: dest, rewrite };
  if (!fs.existsSync(source)) throw new Error(`no hay nada que copiar: el fichero SQLite base no existe (${source})`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  return { method: 'copy', created: true, name: dest, rewrite };
}

// ── API ─────────────────────────────────────────────────────────────────────
export function inspectDb(root, envFile, override) {
  const detected = detectDb(root, loadProjectEnv(root, envFile), override);
  if (!detected) return null;
  return { detected, remote: isRemote(detected), hosts: dbHosts(detected) };
}

export async function createDb({ root, worktree, slug, envFile = '.env', override = {}, confirmRemote = false }) {
  const inspected = inspectDb(root, envFile, override);
  if (!inspected) return { engine: null, method: 'none', reason: 'el proyecto no declara ninguna BD' };
  const { detected } = inspected;

  if (inspected.remote && !confirmRemote) {
    return { engine: detected.engine, method: 'needs-confirmation', reason: 'remote-db', hosts: inspected.hosts, database: detected.base };
  }

  if (!detected.engine) {
    throw new Error(`se detectó una BD (${detected.source}) pero no se pudo deducir el motor: no hay ningún driver conocido (pg, mysql2, mongodb, better-sqlite3) en las dependencias. Indícalo con "db": {"engine": "pg|mysql|mongo|sqlite"} en .claude/worktree.json, o desactiva la provisión con "db": {"skip": true}`);
  }

  const info = `${detected.engine} (${detected.source}=${detected.binding.kind === 'url' ? '<url>' : detected.base})`;
  if (detected.engine === 'sqlite') {
    return { engine: 'sqlite', base: detected.base, binding: detected.binding, info, ...createSqlite(root, worktree, detected, slug) };
  }

  // Sin driver no se puede aislar, y continuar dejaría el .env apuntando a la base compartida:
  // el agente escribiría en la BD del usuario creyéndola suya. Se falla; la única salida es
  // explícita ("db": {"skip": true}).
  const driver = loadDriver(root, detected.engine);
  if (driver === undefined) {
    throw new Error(`el driver "${detected.engine}" no está instalado en el proyecto, así que la BD no se puede aislar. Instálalo o desactiva la provisión con "db": {"skip": true} en .claude/worktree.json`);
  }

  const name = cloneName(detected.base, slug);
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`Nombre de BD no seguro: ${name}`);
  if (name === detected.base) throw new Error('El nombre del clon coincide con la BD base: se aborta');

  const create = { pg: createPg, mysql: createMysql, mongo: createMongo }[detected.engine];
  const result = await create(driver, detected, name, { pgBin: override.pgBin });
  return { engine: detected.engine, base: detected.base, name, binding: detected.binding, info, ...result };
}

// Un borrado es irreversible y una detección equivocada podría apuntar a la BD real:
// las tres guardas son obligatorias y ninguna se puede saltar desde fuera.
export async function dropDb({ root, slug, entry, envFile = '.env', override = {} }) {
  if (!entry?.db) return { dropped: false, reason: 'no había BD registrada' };
  if (entry.dbCreated !== true) {
    return { dropped: false, reason: `la BD "${entry.db}" no fue creada por este skill: no se toca` };
  }

  const inspected = inspectDb(root, envFile, override);
  if (!inspected) return { dropped: false, reason: 'no se pudo detectar la BD base: se rechaza borrar' };
  const { detected } = inspected;

  if (detected.engine === 'sqlite') {
    if (!path.isAbsolute(entry.db)) return { dropped: false, reason: 'el fichero SQLite vive en el worktree y se borra con él' };
    const { dest } = sqlitePaths(root, root, detected, slug);
    if (entry.db !== dest || dest === path.resolve(root, detected.base)) {
      return { dropped: false, reason: 'la ruta SQLite registrada no es la esperada para este slug' };
    }
    fs.rmSync(dest, { force: true });
    return { dropped: true, name: dest };
  }

  const expected = cloneName(detected.base, slug);
  if (entry.db === detected.base) return { dropped: false, reason: 'coincide con la BD base del proyecto: se rechaza borrar' };
  if (entry.db !== expected) return { dropped: false, reason: `"${entry.db}" no casa con el nombre esperado "${expected}"` };
  if (!SAFE_IDENTIFIER.test(entry.db)) return { dropped: false, reason: 'nombre de BD no seguro' };

  const driver = loadDriver(root, detected.engine);
  if (!driver) return { dropped: false, reason: `el driver "${detected.engine}" no está instalado` };
  await { pg: dropPg, mysql: dropMysql, mongo: dropMongo }[detected.engine](driver, detected, entry.db);
  return { dropped: true, name: entry.db };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const action = process.argv[2];
  const root = path.resolve(arg('project') ?? process.cwd());
  const slug = arg('slug');
  const config = loadConfig(root);
  const common = { root, slug, envFile: config.envFile ?? '.env', override: config.db ?? {} };

  if (action === 'create') {
    const result = await createDb({ ...common, worktree: path.resolve(arg('worktree') ?? root), confirmRemote: process.argv.includes('--confirm-remote') });
    console.log(JSON.stringify(result));
  } else if (action === 'drop') {
    console.log(JSON.stringify(await dropDb({ ...common, entry: JSON.parse(arg('entry') ?? 'null') })));
  } else {
    console.error('Uso: db.mjs create|drop --project <raíz> --worktree <dir> --slug <slug> [--confirm-remote] [--entry <json>]');
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[db] ERROR: ${error.message}`);
    process.exit(1);
  });
}
