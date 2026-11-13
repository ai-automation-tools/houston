// The toolchain folders a contained session gets on its PATH (main process only: it uses
// node:path, so the browser demo never loads it).

import path from 'node:path';

/**
 * The operator's PATH folders a contained session may search, after the Windows ones the Core
 * puts first: absolute, outside the users folder (denied to every session) and outside the
 * Windows folder (already there). Adding a folder to PATH grants nothing: the container still
 * reads only what its policy allows, and Windows' program folders are readable to it already.
 *
 * @param {string} PATH
 * @param {{ home: string, systemRoot: string }} where
 * @returns {string[]}
 */
export function toolchainPath(PATH, { home, systemRoot }) {
  const w = path.win32;
  const key = (/** @type {string} */ p) => w.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  const users = key(w.dirname(home));
  const sys = key(systemRoot);
  const under = (/** @type {string} */ k, /** @type {string} */ parent) => k === parent || k.startsWith(`${parent}\\`);
  const seen = new Set();
  return PATH.split(';').map((p) => p.trim()).filter((p) => {
    // A drive-absolute path only: not relative, not \\server, no variables left unexpanded.
    if (!/^[A-Za-z]:[\\/]/.test(p) || /[%"]/.test(p)) return false;
    const k = key(p);
    if (under(k, users) || under(k, sys) || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((p) => w.normalize(p).replace(/[\\/]+$/, ''));
}
