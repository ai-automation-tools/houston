// The Control Center MCP server: JSON-RPC over MCP's Streamable HTTP transport, plain
// JSON responses only (no SSE stream). A legacy client gets an Mcp-Session-Id at
// initialize, used only to name it on its later calls in the log; it grants nothing.
// No Electron here, so tests can run
// it for real; src/main/mcp.js starts it and hands it the tools.
//
// It speaks both eras of MCP. A legacy client (2025-11-25 and earlier) opens with
// `initialize`; a modern one (2026-07-28) sends its version, capabilities and name in
// every request's `_meta`, mirrored in the MCP-Protocol-Version, Mcp-Method and Mcp-Name
// headers, and may ask `server/discover` first. checkRequest() tells them apart.
//
// Every request must carry `Authorization: Bearer <token>` and a loopback Host header,
// and a browser's Origin header, when there is one, must be loopback too (both stop DNS
// rebinding from a web page reaching the port).

import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { describeCall, expectedCall, refusedCall } from './mcplog.js';

/** Revisions with per-request `_meta` and no handshake. */
export const MODERN_VERSIONS = ['2026-07-28'];
/** Revisions that open with `initialize`. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const PROTOCOL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const META = 'io.modelcontextprotocol/';
const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS = 100;

/**
 * @typedef {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} ToolAnnotations
 * @typedef {{ description: string, inputSchema: object, annotations?: ToolAnnotations, run: (args: any, ctx?: { signal?: AbortSignal }) => unknown }} Tool
 *   ctx.signal aborts when the client disconnects before the answer, so a tool waiting on the user can give up
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

/**
 * One JSON-RPC message in, one response out, or null for a notification.
 * @param {any} msg
 * @param {Map<string, Tool>} tools
 * @param {string} version app version for serverInfo
 * @param {AbortSignal} [signal] the request's client went away
 * @param {boolean} [modern] a checked 2026-07-28 request (checkRequest): results carry
 *   `resultType` and the server's name in `_meta`, and `server/discover` answers
 * @returns {Promise<Response | null>}
 */
export async function handleMessage(msg, tools, version, signal, modern = false) {
  const out = await answer(msg, tools, version, signal, modern);
  if (modern && out?.result) out.result = { resultType: 'complete', ...out.result, _meta: { [`${META}serverInfo`]: { name: 'houston', version } } };
  return out;
}

