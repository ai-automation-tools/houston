// The Core's entry point: `node core/main.js` (or `npm run core`).
// It takes the single-instance lock, brings the database up to date, opens the audit log,
// ends what a dead Core left running, and serves the Control API until it is stopped.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovals } from './approvals.js';
import { openAudit } from './audit.js';
import { dataDir } from './client.js';
import { CoreLockedError, migrate, openDb } from './db.js';
import { startControl } from './control.js';
import { createRegistry, ensureOperator } from './identities.js';
import { globalDenies } from './policy.js';
import { createRunner, markInterrupted } from './runner.js';
import { createTranscripts } from './transcripts.js';

export { dataDir };

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
  // Its long, final spelling: the path rules refuse 8.3 names like C:\Users\RUNNER~1, which TEMP can hold.
  dir = fs.realpathSync.native(dir);
  secureDir(dir);
  const db = openDb(path.join(dir, 'core.db'));
  try {
    const schema = migrate(db);
    // After the lock on purpose: the log has one writer because the database has one owner.
    const audit = openAudit(path.join(dir, 'audit'));
    audit.system('core.start');
    // Sessions a dead Core left open: end any container still running, close the record (AT-16).
    // The operator owns every other identity, so it exists from the first start.
    ensureOperator(db, audit);
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

/**
 * Where each backend identity's CLI home goes (core/backends.js): beside the data folder, so
 * in the profile, which only that identity's own sessions are granted a folder of. Restricted
 * to the operator like the data folder; it holds each identity's sign-in.
 * @param {string} dir the data folder
 * @returns {string}
 */
export function agentsRoot(dir) {
  const root = path.join(path.dirname(dir), 'houston-agents');
  fs.mkdirSync(root, { recursive: true });
  secureDir(root);
  return root;
}

/**
 * Append one line to <data>/core.log. A Core started hidden at logon has no console, so this
 * is where its start line and a failure to start can be read.
 * ponytail: a line per start; cap it with the log limits (H7).
 * @param {string} dir @param {object} entry
 */
function logLine(dir, entry) {
  try { fs.appendFileSync(path.join(dir, 'core.log'), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`); } catch { /* nowhere better to say it */ }
}

if (import.meta.main) {
  /** @type {string | undefined} */
  let dir;
  try {
    dir = dataDir();
    const core = start(dir);
    for (const b of core.audit.newBreaks) {
      console.error(`audit chain break: ${b.segment} line ${b.line}: ${b.reason}`);
      logLine(core.dir, { event: 'audit.break', ...b });
    }
    // Sessions are Windows containers, so elsewhere (CI on Linux) the Core only holds its lock.
    const win32 = process.platform === 'win32';
    const approvals = createApprovals({ audit: core.audit });
    const runner = win32 ? createRunner({ db: core.db, audit: core.audit, coreDir: core.dir, tempRoot: sessionTemp(), agentsRoot: agentsRoot(core.dir), approvals }) : null;
    const transcripts = runner ? createTranscripts({ dir: path.join(core.dir, 'transcripts'), audit: core.audit }) : undefined;
    const control = runner ? await startControl({
      dir: core.dir, runner, audit: core.audit, schema: core.schema.to, approvals, transcripts,
      // The same globals the runner uses, so both record the same policy version.
      registry: createRegistry({ db: core.db, audit: core.audit, globals: globalDenies({ home: os.homedir(), coreDir: core.dir }) }),
    }) : null;
    if (!control) setInterval(() => {}, 2 ** 30);
    const line = { event: 'core.start', pid: process.pid, dir: core.dir, schema: core.schema, auditBreaks: core.audit.breaks.length, interrupted: core.interrupted.length, pipe: control?.pipe ?? null };
    console.log(JSON.stringify(line));
    logLine(core.dir, line);
    let stopping = false;
    const stop = async (/** @type {string} */ why) => {
      if (stopping) return;
      stopping = true;
      await runner?.stopAll();
      await control?.close();
      core.close();
      logLine(core.dir, { event: 'core.stop', pid: process.pid, why });
      process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    // Started by a Scheduled Task under conhost, ending the task kills conhost but not the Core,
    // so with this flag the Core stops (sessions first) once the process that started it is gone.
    // ponytail: checks the parent's pid only; a pid reused within 2 s would keep the Core up.
    if (process.argv.includes('--exit-with-parent')) {
      const parent = process.ppid;
      setInterval(() => {
        try { process.kill(parent, 0); } catch (e) { if (/** @type {any} */ (e).code === 'ESRCH') void stop('its parent process ended'); }
      }, 2000).unref();
    }
  } catch (e) {
    const message = /** @type {Error} */ (e).message;
    console.error(message);
    if (dir && fs.existsSync(dir)) logLine(dir, { event: 'core.error', pid: process.pid, error: message, alreadyRunning: e instanceof CoreLockedError });
    process.exit(e instanceof CoreLockedError ? 2 : 1);
  }
}
