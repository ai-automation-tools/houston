// Profile memory (H6): what agents learn, kept per profile with where it came from, and served
// only after the operator approves it. An agent proposes an item with the gateway's
// `harness.remember` (a `memory:<profile>` write grant): it's pending, with the session and
// identity that wrote it. The operator approves or rejects it (`memory.review`, the window's
// Integrations tab). `harness.recall` (a read grant) returns approved items only, so nothing an
// agent wrote, or a tool result talked it into writing, reaches another session unreviewed.
// Text is redacted against the vault before it is stored.

import crypto from 'node:crypto';
import { OPERATOR } from './identities.js';
import { DEFAULT_PROFILE, profileOf } from './profiles.js';

export const MAX_TEXT = 2000;
/** Pending items a profile may hold: an agent can't bury the queue. */
export const MAX_PENDING = 100;
const STATES = ['pending', 'approved', 'rejected'];

export class MemoryError extends Error {
  /** @param {string} code bad_request | not_found | conflict @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

/** The tools a session sees for its memory grants. */
export const TOOLS = {
  remember: {
    name: 'remember',
    description: 'Propose one thing worth remembering for later sessions in this profile (a fact, a decision, a preference). '
      + 'It is kept with this session as its source and served to sessions only after the operator approves it.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: MAX_TEXT } } },
  },
  recall: {
    name: 'recall',
    description: 'What this profile remembers: items the operator approved, newest first, each with where it came from. Optionally only those containing the words given.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
  },
};

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, audit: ReturnType<typeof import('./audit.js').openAudit>, redact?: (s: string) => string, now?: () => Date }} o
 */
export function createMemory({ db, audit, redact = (s) => s, now = () => new Date() }) {
  const fail = (/** @type {string} */ c, /** @type {string} */ m) => new MemoryError(c, m);
  const shape = (/** @type {any} */ r) => ({
    id: r.id, profile: r.profile_id, text: r.text, state: r.state, source: { identity: r.source_identity, session: r.source_session },
    createdAt: r.created_at, reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by, note: r.review_note,
  });
  const row = (/** @type {unknown} */ id) => /** @type {any} */ (typeof id === 'string' ? db.prepare('SELECT * FROM memories WHERE id = ?').get(id) : undefined);
  const event = (/** @type {string} */ action, /** @type {string} */ subject, /** @type {string | null} */ session, /** @type {any} */ r, /** @type {string} */ reason) => audit.append({
    type: 'memory.change', action, identity: { subject }, session_id: session, resource: { type: 'Memory', id: r.id }, profile: r.profile_id,
    decision: { result: 'allow', policy_version: 'none', reasons: [reason] },
  });
  /** @param {unknown} text */
  const clean = (text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || text.includes('\0')) throw fail('bad_request', `text is 1 to ${MAX_TEXT} characters`);
    return redact(text.trim());
  };
  /** @param {string} profile @param {string} text @param {string} state @param {string} identity @param {string | null} session */
  const insert = (profile, text, state, identity, session) => {
    const id = crypto.randomUUID();
    const at = now().toISOString();
    const reviewed = state === 'approved' ? at : null;
    db.prepare('INSERT INTO memories (id, profile_id, text, state, source_identity, source_session, created_at, reviewed_at, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, profile, text, state, identity, session, at, reviewed, reviewed ? identity : null);
    return row(id);
  };

  return {
    /**
     * An agent's proposal, from its session: pending until the operator reviews it.
     * @param {{ id: string, identity: string, profile?: string }} s @param {any} args
     */
    propose(s, args) {
      const profile = s.profile ?? DEFAULT_PROFILE;
      const text = clean(args?.text);
      const waiting = /** @type {any} */ (db.prepare("SELECT count(*) AS n FROM memories WHERE profile_id = ? AND state = 'pending'").get(profile)).n;
      if (waiting >= MAX_PENDING) throw fail('conflict', `${MAX_PENDING} items already wait for the operator's review; try again after they're reviewed`);
      const r = insert(profile, text, 'pending', s.identity, s.id);
      event('memory.propose', s.identity, s.id, r, 'proposed; waits for review');
      return { id: r.id, state: 'pending', note: 'Kept for review. Sessions get it only once the operator approves it.' };
    },

    /**
     * Approved items of the session's profile, newest first. Never a pending or rejected one.
     * @param {{ profile?: string }} s @param {any} args
     */
    recall(s, args = {}) {
      const limit = Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50 ? args.limit : 20;
      const words = typeof args.query === 'string' ? args.query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10) : [];
      const all = /** @type {any[]} */ (db.prepare("SELECT * FROM memories WHERE profile_id = ? AND state = 'approved' ORDER BY created_at DESC, rowid DESC").all(s.profile ?? DEFAULT_PROFILE));
      const hits = all.filter((r) => words.every((w) => r.text.toLowerCase().includes(w))).slice(0, limit);
      return { items: hits.map((r) => ({ id: r.id, text: r.text, source: r.source_identity, at: r.created_at })) };
    },

    /** @param {{ profile?: unknown, state?: unknown }} [o] */
    list({ profile, state } = {}) {
      const p = profileOf(db, profile, fail);
      if (state !== undefined && !STATES.includes(/** @type {string} */ (state))) throw fail('bad_request', `state is one of ${STATES.join(', ')}`);
      return /** @type {any[]} */ (db.prepare('SELECT * FROM memories WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC').all(p)).filter((r) => !state || r.state === state).map(shape);
    },

    /** The operator writes one directly: approved, its source the operator. @param {unknown} text @param {unknown} [profile] */
    add(text, profile) {
      const r = insert(profileOf(db, profile, fail), clean(text), 'approved', OPERATOR, null);
      event('memory.add', OPERATOR, null, r, 'written by the operator');
      return shape(r);
    },

    /** @param {unknown} id @param {unknown} decision approve | reject @param {unknown} [note] */
    review(id, decision, note) {
      const r = row(id);
      if (!r) throw fail('not_found', `no memory item ${String(id)}`);
      if (decision !== 'approve' && decision !== 'reject') throw fail('bad_request', 'decision is approve or reject');
      if (note !== undefined && (typeof note !== 'string' || note.length > 500)) throw fail('bad_request', 'note is up to 500 characters');
      const state = decision === 'approve' ? 'approved' : 'rejected';
      db.prepare('UPDATE memories SET state = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?').run(state, now().toISOString(), OPERATOR, note ?? null, r.id);
      event(`memory.${decision}`, OPERATOR, null, r, note ? `${state}: ${note}` : state);
      return shape(row(r.id));
    },

    /** @param {unknown} id */
    remove(id) {
      const r = row(id);
      if (!r) throw fail('not_found', `no memory item ${String(id)}`);
      db.prepare('DELETE FROM memories WHERE id = ?').run(r.id);
      event('memory.remove', OPERATOR, null, r, 'deleted by the operator');
      return { removed: r.id };
    },
  };
}