/** @param {any} msg @param {Map<string, Tool>} tools @param {string} version @param {AbortSignal | undefined} signal @param {boolean} modern @returns {Promise<Response | null>} */
async function answer(msg, tools, version, signal, modern) {
  if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(null, -32600, 'Invalid request');
  }
  if (msg.id === undefined) return null;
  if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return rpcError(null, -32600, 'Invalid request: id must be a string or number');
  const { id, method, params = {} } = msg;
  if (!isObject(params)) return rpcError(id, -32602, 'params must be an object');

  if (method === 'initialize') {
    // Always the legacy handshake: a client that asks for a modern version here gets
    // the newest legacy one, since modern revisions have no initialize.
    const asked = params.protocolVersion;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'houston', version },
      },
    };
  }
  if (method === 'server/discover' && modern) {
    return { jsonrpc: '2.0', id, result: { supportedVersions: PROTOCOL_VERSIONS, capabilities: { tools: {} } } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: [...tools].map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations && { annotations: t.annotations }) })) },
    };
  }
  if (method === 'tools/call') {
    const tool = typeof params.name === 'string' ? tools.get(params.name) : undefined;
    // JSON.stringify, not String(): a JSON object like {"toString":1} makes String() throw.
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${(typeof params.name === 'string' ? params.name : String(JSON.stringify(params.name))).slice(0, 100)}`);
    const args = params.arguments === undefined ? {} : params.arguments;
    if (!isObject(args)) return rpcError(id, -32602, 'arguments must be an object');
    try {
      const out = await tool.run(args, { signal });
      // structuredContent must be a JSON object; anything else goes as text only.
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out ?? null) }], ...(isObject(out) && { structuredContent: out }) } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } };
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** @param {unknown} v @returns {v is Record<string, any>} a plain JSON object, not null or an array */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {string | undefined} origin a browser's Origin header; absent for non-browser clients */
export function isLoopbackOrigin(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(origin || ''));
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
  // Malformed messages and notifications are handleMessage's to answer; this revision
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

/**
 * The headers a modern request's body must be mirrored into on HTTP, for a client
 * (the stdio bridge) that only has the body; none for a legacy one.
 * @param {any} msg
 * @returns {Record<string, string>}
 */
export function mirrorHeaders(msg) {
  const version = isObject(msg) && isObject(msg.params) && isObject(msg.params._meta) ? msg.params._meta[`${META}protocolVersion`] : undefined;
  if (typeof version !== 'string' || typeof msg.method !== 'string') return {};
  /** @param {string} s */
  const plain = (s) => /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(s);
  /** @type {Record<string, string>} */
  const out = {};
  // A version or method that can't be a header is left out, and the server refuses it.
  if (plain(version)) out['MCP-Protocol-Version'] = version;
  if (plain(msg.method)) out['Mcp-Method'] = msg.method;
  const name = msg.params.name ?? msg.params.uri;
  if (typeof name === 'string') out['Mcp-Name'] = plain(name) && !/^=\?base64\?.*\?=$/.test(name) ? name : `=?base64?${Buffer.from(name, 'utf8').toString('base64')}?=`;
  return out;
}

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 * @returns {Response}
 */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * @param {{ token: string, tools: Map<string, Tool>, version: string, onCall?: (entry: import('./mcplog.js').LogEntry) => void }} opts
 *   onCall hears about every request: answered, failed, or refused before it was read
 * @returns {http.Server} not yet listening
 */
export function createMcpServer({ token, tools, version, onCall = () => {} }) {
  // Session id → the name its client gave at initialize ('' for none). An unknown id is
  // ignored rather than refused, since a session only labels calls.
  // ponytail: oldest dropped past MAX_SESSIONS; a client outliving 100 newer sessions logs unnamed
  /** @type {Map<string, string>} */
  const sessions = new Map();
  return http.createServer((req, res) => {
    /** @param {number} status @param {unknown} [body] */
    const reply = (status, body) => {
      res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    /** @param {number} status @param {string} reason */
    const refuse = (status, reason) => {
      onCall(refusedCall(status, reason));
      reply(status, { error: reason });
    };
    if (!isLoopbackHost(req.headers.host)) return refuse(403, 'Forbidden host');
    // The transport spec's DNS-rebinding guard: a browser always sends Origin, so a page
    // on any other site is refused even before the token is checked.
    if (req.headers.origin !== undefined && !isLoopbackOrigin(req.headers.origin)) return refuse(403, 'Forbidden origin');
    if (!bearerMatches(req.headers.authorization, token)) return refuse(401, 'Missing or wrong token');
    // Past the token, two refusals are the transport spec's way of steering a client, and
    // are logged as part of the handshake rather than as failures.
    /** @param {number} status @param {string} reason @param {string} note */
    const steer = (status, reason, note) => {
      onCall(expectedCall(status, note));
      reply(status, { error: reason });
    };
    if (new URL(req.url || '/', 'http://x').pathname !== '/mcp') return refuse(404, 'Not found');
    // No server-to-client stream (GET) and no sessions to end (DELETE).
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      if (req.method === 'GET') return steer(405, 'Method not allowed', 'Asked for an event stream; there is none, so replies come back over POST');
      if (req.method === 'DELETE') return steer(405, 'Method not allowed', 'Asked to end its session; sessions only name a client and end when the app quits');
      return refuse(405, 'Method not allowed');
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        refuse(413, 'Body too large');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', async () => {
      if (res.headersSent) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        onCall(refusedCall(400, 'Parse error'));
        return reply(400, rpcError(null, -32700, 'Parse error'));
      }
      const sid = req.headers['mcp-session-id'];
      const client = typeof sid === 'string' ? sessions.get(sid) : undefined;
      // The protocol version and, for a modern request, its _meta and mirrored headers.
      const { modern, reject } = checkRequest(msg, req.headers);
      if (reject) {
        try { onCall(reject.note ? expectedCall(reject.status, reject.note) : describeCall({ msg, out: reject.out, ms: 0, client })); } catch { /* logging never blocks the reply */ }
        return reply(reject.status, reject.out);
      }
      const started = Date.now();
      // A client that disconnects before the answer (the chat's Stop, a killed CLI)
      // aborts the call, which withdraws a confirm bar it's waiting on.
      const gone = new AbortController();
      res.on('close', () => { if (!res.writableFinished) gone.abort(); });
      /** @type {Response | null} */
      let out;
      try {
        out = await handleMessage(msg, tools, version, gone.signal, modern);
      } catch {
        // Nothing reaching here may leave the socket hanging or the rejection unhandled.
        out = rpcError(isObject(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null, -32603, 'Internal error');
      }
      /** @type {import('./mcplog.js').LogEntry | undefined} */
      let entry;
      // Notifications get no answer but still happened.
      try { entry = describeCall({ msg, out, ms: Date.now() - started, client }); onCall(entry); } catch { /* logging never blocks the reply */ }
      if (msg?.method === 'initialize' && out?.result) {
        const id = randomUUID();
        sessions.set(id, entry?.client ?? '');
        if (sessions.size > MAX_SESSIONS) sessions.delete(/** @type {string} */ (sessions.keys().next().value));
        res.setHeader('Mcp-Session-Id', id);
      }
      if (out === null) return reply(202);
      // A modern client tells an unknown method from a legacy server's 404 by the body.
      reply(modern && out.error?.code === -32601 ? 404 : 200, out);
    });
  });
}
