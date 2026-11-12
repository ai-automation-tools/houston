// `npm run lint`: syntax-check every JavaScript file in the repo with `node --check`.
// No linter dependency on purpose (see AGENTS.md); swap in ESLint only through the roadmap.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'core', 'scripts', 'tests'];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(c|m)?js$/.test(e.name) ? [p] : [];
  });
}

const files = DIRS.flatMap((d) => walk(path.join(root, d)));
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✖ ${path.relative(root, f)}\n${r.stderr.trim()}\n`);
  }
}
console.log(`${files.length - failed}/${files.length} files pass node --check`);
process.exit(failed ? 1 : 0);
