// Standing grants (H4, CORE-15): the operator's leave for one identity to run one command in one
// folder with nobody watching. A scheduled task (Cronsole's) uses one through
// `harness run --grant <id>` (harness.js); ADR-004: Cronsole owns the schedule, and the Core
// checks the standing grant at every run.
//
// One names the identity, the folder, the command (or, for a backend identity such as Claude Code,
// a prompt its headless start runs) and its program folders, a budget (the minutes
// a run may take before its container is ended) and an expiry, and holds the hash of the
// identity's grants when the operator approved it. A run is refused while it is paused, once it
// is revoked or expired, once the identity's grants differ from what was approved (the operator
// re-approves with update), and while another run under it is live. The session is unattended,
// so every `ask` is a deny. Only the Control API makes or changes one, and only the operator
// holds its token. Stop All pauses every active one (SEC-10); resume brings one back.

import crypto from 'node:crypto';
import { canonical } from './audit.js';
import { BACKENDS } from './backends.js';
import { OPERATOR } from './identities.js';
import { PathError, canonicalPath, resolvePath } from './paths.js';
import { RunnerError } from './runner.js';

export class StandingError extends Error {
  /** @param {string} code bad_request | not_found | conflict | paused | revoked | expired | changed | overlap | refused @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'StandingError';
    this.code = code;
  }
}

/** A standing grant's id: what a task's command line names. */
export const STANDING_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const YEAR = 366 * 24 * 60 * 60_000;
const win = (/** @type {string} */ p) => p.replaceAll('/', '\\');

/**
 * The identity's grants as they decide what it may do: resource, permission, effect, expiry.
 * Order and grant ids don't count, so removing a grant and adding it back changes nothing.
 * @param {import('node:sqlite').DatabaseSync} db @param {string} identity
 */
export function grantsHash(db, identity) {
  const rows = db.prepare('SELECT resource, permission, effect, expires_at FROM grants WHERE identity_id = ? ORDER BY resource, permission, effect, expires_at').all(identity);
  return crypto.createHash('sha256').update(canonical(rows)).digest('hex');
}

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   audit: ReturnType<typeof import('./audit.js').openAudit>,
 *   runner: Pick<ReturnType<typeof import('./runner.js').createRunner>, 'start' | 'list'>,
 *   now?: () => Date,
 * }} opts
 */
