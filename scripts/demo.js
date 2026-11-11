// `npm run demo`: build the GitHub Pages demo into `_site/` (git-ignored). The
// shell UI from src/renderer and src/shared, xterm from node_modules, and src/demo,
// which stands in for the preload. Every path in the page is relative, so it serves
// from any subpath. Preview with any static server, e.g. `python -m http.server -d _site`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoHtml } from '../src/demo/page.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');

fs.rmSync(out, { recursive: true, force: true });
/** @type {[string, string][]} */
const copies = [
  ['src/renderer', ''],
  ['src/shared', 'shared'],
  ['src/demo', 'demo'],
  ['node_modules/@xterm/xterm/css', 'vendor/xterm/css'],
  ['node_modules/@xterm/xterm/lib', 'vendor/xterm/lib'],
  ['node_modules/@xterm/addon-fit/lib', 'vendor/addon-fit/lib'],
  ['node_modules/@xterm/addon-search/lib', 'vendor/addon-search/lib'],
];
for (const [from, to] of copies) fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });

const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
fs.writeFileSync(path.join(out, 'index.html'), demoHtml(html));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('demo built in _site/');
