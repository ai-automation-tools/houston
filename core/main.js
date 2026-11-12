// The Core's entry point: `node core/main.js` (or `npm run core`).
// Today it takes the single-instance lock, brings the database up to date, opens the
// audit log and waits. Policy, the runner and the Control API attach here as H1 goes on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from './audit.js';
import { CoreLockedError, migrate, openDb } from './db.js';
import { markInterrupted } from './runner.js';

/**
 * Where the Core keeps its state. Under the user profile on purpose: a session
 * container is denied the profile, so it cannot read this folder (abuse test AT-01).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function dataDir(env = process.env) {
  const set = env.HOUSTON_CORE_DATA?.trim();
  if (set) {
    if (!path.isAbsolute(set)) throw new Error('HOUSTON_CORE_DATA must be an absolute path');
    return path.resolve(set);
  }
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'houston-core');
  return path.join(os.homedir(), '.houston-core');
}

/**
 * Start the Core in `dir`.
 *
 * @param {string} [dir]
 * @returns {{ dir: string, db: import('node:sqlite').DatabaseSync, schema: { from: number, to: number }, audit: ReturnType<typeof openAudit>, interrupted: string[], close: () => void }}
 * @throws {import('./db.js').CoreLockedError} when a Core already runs on `dir`
 */
export function start(dir = dataDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const db = openDb(path.join(dir, 'core.db'));
  try {
    const schema = migrate(db);
    // After the lock on purpose: the log has one writer because the database has one owner.
    const audit = openAudit(path.join(dir, 'audit'));
    audit.system('core.start');
    // Sessions a dead Core left open: end any container still running, close the record (AT-16).
    const interrupted = markInterrupted(db, audit);
    return { dir, db, schema, audit, interrupted, close: () => { audit.system('core.stop'); audit.close(); db.close(); } };
  } catch (e) {
    db.close();
    throw e;
  }
}

if (import.meta.main) {
  try {
    const core = start();
    for (const b of core.audit.newBreaks) console.error(`audit chain break: ${b.segment} line ${b.line}: ${b.reason}`);
    console.log(JSON.stringify({ event: 'core.start', pid: process.pid, dir: core.dir, schema: core.schema, auditBreaks: core.audit.breaks.length, interrupted: core.interrupted.length }));
    const stop = () => { core.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // Nothing listens yet, so hold the process (and the lock) open. The Control API's pipe replaces this.
    setInterval(() => {}, 2 ** 30);
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(e instanceof CoreLockedError ? 2 : 1);
  }
}