export function createStanding({ db, audit, runner, now = () => new Date() }) {
  /** Runs being started now: a second run of the same grant in that moment is an overlap too. */
  const starting = new Set();
  /** @param {string} id */
  const row = (id) => /** @type {any} */ (db.prepare('SELECT * FROM standing_grants WHERE id = ?').get(id));
  /** @param {unknown} id */
  const must = (id) => {
    if (typeof id !== 'string' || !STANDING_ID.test(id)) throw new StandingError('bad_request', 'a standing grant id is lower-case letters, digits, - and _, up to 40, e.g. nightly-docs');
    const r = row(id);
    if (!r) throw new StandingError('not_found', `no standing grant ${id}`);
    return r;
  };
  /** @param {string} id */
  const live = (id) => runner.list().find((s) => s.standingGrant === id)?.id ?? null;
  /** @param {any} r */
  const shape = (r) => ({
    id: r.id, identity: r.identity_id, workspace: win(r.workspace), command: r.prompt === null ? r.command : null, prompt: r.prompt, pathDirs: JSON.parse(r.path_dirs).map(win),
    maxMinutes: r.max_minutes, expiresAt: r.expires_at, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, lastRunAt: r.last_run_at,
    grantsChanged: grantsHash(db, r.identity_id) !== r.grants_hash, running: live(r.id),
    containment: /** @type {any} */ (db.prepare('SELECT containment FROM identities WHERE id = ?').get(r.identity_id))?.containment ?? 'container',
  });
  /** @param {string} type @param {string} action @param {string} subject @param {string} id @param {'allow' | 'deny'} result @param {string} reason @param {object} [extra] */
  const event = (type, action, subject, id, result, reason, extra = {}) => audit.append({
    type, action, identity: { subject, containment: /** @type {any} */ (db.prepare('SELECT containment FROM identities WHERE id = ?').get(subject))?.containment ?? 'container' }, session_id: null,
    resource: { type: 'StandingGrant', id }, decision: { result, policy_version: 'none', reasons: [reason] }, ...extra,
  });
  /** @param {any} r @param {string} action @param {string} reason */
  const changed = (r, action, reason) => event('standing.change', action, OPERATOR, r.id, 'allow', reason, { standing_grant: shape(r) });

  /** @param {unknown} v @returns {number} */
  const minutes = (v) => {
    if (!Number.isInteger(v) || /** @type {number} */ (v) < 1 || /** @type {number} */ (v) > 1440) throw new StandingError('bad_request', 'maxMinutes is a whole number of minutes from 1 to 1440');
    return /** @type {number} */ (v);
  };
  /** @param {unknown} v @returns {string} */
  const expiry = (v) => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isNaN(t) || t <= now().getTime() || t > now().getTime() + YEAR) throw new StandingError('bad_request', 'expiresAt is a date and time in the future, at most a year away');
    return new Date(t).toISOString();
  };

  return {
    /** @param {string} [profile] only grants for that profile's identities */
    list: (profile) => /** @type {any[]} */ (profile === undefined ? db.prepare('SELECT * FROM standing_grants ORDER BY id').all()
      : db.prepare('SELECT s.* FROM standing_grants s JOIN identities i ON i.id = s.identity_id WHERE i.profile_id = ? ORDER BY s.id').all(String(profile))).map(shape),
    /** @param {unknown} id */
    get: (id) => shape(must(id)),

    /**
     * Approve a new one, active at once. The identity's grants as they are now are what it approves.
     * @param {any} spec id, identity, workspace, then command (an identity with no backend) or prompt
     *   (one whose backend has a headless start: Claude Code, Codex), pathDirs, maxMinutes, expiresAt
     */
    create(spec) {
      if (!spec || typeof spec !== 'object') throw new StandingError('bad_request', 'the standing grant is an object');
      const { id, identity, workspace, command, prompt, pathDirs = [], maxMinutes, expiresAt } = spec;
      if (typeof id !== 'string' || !STANDING_ID.test(id)) throw new StandingError('bad_request', 'id is lower-case letters, digits, - and _, up to 40, e.g. nightly-docs');
      if (row(id)) throw new StandingError('conflict', `${id} exists (ids are never reused, revoked ones included)`);
      const who = typeof identity === 'string' ? /** @type {any} */ (db.prepare('SELECT kind, status, containment, backend, standing_allowed FROM identities WHERE id = ?').get(identity)) : null;
      if (!who) throw new StandingError('bad_request', 'identity is an identity id, e.g. local:nightly-docs');
      if (who.kind !== 'ai-agent' && who.kind !== 'service-account') throw new StandingError('bad_request', `a ${who.kind} identity can't hold a standing grant`);
      if (who.status === 'retired') throw new StandingError('bad_request', `${identity} is retired`);
      if (who.containment === 'restricted-token') throw new StandingError('bad_request', `${identity} runs restricted-token, which isn't built yet`);
      if (who.containment === 'unconfined' && !who.standing_allowed) throw new StandingError('bad_request', `${identity} is a broad-access identity: it runs unconfined, and it holds standing grants only once the operator switches that on for it (identity.allowStanding)`);
      if (who.backend != null) {
        if (!BACKENDS[who.backend]?.headless) throw new StandingError('bad_request', `${identity} runs ${who.backend}, which has no unattended start yet`);
        if (command !== undefined) throw new StandingError('bad_request', `${identity} runs ${who.backend}: name a prompt, not a command`);
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') || prompt.length > 8000) throw new StandingError('bad_request', 'prompt is what the agent is asked to do, up to 8000 characters');
      } else {
        if (prompt !== undefined) throw new StandingError('bad_request', `${identity} has no backend: name the command, not a prompt`);
        if (typeof command !== 'string' || !command.trim() || /[\r\n\0]/.test(command) || command.length > 2000) throw new StandingError('bad_request', 'command is the full command line, one line');
      }
      let ws;
      let dirs;
      try {
        ws = resolvePath(typeof workspace === 'string' ? workspace : '');
        if (!Array.isArray(pathDirs) || pathDirs.length > 20 || !pathDirs.every((p) => typeof p === 'string')) throw new StandingError('bad_request', 'pathDirs is a list of program folders');
        dirs = pathDirs.map((p) => canonicalPath(p));
      } catch (e) {
        if (e instanceof PathError) throw new StandingError('bad_request', `workspace or pathDirs: ${e.message}`);
        throw e;
      }
      const t = now().toISOString();
      // A prompt grant's command is '' (the column predates prompts, schema v7).
      const viaPrompt = who.backend != null;
      db.prepare(`INSERT INTO standing_grants (id, identity_id, workspace, command, prompt, path_dirs, grants_hash, max_minutes, expires_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(id, identity, ws, viaPrompt ? '' : command, viaPrompt ? prompt : null, JSON.stringify(dirs), grantsHash(db, identity), minutes(maxMinutes), expiry(expiresAt), t, t);
      const r = row(id);
      changed(r, 'standing.create', 'approved by the operator');
      return shape(r);
    },

    /**
     * Approve it again: the identity's grants as they are now, and optionally a new expiry or budget.
     * @param {unknown} id @param {{ expiresAt?: unknown, maxMinutes?: unknown }} [p]
     */
    update(id, p = {}) {
      const r = must(id);
      if (r.status === 'revoked') throw new StandingError('revoked', `${r.id} is revoked; make a new one`);
      const max = p.maxMinutes === undefined ? r.max_minutes : minutes(p.maxMinutes);
      const until = p.expiresAt === undefined ? r.expires_at : expiry(p.expiresAt);
      db.prepare('UPDATE standing_grants SET grants_hash = ?, max_minutes = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(grantsHash(db, r.identity_id), max, until, now().toISOString(), r.id);
      const after = row(r.id);
      changed(after, 'standing.update', 'approved again by the operator, with the identity\'s grants as they are now');
      return shape(after);
    },

    /** @param {unknown} id */
    pause(id) {
      const r = must(id);
      if (r.status !== 'active') throw new StandingError('conflict', `${r.id} is ${r.status}`);
      db.prepare("UPDATE standing_grants SET status = 'paused', updated_at = ? WHERE id = ?").run(now().toISOString(), r.id);
      changed(row(r.id), 'standing.pause', 'paused by the operator');
      return shape(row(r.id));
    },

    /** @param {unknown} id */
    resume(id) {
      const r = must(id);
      if (r.status !== 'paused') throw new StandingError('conflict', `${r.id} is ${r.status}`);
      db.prepare("UPDATE standing_grants SET status = 'active', updated_at = ? WHERE id = ?").run(now().toISOString(), r.id);
      changed(row(r.id), 'standing.resume', 'resumed by the operator');
      return shape(row(r.id));
    },

    /** For good: its id stays taken. A run already going is not stopped (session.stop does that). @param {unknown} id */
    revoke(id) {
      const r = must(id);
      if (r.status === 'revoked') throw new StandingError('conflict', `${r.id} is revoked`);
      db.prepare("UPDATE standing_grants SET status = 'revoked', updated_at = ? WHERE id = ?").run(now().toISOString(), r.id);
      changed(row(r.id), 'standing.revoke', 'revoked by the operator');
      return shape(row(r.id));
    },

    /** Stop All (SEC-10): every active one paused, before any session is stopped, so none starts in between. @returns {string[]} the ids paused */
    pauseAll() {
      const ids = /** @type {any[]} */ (db.prepare("SELECT id FROM standing_grants WHERE status = 'active' ORDER BY id").all()).map((r) => r.id);
      if (!ids.length) return ids;
      db.prepare("UPDATE standing_grants SET status = 'paused', updated_at = ? WHERE status = 'active'").run(now().toISOString());
      for (const id of ids) changed(row(id), 'standing.pause', 'paused by Stop All');
      return ids;
    },

    /**
     * One unattended run, as a scheduled task asks. Each refusal is a `standing.run` deny event
     * and a StandingError whose code says why (harness.js turns it into an exit code).
     * @param {unknown} id
     * @returns {Promise<import('./runner.js').Session>}
     */
    async run(id) {
      if (typeof id !== 'string' || !STANDING_ID.test(id)) throw new StandingError('bad_request', 'a standing grant id is lower-case letters, digits, - and _, up to 40');
      const r = row(id);
      /** @param {string} code @param {string} reason */
      const refuse = (code, reason) => {
        event('standing.run', 'standing.run', r?.identity_id ?? OPERATOR, id, 'deny', reason);
        return new StandingError(code, `${id}: ${reason}`);
      };
      if (!r) throw refuse('not_found', 'no standing grant has this id');
      if (r.status === 'revoked') throw refuse('revoked', 'it is revoked');
      if (r.status === 'paused') throw refuse('paused', 'it is paused (Stop All pauses every standing grant); the operator resumes it');
      if (!(Date.parse(r.expires_at) > now().getTime())) throw refuse('expired', `it expired at ${r.expires_at}`);
      const who = /** @type {any} */ (db.prepare('SELECT containment, standing_allowed FROM identities WHERE id = ?').get(r.identity_id));
      if (who?.containment === 'unconfined' && !who.standing_allowed) throw refuse('refused', `${r.identity_id} is a broad-access identity and standing grants are switched off for it`);
      if (grantsHash(db, r.identity_id) !== r.grants_hash) throw refuse('changed', `${r.identity_id}'s grants changed since it was approved; the operator approves it again`);
      if (starting.has(id) || live(id)) throw refuse('overlap', `a run under it is still going (${live(id) ?? 'starting'})`);
      starting.add(id);
      try {
        const s = await runner.start({
          identity: r.identity_id, workspace: r.workspace, ...(r.prompt === null ? { command: r.command } : { prompt: r.prompt }), attended: false,
          program: { pathDirs: JSON.parse(r.path_dirs) }, timeoutMs: r.max_minutes * 60_000, standingGrant: id,
        });
        db.prepare('UPDATE standing_grants SET last_run_at = ? WHERE id = ?').run(s.startedAt, id);
        event('standing.run', 'standing.run', r.identity_id, id, 'allow', `started session ${s.id}, unattended, for at most ${r.max_minutes} min`, { session_id: s.id });
        return s;
      } catch (e) {
        // The runner wrote its own session.start deny with the reason.
        if (e instanceof RunnerError) throw refuse('refused', e.message);
        throw e;
      } finally {
        starting.delete(id);
      }
    },
  };
}
