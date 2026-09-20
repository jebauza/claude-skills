#!/usr/bin/env node
// Uso: node teardown.mjs <slug>
// Revierte lo que hizo bootstrap: pasos de teardown, BD propia, worktree y registro.
// Se ejecuta desde el checkout principal.
import fs from 'node:fs';
import path from 'node:path';
import { dropDb } from './db.mjs';
import { loadConfig } from './lib/detect.mjs';
import { git, log, rmWithRetry, runShell, sleepSync } from './lib/fsx.mjs';
import * as registry from './lib/registry.mjs';

const slug = process.argv[2];
if (!slug) {
  console.error('Uso: teardown.mjs <slug>');
  process.exit(2);
}

const root = registry.mainRoot();
const worktree = path.join(root, '.trees', slug);
const config = loadConfig(root);

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

if (fs.existsSync(worktree) && inside(fs.realpathSync(worktree), fs.realpathSync(process.cwd()))) {
  log('[teardown] ERROR: no se puede eliminar el worktree en el que estás. Ejecuta desde el checkout principal.');
  process.exit(1);
}

const entry = registry.get(root, slug);
const env = { WT_SLUG: slug, WT_PATH: worktree, WT_PORT: String(entry?.port ?? ''), WT_DB: entry?.db ?? '' };
const report = { slug, db: null, worktreeRemoved: false };

for (const step of config.teardown ?? []) {
  log(`[teardown] ${step}`);
  if (runShell(step, { cwd: root, env }) !== 0) log(`[teardown] AVISO: falló "${step}", se continúa con la limpieza`);
}

// El registro y el worktree se limpian aunque la BD se rechace: el rechazo de las guardas es
// un resultado esperable y no debe dejar un worktree huérfano.
try {
  report.db = await dropDb({ root, slug, entry, envFile: config.envFile ?? '.env', override: config.db ?? {} });
  log(report.db.dropped ? `[teardown] BD eliminada: ${report.db.name}` : `[teardown] BD conservada: ${report.db.reason}`);
} catch (error) {
  report.db = { dropped: false, reason: error.message };
  log(`[teardown] AVISO: no se pudo borrar la BD (${error.message}); revísala a mano`);
}

if (fs.existsSync(worktree)) {
  // --force: el worktree contiene node_modules y .env, que git ve como untracked/ignored.
  // El trabajo commiteado vive en la rama, que no se borra.
  let removed = false;
  for (let attempt = 0; attempt < 4 && !removed; attempt++) {
    removed = git(['worktree', 'remove', '--force', worktree], { cwd: root }).status === 0;
    if (!removed) sleepSync(400 * (attempt + 1)); // Windows: un proceso o antivirus puede tener ficheros abiertos
  }
  if (!removed) {
    try {
      rmWithRetry(worktree);
      git(['worktree', 'prune'], { cwd: root });
      removed = true;
    } catch (error) {
      log(`[teardown] ERROR: no se pudo borrar ${worktree} (${error.code ?? error.message}). Cierra los procesos que lo usen (servidor, editor, terminal) y repite.`);
      process.exit(1);
    }
  }
  report.worktreeRemoved = removed;
  log('[teardown] worktree eliminado');
}

registry.release(root, slug);
log(`[teardown] registro liberado (puerto ${entry?.port ?? 'n/a'})`);
console.log(JSON.stringify(report));
