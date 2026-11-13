// MCP over HTTP, the parts every server here checks the same way: the app's own MCP server
// (src/shared/mcp.js) and the Core's gateway (core/gateway.js). No imports, so the Core,
// which imports nothing from the window, and the window's main process can both use it.
//
// Both eras of MCP. A legacy client (2025-11-25 and earlier) opens with `initialize`; a
// modern one (2026-07-28) sends its version, capabilities and name in every request's
// `_meta`, mirrored in the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers, and may
// ask `server/discover` first. checkRequest() tells them apart.

import { timingSafeEqual } from 'node:crypto';

/** Revisions with per-request `_meta` and no handshake. */
export const MODERN_VERSIONS = ['2026-07-28'];
/** Revisions that open with `initialize`. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const PROTOCOL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const META = 'io.modelcontextprotocol/';

/**
 * @typedef {{ jsonrpc: '2.0', id: string | number | null, result?: unknown, error?: { code: number, message: string, data?: unknown } }} Response
 */

/**
 * @param {string | undefined} header
 * @param {string} token
 */
export function bearerMatches(header, token) {
  const got = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return token.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

/** @param {string | undefined} host */
export function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host || ''));
}

/** @param {string | undefined} origin a browser's Origin header; absent for non-browser clients */
export function isLoopbackOrigin(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(origin || ''));
}

/** @param {unknown} v @returns {v is Record<string, any>} a plain JSON object, not null or an array */
export const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 * @returns {Response}
 */
export function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Which era a parsed request belongs to, and for a modern one whether its per-request
 * fields and mirrored headers are all there and agree with the body (2026-07-28's
 * server validation). A rejection is a 400 with a JSON-RPC error; `note` marks one
 * that's part of a normal connection (a version probe) rather than a failure.
 * @param {any} msg the parsed body, trusted for nothing
 * @param {Record<string, string | string[] | undefined>} headers Node's, names lower-case
 * @returns {{ modern: boolean, reject?: { status: number, out: Response, note?: string } }}
 */
export function checkRequest(msg, headers) {
  const asked = typeof headers['mcp-protocol-version'] === 'string' ? headers['mcp-protocol-version'] : undefined;
  const id = isObject(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
  /** @param {number} code @param {string} message @param {unknown} [data] @param {string} [note] */
  const reject = (code, message, data, note) => ({
    status: 400,
    out: /** @type {Response} */ ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } }),
    ...(note && { note }),
  });
  /** @param {string} requested */
  const unsupported = (requested) => reject(-32022, 'Unsupported protocol version', { supported: PROTOCOL_VERSIONS, requested: requested.slice(0, 40) },
    `Asked for MCP ${requested.slice(0, 40)}; told it supports ${PROTOCOL_VERSIONS.join(', ')}`);

  const meta = isObject(msg) && isObject(msg.params) && isObject(msg.params._meta) ? msg.params._meta : undefined;
  const version = meta?.[`${META}protocolVersion`];
  const modern = version !== undefined || MODERN_VERSIONS.includes(String(asked)) || (isObject(msg) && msg.method === 'server/discover');
  if (asked !== undefined && !PROTOCOL_VERSIONS.includes(asked)) return { modern, reject: unsupported(asked) };
  // Malformed messages and notifications are the caller's to answer; this revision
  // defines no header rules for a notification.
  if (!modern || id === null || typeof msg.method !== 'string') return { modern };

  if (version === undefined) {
    // Claude Code probes with the modern header and no _meta, then falls back to
    // initialize when this isn't one of the modern errors.
    return { modern, reject: reject(-32602, `Missing _meta ${META}protocolVersion`, undefined, asked && `Probed MCP ${asked.slice(0, 40)} without its per-request _meta; told it the request is malformed, so it falls back to initialize`) };
  }
  if (typeof version !== 'string' || !MODERN_VERSIONS.includes(version)) return { modern, reject: unsupported(String(version)) };
  if (!isObject(meta?.[`${META}clientCapabilities`])) return { modern, reject: reject(-32602, `Missing _meta ${META}clientCapabilities`) };
  if (asked !== version) return { modern, reject: reject(-32020, 'Header mismatch: MCP-Protocol-Version must match _meta protocolVersion') };
  if (headers['mcp-method'] !== msg.method) return { modern, reject: reject(-32020, 'Header mismatch: Mcp-Method must match method') };
  if (msg.method === 'tools/call' && headerValue(headers['mcp-name']) !== msg.params.name) return { modern, reject: reject(-32020, 'Header mismatch: Mcp-Name must match params.name') };
  return { modern };
}

/**
 * A mirrored header's value, with the `=?base64?…?=` sentinel decoded.
 * @param {string | string[] | undefined} v
 */
function headerValue(v) {
  if (typeof v !== 'string') return undefined;
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}
