// The Core's entry point: `node core/main.js` (or `npm run core`).
// It takes the single-instance lock, brings the database up to date, opens the audit log,
// ends what a dead Core left running, and serves the Control API until it is stopped.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from './audit.js';
import { CoreLockedError, migrate, openDb } from './db.js';
import { startControl } from './control.js';
import { createRunner, markInterrupted } from './runner.js';

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
 * Make the data folder the operator's alone: inherited entries removed, full control for the
 * operator and SYSTEM. The Control API's token is in it, so this is what keeps the API
 * operator-only. Inherited entries can name other local accounts: on the dev machine a
 * CodexSandboxUsers group could read %LOCALAPPDATA% (2026-11-12). Entries set directly on a
 * folder the operator chose (HOUSTON_CORE_DATA) are kept: someone put them there on purpose.
 *
 * @param {string} dir
 * @throws {Error} when the folder can't be restricted
 */
export function secureDir(dir) {
  if (process.platform !== 'win32') return fs.chmodSync(dir, 0o700);
  const sys32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const who = spawnSync(path.join(sys32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = /"(S-1-[\d-]+)"/.exec(who.stdout ?? '')?.[1];
  if (!sid) throw new Error(`could not read the operator's SID: ${who.error?.message ?? who.stderr}`);
  const r = spawnSync(path.join(sys32, 'icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`could not restrict ${dir} to the operator: ${r.error?.message ?? (r.stdout + r.stderr).trim()}`);
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
  secureDir(dir);
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

/**
 * Where session temp folders go. A session can't have its temp folder in the user profile
 * (the profile is denied), so not next to the data folder.
 * ponytail: ProgramData is readable by other local accounts; fine for one operator, tighten its ACL if that changes.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function sessionTemp(env = process.env) {
  const set = env.HOUSTON_SESSION_TEMP?.trim();
  if (set) {
    if (!path.isAbsolute(set)) throw new Error('HOUSTON_SESSION_TEMP must be an absolute path');
    return path.resolve(set);
  }
  return path.join(env.ProgramData ?? 'C:\\ProgramData', 'houston-core', 'sessions');
}

if (import.meta.main) {
  try {
    const core = start();
    for (const b of core.audit.newBreaks) console.error(`audit chain break: ${b.segment} line ${b.line}: ${b.reason}`);
    const runner = createRunner({ db: core.db, audit: core.audit, coreDir: core.dir, tempRoot: sessionTemp() });
    const control = await startControl({ dir: core.dir, runner, audit: core.audit });
    console.log(JSON.stringify({ event: 'core.start', pid: process.pid, dir: core.dir, schema: core.schema, auditBreaks: core.audit.breaks.length, interrupted: core.interrupted.length, pipe: control.pipe }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await runner.stopAll();
      await control.close();
      core.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(e instanceof CoreLockedError ? 2 : 1);
  }
}
