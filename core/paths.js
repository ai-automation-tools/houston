// One spelling for every Windows path the Core compares. Policy matches grants against
// these, and the runner will compile grants from them, so two spellings of one file can
// never get two answers.
//
// The rule is to refuse what is ambiguous rather than guess: a path that could name a
// different file than it appears to (8.3 short names, alternate data streams, device
// names, trailing dots or spaces, network shares) is an error, and the caller denies.

import fs from 'node:fs';

export class PathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

// CON, NUL, COM1 and the rest open a device in any folder, with any extension.
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// An 8.3 alias such as PROGRA~1 or SSHKEY~2.TXT. ponytail: a real long name of that exact
// shape is refused too; resolvePath() expands the aliases that exist.
const SHORT = /^[^~.]{1,6}~[0-9]{1,6}(\.[^.]{1,3})?$/;

/**
 * @param {string} input an absolute Windows path, with either slash
 * @param {{ pattern?: boolean, allowShort?: boolean }} [opts] `pattern` lets `*` through for grant patterns
 * @returns {string} drive letter upper case, forward slashes, no `.` or `..`, no trailing slash
 *   except on a drive root (`C:/`). Compare with `pathKey`, which also folds case.
 * @throws {PathError}
 */
export function canonicalPath(input, { pattern = false, allowShort = false } = {}) {
  if (typeof input !== 'string' || input.trim() === '') throw new PathError('the path is empty');
  if (/[\0-\x1f]/.test(input)) throw new PathError('the path has a control character');
  let p = input.replace(/\\/g, '/');
  if (p.startsWith('//?/') || p.startsWith('//./')) {
    p = p.slice(4);
    if (!/^[a-z]:(\/|$)/i.test(p)) throw new PathError('device and volume paths are refused');
  }
  if (p.startsWith('//')) throw new PathError('network paths are refused');
  const drive = /^([a-z]):(\/|$)/i.exec(p);
  if (!drive) throw new PathError('the path is not absolute');

  /** @type {string[]} */
  const out = [];
  for (const seg of p.slice(2).split('/')) {
    if (seg === '' || seg === '.') continue;
    // Windows stops `..` at the drive root, and so does this.
    if (seg === '..') { out.pop(); continue; }
    if (seg.includes(':')) throw new PathError('alternate data streams are refused');
    if (/[<>"|?]/.test(seg) || (!pattern && seg.includes('*'))) throw new PathError('the path has a wildcard or a character Windows forbids');
    if (/[ .]$/.test(seg)) throw new PathError('a name ending in a dot or a space is refused');
    if (RESERVED.test(seg)) throw new PathError('device names are refused');
    if (!allowShort && SHORT.test(seg)) throw new PathError('8.3 short names are refused');
    out.push(seg);
  }
  return `${drive[1].toUpperCase()}:/${out.join('/')}`;
}

/** The comparison key: canonical, then case folded, as NTFS compares by default. @param {string} input */
export const pathKey = (input) => canonicalPath(input).toLowerCase();

/**
 * Like canonicalPath, but follows the disk: junctions, symlinks, `subst` drives and 8.3
 * aliases are resolved for the part of the path that exists. Use it on any path an agent
 * hands over. The part that does not exist yet is checked lexically.
 *
 * @param {string} input
 * @returns {string}
 * @throws {PathError} for a refused path; other fs errors (EPERM) are thrown as they are
 */
export function resolvePath(input) {
  const parts = canonicalPath(input, { allowShort: true }).split('/');
  /** @type {string[]} */
  const tail = [];
  while (parts.length) {
    const at = parts.length === 1 ? `${parts[0]}/` : parts.join('/');
    try {
      return canonicalPath([fs.realpathSync.native(at), ...tail].join('/'));
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      tail.unshift(/** @type {string} */ (parts.pop()));
    }
  }
  return canonicalPath(input);
}
