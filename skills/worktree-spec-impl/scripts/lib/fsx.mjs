// Utilidades de sistema de ficheros y procesos, portables (Linux, macOS, Windows).
// Sustituyen a jq, sed, mktemp, cp -al y cmp de la versión Bash: Node es el único runtime
// garantizado en una máquina que abre un proyecto Node.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// stdout queda reservado para el JSON de resultado: todo el log va a stderr.
export const log = (...args) => console.error(...args);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`No se pudo leer ${file}: ${error.message}`);
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Escritura atómica: en el mismo directorio para que el rename no cruce de volumen.
// En Windows el rename puede fallar un instante si un antivirus tiene el destino abierto.
export function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        fs.rmSync(tmp, { force: true });
        throw error;
      }
      sleepSync(50 * (attempt + 1));
    }
  }
}

export function rmWithRetry(target) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      sleepSync(200 * (attempt + 1));
    }
  }
}

// ── .env ────────────────────────────────────────────────────────────────────
export function parseEnv(text) {
  const map = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    map[match[1]] = value;
  }
  return map;
}

export function readEnv(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

// Conserva el fin de línea del fichero (CRLF/LF) para no ensuciar el diff en Windows.
export function setEnvVar(file, name, value) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = new RegExp(`^(\\s*(?:export\\s+)?)${name}\\s*=.*$`, 'm');
  const next = line.test(text)
    ? text.replace(line, (_, prefix) => `${prefix}${name}=${value}`)
    : `${text}${text.endsWith('\n') || text === '' ? '' : eol}${name}=${value}${eol}`;
  writeAtomic(file, next);
  return true;
}

// ── Puertos ─────────────────────────────────────────────────────────────────
// Sondear con un bind real es más fiable que parsear `ss`/`netstat`, que no son portables.
export function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

// ── Procesos ────────────────────────────────────────────────────────────────
// `shell: true` es necesario en Windows, donde npm/pnpm/yarn son .cmd. Se pasa una línea
// completa (no args[]) para no depender de DEP0190.
export function runShell(commandLine, { cwd, env, quiet = true } = {}) {
  const result = spawnSync(commandLine, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    stdio: ['ignore', quiet ? 2 : 1, 2],
  });
  return result.status ?? 1;
}

export function git(args, { cwd } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

// ── node_modules por hardlinks ──────────────────────────────────────────────
export class HardlinkUnsupported extends Error {}

function copyTarget(resolved, dest) {
  fs.cpSync(resolved, dest, { recursive: true, dereference: true });
}

// Clona un árbol con hardlinks: instantáneo y sin coste de disco, pero con árbol de
// directorios propio. npm reemplaza ficheros en vez de editarlos in-place, así que un
// `npm install` en un worktree no muta el node_modules de los demás.
export function linkTree(src, dest, stats = { files: 0, symlinks: 0, copiedSymlinks: 0 }) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      linkTree(from, to, stats);
    } else if (entry.isSymbolicLink()) {
      stats.symlinks++;
      const target = fs.readlinkSync(from);
      try {
        // Los symlinks exigen Developer Mode en Windows: si falla, se copia el destino.
        const resolved = path.resolve(path.dirname(from), target);
        const isDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
        fs.symlinkSync(target, to, isDir ? 'junction' : 'file');
      } catch {
        try {
          copyTarget(path.resolve(path.dirname(from), target), to);
          stats.copiedSymlinks++;
        } catch {
          // Symlink roto en origen: no hay nada que clonar.
        }
      }
    } else {
      try {
        fs.linkSync(from, to);
        stats.files++;
      } catch (error) {
        // EXDEV = otro volumen; EPERM/ENOTSUP = el sistema de ficheros no admite hardlinks.
        // Es un fallo global, no de un fichero: el llamador cae al gestor de paquetes.
        if (['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(error.code)) {
          throw new HardlinkUnsupported(error.code);
        }
        throw error;
      }
    }
  }
  return stats;
}
