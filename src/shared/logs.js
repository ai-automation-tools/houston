// The Logs tab's rules: which filters the window may send for the Core's audit log, and how an
// audit event (core/schemas/audit-event.schema.json) reads as a row. No DOM, so it's tested.

export const RESULTS = /** @type {const} */ (['allow', 'ask', 'deny']);
export const LOG_LIMIT = 300;

/**
 * The filter the renderer asked for, checked: an identity id, a session id and a decision, each
 * optional. Anything else throws, so nothing but these reaches audit.query.
 * @param {unknown} f
 * @returns {{ identity?: string, session_id?: string, result?: string, limit: number }}
 */
export function logFilter(f) {
  const p = /** @type {Record<string, unknown>} */ (f && typeof f === 'object' && !Array.isArray(f) ? f : {});
  /** @type {{ identity?: string, session_id?: string, result?: string, limit: number }} */
  const out = { limit: LOG_LIMIT };
  for (const [k, to] of /** @type {const} */ ([['identity', 'identity'], ['session', 'session_id']])) {
    const v = p[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || v.length > 100) throw new Error(`${k} is an id`);
    out[to] = v;
  }
  if (p.result !== undefined && p.result !== '') {
    if (!RESULTS.includes(/** @type {any} */ (p.result))) throw new Error('result is allow, ask or deny');
    out.result = /** @type {string} */ (p.result);
  }
  return out;
}

/**
 * One event as a row: what happened to what, who and when, and the full event for its detail.
 * @param {any} e an audit event
 * @returns {{ result: string, icon: string, name: string, sub: string, title: string }}
 */
export function logRow(e) {
  const result = e.decision?.result ?? '';
  const what = e.resource?.id && e.resource.id !== e.session_id ? `${e.type} ${e.resource.id}` : String(e.type);
  const answer = e.approval?.answer ? ` (${e.approval.answer})` : '';
  const time = new Date(e.time);
  return {
    result,
    icon: result === 'allow' ? '✓' : result === 'ask' ? '?' : result === 'deny' ? '✕' : '·',
    name: what + answer,
    sub: `${e.identity?.subject ?? '?'} · ${Number.isNaN(time.getTime()) ? '?' : time.toLocaleTimeString()}`,
    title: [
      `${e.type}: ${result}${e.decision?.reasons?.length ? ` (${e.decision.reasons.join('; ')})` : ''}`,
      `${e.resource?.type ?? '?'} ${e.resource?.id ?? ''}`,
      `identity ${e.identity?.subject ?? '?'}`,
      e.session_id ? `session ${e.session_id}` : '',
      Number.isNaN(time.getTime()) ? '' : time.toLocaleString(),
    ].filter(Boolean).join('\n'),
  };
}

/**
 * The session filter's choices from session.start events, newest first.
 * @param {any[]} starts
 * @returns {{ id: string, label: string }[]}
 */
export function sessionChoices(starts) {
  return starts.filter((e) => e.session_id).reverse().map((e) => ({
    id: e.session_id,
    label: `${e.identity?.subject ?? '?'} · ${new Date(e.time).toLocaleString()}`,
  }));
}
