// Registro de worktrees: única fuente de verdad de qué slug tiene qué puerto y qué BD.
// Todo read-modify-write va bajo un lock de fichero: dos agentes pueden arrancar en el mismo
// segundo y, sin él, elegirían el mismo puerto libre.
import fs from 'node:fs';
import path from 'node:path';
import { canListen, git, readJson, sleepSync, writeAtomic } from './fsx.mjs';

// Raíz del checkout principal, también cuando se invoca desde dentro de un worktree
// (`--show-toplevel` devolvería la raíz del worktree, no la del principal).
export function mainRoot(cwd = process.cwd()) {
  const { status, stdout, stderr } = git(['worktree', 'list', '--porcelain'], { cwd });
  if (status !== 0) throw new Error(`No es un repositorio git: ${stderr}`);
  const first = stdout.split(/\r?\n/).find((line) => line.startsWith('worktree '));
  return path.resolve(first.slice('worktree '.length));
}

export function paths(root) {
  const dir = path.join(root, '.trees');
  return { dir, file: path.join(dir, 'registry.json'), lock: path.join(dir, '.registry.lock') };
}

const STALE_LOCK_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// `wx` (O_EXCL) es atómico en Linux, macOS y Windows: no hace falta flock.
function acquire(lockFile) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, `${process.pid}:${Date.now()}`);
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // Lock huérfano (proceso muerto o muy viejo): se retira solo si sigue siendo el mismo
    // que se juzgó obsoleto, para no borrar el lock recién tomado por otro agente.
    try {
      const content = fs.readFileSync(lockFile, 'utf8');
      const [pid, taken] = content.split(':').map(Number);
      if (Date.now() - taken > STALE_LOCK_MS || !isAlive(pid)) {
        if (fs.readFileSync(lockFile, 'utf8') === content) fs.rmSync(lockFile, { force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Timeout esperando el lock del registro: ${lockFile}`);
    sleepSync(40);
  }
}

export function withLock(root, fn) {
  const { dir, lock } = paths(root);
  fs.mkdirSync(dir, { recursive: true });
  acquire(lock);
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function read(root) {
  return readJson(paths(root).file, {});
}

function write(root, data) {
  writeAtomic(paths(root).file, `${JSON.stringify(data, null, 2)}\n`);
}

export function get(root, slug) {
  return read(root)[slug] ?? null;
}

export function update(root, slug, patch) {
  return withLock(root, () => {
    const data = read(root);
    if (!data[slug]) throw new Error(`"${slug}" no está en el registro`);
    data[slug] = { ...data[slug], ...patch };
    write(root, data);
    return data[slug];
  });
}

export function release(root, slug) {
  withLock(root, () => {
    const data = read(root);
    delete data[slug];
    write(root, data);
  });
}

// Idempotente: si el slug ya tiene entrada devuelve la existente. Re-ejecutar el bootstrap
// sobre un worktree vivo no debe cambiarle el puerto.
// Una sola sección crítica: el sondeo de puertos ocurre con el lock tomado, así que dos
// agentes no pueden decidir el mismo puerto libre.
export async function allocate(root, slug, basePort, baseBranch) {
  const { dir, lock } = paths(root);
  fs.mkdirSync(dir, { recursive: true });
  acquire(lock);
  try {
    const data = read(root);
    if (data[slug]) {
      // Una entrada anterior a la rama base la adquiere aquí; una que ya la tiene no se toca.
      if (!data[slug].base && baseBranch) {
        data[slug] = { ...data[slug], base: baseBranch };
        write(root, data);
      }
      return data[slug];
    }
    // basePort null = el proyecto no tiene puerto que aislar; el slug se registra igualmente
    // para que la Fase 0 y el teardown lo vean.
    let port = null;
    if (basePort != null) {
      const taken = new Set(Object.values(data).map((entry) => entry.port));
      port = basePort + 1;
      while (taken.has(port) || !(await canListen(port))) port++;
    }
    data[slug] = { branch: slug, base: baseBranch ?? null, port, created: new Date().toISOString() };
    write(root, data);
    return data[slug];
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
