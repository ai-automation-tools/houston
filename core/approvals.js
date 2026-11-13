// The approval inbox: a policy `ask` waits here until the operator answers in the window, or
// its time runs out (SEC-05). The Core holds the request; the window only shows it and sends
// back an answer, so nothing an agent does can answer for the operator.
//
// Answers: `once` allows this one request; `session` allows it and every identical request
// (same action and resource) for the rest of the session; `deny` refuses it. No answer by the
// expiry is a deny. A session that ends denies whatever it still had waiting.
//
// Each ask is an `approval.requested` audit event and each outcome an `approval.decided`.

import crypto from 'node:crypto';

export const OPERATOR = 'local:operator';
export const ANSWERS = ['once', 'session', 'deny'];
/** How long a card waits before it denies. ponytail: one value for every ask; per-action timeouts if the gateway needs them. */
export const TIMEOUT_MS = 120_000;

export class ApprovalError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/**
 * @typedef {object} Ask
 * @property {string} identity
 * @property {string} session_id
 * @property {string} workspace
 * @property {string} action  e.g. net.connect
 * @property {{ type: string, id: string }} resource
 * @property {string} policy_version
 * @property {string[]} [policy_ids]  the grants that said ask
 *
 * @typedef {{ result: 'allow' | 'deny', reason: string }} Outcome
 */

/**
 * @param {{ audit: ReturnType<typeof import('./audit.js').openAudit>, now?: () => Date, timeoutMs?: number, onChange?: () => void }} opts
 */
export function createApprovals({ audit, now = () => new Date(), timeoutMs = TIMEOUT_MS, onChange = () => {} }) {
  /** @type {Map<string, Ask & { id: string, createdAt: string, expiresAt: string, settle: (o: Outcome) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  /** Requests allowed for the rest of a session: session id -> action + resource keys. @type {Map<string, Set<string>>} */
  const allowed = new Map();
  const key = (/** @type {Ask} */ a) => `${a.action} ${a.resource.type}:${a.resource.id}`;

  /** @param {Ask & { id: string }} a @param {Outcome} o @param {string} answer */
  const record = (a, o, answer) => audit.append({
    type: 'approval.decided', action: a.action, identity: { subject: a.identity, containment: 'container' }, session_id: a.session_id,
    resource: a.resource, decision: { result: o.result, policy_version: a.policy_version, policy_ids: a.policy_ids ?? [], reasons: [o.reason] },
    approval: { id: a.id, answer, by: answer === 'timeout' || answer === 'session ended' ? 'local:core' : OPERATOR },
  });

  /** @param {string} id @param {string} answer @param {Outcome} o */
  function settle(id, answer, o) {
    const a = pending.get(id);
    if (!a) return false;
    pending.delete(id);
    clearTimeout(a.timer);
    record(a, o, answer);
    a.settle(o);
    onChange();
    return true;
  }

  return {
    /**
     * Wait for the operator. Resolves allow or deny, never rejects.
     * @param {Ask} ask
     * @returns {Promise<Outcome>}
     */
    ask(ask) {
      if (allowed.get(ask.session_id)?.has(key(ask))) return Promise.resolve({ result: 'allow', reason: 'allowed for this session by the operator' });
      const id = crypto.randomUUID();
      const created = now();
      const a = { ...ask, id, createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + timeoutMs).toISOString() };
      audit.append({
        type: 'approval.requested', action: ask.action, identity: { subject: ask.identity, containment: 'container' }, session_id: ask.session_id,
        resource: ask.resource, decision: { result: 'ask', policy_version: ask.policy_version, policy_ids: ask.policy_ids ?? [], reasons: ['waiting for the operator'] },
        approval: { id, expires_at: a.expiresAt },
      });
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, 'timeout', { result: 'deny', reason: `no answer in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
        timer.unref?.();
        pending.set(id, { ...a, settle: resolve, timer });
        onChange();
      });
    },

    /**
     * The operator's answer.
     * @param {string} id @param {unknown} answer once, session or deny
     * @throws {ApprovalError} bad_request for another answer, not_found when it was answered or timed out already
     */
    decide(id, answer) {
      if (typeof answer !== 'string' || !ANSWERS.includes(answer)) throw new ApprovalError('bad_request', `answer is one of ${ANSWERS.join(', ')}`);
      const a = pending.get(id);
      if (!a) throw new ApprovalError('not_found', 'no waiting approval has that id (answered, timed out, or its session ended)');
      if (answer === 'session') {
        if (!allowed.has(a.session_id)) allowed.set(a.session_id, new Set());
        /** @type {Set<string>} */ (allowed.get(a.session_id)).add(key(a));
      }
      const o = answer === 'deny' ? { result: /** @type {const} */ ('deny'), reason: 'denied by the operator' }
        : { result: /** @type {const} */ ('allow'), reason: answer === 'session' ? 'allowed for this session by the operator' : 'allowed once by the operator' };
      settle(id, answer, o);
      return { result: o.result };
    },

    /** What the window shows, oldest first. */
    list: () => [...pending.values()].map(({ id, identity, session_id, workspace, action, resource, createdAt, expiresAt }) => ({ id, identity, session_id, workspace, action, resource, createdAt, expiresAt })),

    /** A session ended: deny what it still had waiting and forget its session allows. @param {string} sessionId */
    endSession(sessionId) {
      for (const a of [...pending.values()]) if (a.session_id === sessionId) settle(a.id, 'session ended', { result: 'deny', reason: 'the session ended' });
      allowed.delete(sessionId);
    },
  };
}
