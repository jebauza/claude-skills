#!/usr/bin/env node
// Uso: node base.mjs <slug>
// Estado de la rama base de un worktree, calculado y no supuesto. Solo lectura; funciona igual
// desde el worktree que desde el checkout principal. NO hace fetch: la Fase 5 lo hace antes.
import { git } from './lib/fsx.mjs';
import * as registry from './lib/registry.mjs';

const slug = process.argv[2];
if (!slug) {
  console.error('Uso: base.mjs <slug>');
  process.exit(2);
}

const root = registry.mainRoot();
const entry = registry.get(root, slug);
if (!entry) {
  console.error(`[base] "${slug}" no está en el registro (.trees/registry.json).`);
  process.exit(1);
}
if (!entry.base) {
  console.error(`[base] "${slug}" no tiene rama base registrada (worktree creado antes de que se guardara). Indica la base a mano.`);
  process.exit(1);
}

const { base, branch } = entry;
const ok = (args) => git(args, { cwd: root }).status === 0;
const out = (args) => git(args, { cwd: root }).stdout;

const baseExists = ok(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
const primaryBranch = out(['branch', '--show-current']) || null;
const state = { slug, base, baseExists, primaryBranch, baseActiveInPrimary: primaryBranch === base };

if (baseExists && ok(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
  state.containsBase = ok(['merge-base', '--is-ancestor', base, branch]);
  // rev-list --left-right --count base...branch → "<solo en base>\t<solo en la rama>"
  const [behind, ahead] = out(['rev-list', '--left-right', '--count', `${base}...${branch}`]).split(/\s+/).map(Number);
  Object.assign(state, { ahead, behind });
}

// El remoto que sigue la base: su upstream configurado, o origin/<base> si existe.
const upstream = out(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${base}@{upstream}`]);
const remoteRef = upstream || (ok(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]) ? `origin/${base}` : null);
state.originAhead = baseExists && remoteRef ? Number(out(['rev-list', '--count', `${base}..${remoteRef}`])) : null;
state.remote = remoteRef;

console.log(JSON.stringify(state));
