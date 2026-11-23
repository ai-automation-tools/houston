// The Core's half of the health screen and the diagnostics bundle (H7): the audit chain checked
// again now, the size of each folder the Core writes, and the newest lines of core.log run
// through the vault's redaction. Reads only; nothing here changes a file.

import fs from 'node:fs';
import path from 'node:path';

/** The folders under the data folder the health screen sizes, besides the total. */
export const FOLDERS = ['audit', 'transcripts', 'backups'];
/** At most this many core.log lines go out. */
export const MAX_LOG_LINES = 200;

/**
 * Bytes in `dir` and every folder under it; 0 when it doesn't exist. Links aren't followed.
 * @param {string} dir
 */
export function folderBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += folderBytes(p);
    else if (e.isFile()) total += fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

/**
 * The newest `n` lines of a text file, reading at most its last 256 KB.
 * @param {string} file @param {number} n
 * @returns {string[]}
 */
export function tailLines(file, n) {
  if (n <= 0) return [];
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
    // A cut first line is a fragment: drop it unless the read started at the top of the file.
    return (len < size ? lines.slice(1) : lines).slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * `core.health`: what the window's health screen and diagnostics bundle need from the Core.
 * ponytail: the chain check reads every audit segment on each call; fine at the 5 GB log
 * target, cache it by segment if the screen ever polls.
 * @param {{ dir: string, audit: { verify: () => { events: number, breaks: { segment: string, line: number, reason: string }[] } }, redact?: (text: string) => string }} core
 * @param {{ log?: unknown }} [p] log: how many core.log lines to return (0 to MAX_LOG_LINES)
 */
export function coreHealth({ dir, audit, redact = (t) => t }, p = {}) {
  const { events, breaks } = audit.verify();
  const n = Number.isInteger(p.log) ? Math.min(Math.max(/** @type {number} */ (p.log), 0), MAX_LOG_LINES) : 0;
  return {
    audit: { events, breaks: breaks.length, firstBreak: breaks[0] ?? null },
    storage: { ...Object.fromEntries(FOLDERS.map((f) => [f, folderBytes(path.join(dir, f))])), total: folderBytes(dir) },
    log: tailLines(path.join(dir, 'core.log'), n).map((l) => redact(l)),
  };
}
