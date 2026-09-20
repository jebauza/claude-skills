#!/usr/bin/env node
// Uso: node verify.mjs [--dir <path>]
// Ejecuta solo las comprobaciones que el proyecto define (test, lint, typecheck), derivadas
// de package.json. Un proyecto JS corre test y lint; uno TypeScript añade tipos.
import path from 'node:path';
import { detectVerify } from './lib/detect.mjs';
import { runShell } from './lib/fsx.mjs';

const index = process.argv.indexOf('--dir');
const dir = path.resolve(index > 0 ? process.argv[index + 1] : process.cwd());

const steps = detectVerify(dir);
if (steps.length === 0) {
  console.log('verify: el proyecto no define test, lint ni typecheck; no hay nada que ejecutar.');
  process.exit(0);
}

const results = [];
for (const step of steps) {
  console.log(`\n── ${step.name}: ${step.command}`);
  const status = runShell(step.command, { cwd: dir, quiet: false });
  results.push({ ...step, ok: status === 0 });
}

console.log('\n── resumen');
for (const { name, ok } of results) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
