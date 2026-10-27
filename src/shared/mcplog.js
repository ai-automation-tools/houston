// The MCP call log: one entry per request the server answers or refuses, for the
// sidebar's MCP panel and %APPDATA%\ai-command-center\logs\mcp.log. Pure; the server
// (shared/mcp.js) reports calls and the main process stores them.

export const LOG_KEEP = 200;
const MAX_ARGS = 300;
const MAX_ERROR = 300;

// Arguments kept out of mcp.log on disk, as their length only: a command can carry a
// password or token, and so can a field an agent fills. The sidebar's panel, which is in
// memory only, still shows them.
const AT_REST_ONLY_LENGTH = { terminal_run: ['command'], tab_fill: ['text'] };

/**
 * @typedef {{
 *   at: number, method: string, tool?: string, args?: string, argsAtRest?: string,
 *   ok: boolean, ms: number, status?: number, error?: string, client?: string, note?: string,
 * }} LogEntry argsAtRest: what mcp.log gets in place of args, when that differs;
 *   client: who made the call, from its clientInfo (initialize's, or a modern request's _meta) or its session's; note: an expected non-200 answer
 */

/** @param {string} s @param {number} max */
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A client's own words, without control characters, clipped. @param {unknown} v @param {number} max */
const plain = (v, max) => (typeof v === 'string' ? clip(v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(), max) : '');

/**
 * Web addresses with their query string and fragment cut, where tokens and session ids
 * usually ride: https://x.dev/cb?code=abc becomes https://x.dev/cb?…
 * @param {string} text
 */
export function stripQueries(text) {
  return text.replace(/(https?:\/\/[^\s"'?#]+)[?#][^\s"']*/gi, '$1?…');
}

/**
 * One request and what came of it. `msg` is whatever the client sent (trust nothing);
 * `out` is the JSON-RPC response, or null for a notification.
 * @param {{ msg: any, out: any, ms: number, at?: number, client?: string }} call client: who the request's session belongs to, when it doesn't say
 * @returns {LogEntry}
 */
export function describeCall({ msg, out, ms, at = Date.now(), client }) {
  const method = typeof msg?.method === 'string' ? clip(msg.method, 100) : '(invalid)';
  /** @type {LogEntry} */
  const entry = { at, method, ok: true, ms };
  // Self-reported, so it names the client, it doesn't prove who it is. A legacy client
  // names itself once, in initialize, and the server ties its later calls to that name by
  // session (`client`); a modern (2026-07-28) one names itself in every request's _meta.
  const info = (method === 'initialize' ? msg.params?.clientInfo : undefined) ?? msg?.params?._meta?.['io.modelcontextprotocol/clientInfo'];
  const name = plain(info?.name, 60);
  if (name) entry.client = [name, plain(info.version, 30)].filter(Boolean).join(' ');
  else if (client) entry.client = client;
  if (method === 'tools/call') {
    if (typeof msg.params?.name === 'string') entry.tool = clip(msg.params.name, 100);
    const args = msg.params?.arguments;
    if (args !== undefined) {
      entry.args = clip(stripQueries(JSON.stringify(args) ?? ''), MAX_ARGS);
      const hidden = AT_REST_ONLY_LENGTH[/** @type {keyof typeof AT_REST_ONLY_LENGTH} */ (entry.tool)];
      if (hidden && args && typeof args === 'object' && !Array.isArray(args)) {
        const rest = { ...args };
        for (const k of hidden) if (typeof rest[k] === 'string') rest[k] = `[${rest[k].length} chars]`;
        entry.argsAtRest = clip(stripQueries(JSON.stringify(rest)), MAX_ARGS);
      }
    }
  }
  const error = out?.error?.message ?? (out?.result?.isError ? out.result.content?.[0]?.text : undefined);
  if (error !== undefined) {
    entry.ok = false;
    entry.error = clip(stripQueries(String(error)), MAX_ERROR);
  }
  return entry;
}

/**
 * A request refused before it was read: no token, wrong Host, wrong path or method.
 * @param {number} status
 * @param {string} reason
 * @returns {LogEntry}
 */
export function refusedCall(status, reason, at = Date.now()) {
  return { at, method: '(refused)', ok: false, ms: 0, status, error: reason };
}

/**
 * A request answered with an error status that's part of a normal connection, not a
 * failure: Claude Code first probes with a modern protocol version and no _meta (400
 * tells it to fall back to initialize) and asks for an event stream with GET (405 tells
 * it there is none); a version the server doesn't speak gets 400 with the ones it does.
 * @param {number} status
 * @param {string} note
 * @returns {LogEntry}
 */
export function expectedCall(status, note, at = Date.now()) {
  return { at, method: '(handshake)', ok: true, ms: 0, status, note: plain(note, MAX_ERROR) };
}

/**
 * The mcp.log line: argsAtRest, when there is one, stands in for args.
 * @param {LogEntry} entry
 */
export function logLine(entry) {
  const { argsAtRest, ...rest } = entry;
  return `${JSON.stringify({ ...rest, ...(argsAtRest !== undefined && { args: argsAtRest }), at: new Date(entry.at).toISOString() })}\n`;
}

/**
 * Newest first, capped.
 * @param {LogEntry[]} list
 * @param {LogEntry} entry
 */
export function pushEntry(list, entry, keep = LOG_KEEP) {
  list.unshift(entry);
  if (list.length > keep) list.length = keep;
  return list;
}
