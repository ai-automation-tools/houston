// The Core's SQLite database: open it, hold it, bring its schema up to date.
// node:sqlite is built into Node 24, so this adds no dependency.

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

/** Another process holds the database, which means a Core is already running. */
export class CoreLockedError extends Error {
  /** @param {string} file */
  constructor(file) {
    super(`${file} is locked by another process: the Core is already running`);
    this.name = 'CoreLockedError';
  }
}

/**
 * Open the database and keep it to this process until `close()`.
 *
 * The exclusive lock is the single-instance lock. SQLite takes it on the first write and
 * the operating system drops it when the process ends, so a crash leaves nothing stale
 * behind the way a PID file would.
 *
 * @param {string} file An absolute path, or ':memory:' in tests.
 * @returns {DatabaseSync}
 * @throws {CoreLockedError} when another process holds it
 */
export function openDb(file) {
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    db.exec('BEGIN IMMEDIATE; COMMIT;');
  } catch (e) {
    db.close();
    // 5 is SQLITE_BUSY; the low byte survives extended codes such as SQLITE_BUSY_RECOVERY.
    if ((/** @type {any} */ (e).errcode & 0xff) === 5) throw new CoreLockedError(file);
    throw e;
  }
  return db;
}

/**
 * Apply every migration the database has not had. `PRAGMA user_version` is the schema
 * version, and each step commits with its version bump or not at all.
 *
 * @param {DatabaseSync} db
 * @param {string[]} [migrations]
 * @returns {{ from: number, to: number }}
 */
export function migrate(db, migrations = MIGRATIONS) {
  const from = Number(/** @type {any} */ (db.prepare('PRAGMA user_version').get()).user_version);
  const to = migrations.length;
  // An older Core must not write to a schema it does not know.
  if (from > to) throw new Error(`the database is schema v${from} and this Core knows v${to}; update the Core`);
  for (let v = from; v < to; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration to schema v${v + 1} failed: ${/** @type {Error} */ (e).message}`, { cause: e });
    }
  }
  return { from, to };
}
