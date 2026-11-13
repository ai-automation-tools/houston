// The approval card's words: what an agent asked for, in plain text, and how long is left.
// The Core holds the request and decides; this only says it (core/approvals.js).

/** The operator's answers, in the order the card offers them. */
export const ANSWERS = ['once', 'session', 'deny'];

/**
 * @typedef {{ id: string, identity: string, session_id: string, workspace: string, action: string, resource: { type: string, id: string, args_preview?: string }, createdAt: string, expiresAt: string }} Approval
 */

/**
 * What it wants to do, exactly: the action and the resource as the Core named them.
 * @param {Pick<Approval, 'action' | 'resource'>} a
 * @returns {string}
 */
export function describeAsk({ action, resource }) {
  if (action === 'net.connect') return `connect to ${resource.id}`;
  // A tool's arguments come clipped and with vault values redacted (core/gateway.js).
  if (action === 'tool.call') return `call the tool ${resource.id}${resource.args_preview ? ` with ${resource.args_preview}` : ''}`;
  if (action === 'command.run') return `run ${resource.id}`;
  return `${action} on ${resource.type} ${resource.id}`;
}

/**
 * Whole seconds until the card denies on its own; 0 once it's due.
 * @param {string} expiresAt @param {number} now ms
 */
export function secondsLeft(expiresAt, now) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** @param {unknown} v @returns {v is 'once' | 'session' | 'deny'} */
export const isAnswer = (v) => typeof v === 'string' && ANSWERS.includes(v);
