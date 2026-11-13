// The Control Center MCP server: JSON-RPC over MCP's Streamable HTTP transport, plain
// JSON responses only (no SSE stream). A legacy client gets an Mcp-Session-Id at
// initialize, used only to name it on its later calls in the log; it grants nothing.
// No Electron here, so tests can run
// it for real; src/main/mcp.js starts it and hands it the tools.
//
// It speaks both eras of MCP; the version checks are core/mcp-protocol.js, shared with the
// Core's gateway.
//
// Every request must carry `Authorization: Bearer <token>` and a loopback Host header,
// and a browser's Origin header, when there is one, must be loopback too (both stop DNS
// rebinding from a web page reaching the port).

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { describeCall, expectedCall, refusedCall } from './mcplog.js';
import { LEGACY_VERSIONS, META, PROTOCOL_VERSIONS, bearerMatches, checkRequest, isLoopbackHost, isLoopbackOrigin, isObject, rpcError } from '../../core/mcp-protocol.js';

export { MODERN_VERSIONS, LEGACY_VERSIONS, PROTOCOL_VERSIONS, bearerMatches, checkRequest, isLoopbackHost, isLoopbackOrigin } from '../../core/mcp-protocol.js';
const MAX_BODY = 1024 * 1024;
const MAX_SESSIONS = 100;

/**
 * @typedef {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} ToolAnnotations
 * @typedef {{ description: string, inputSchema: object, annotations?: ToolAnnotations, run: (args: any, ctx?: { signal?: AbortSignal }) => unknown }} Tool
 *   ctx.signal aborts when the client disconnects before the answer, so a tool waiting on the user can give up
 * @typedef {import('../../core/mcp-protocol.js').Response} Response
 */

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
      // An `image` ({ data, mimeType }, as tab_screenshot gives) goes as an image block; the rest as JSON.
      if (isObject(out) && isObject(out.image) && typeof out.image.data === 'string' && typeof out.image.mimeType === 'string') {
        const { image, ...rest } = out;
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, { type: 'text', text: JSON.stringify(rest) }], structuredContent: rest } };
      }
      // structuredContent must be a JSON object; anything else goes as text only.
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out ?? null) }], ...(isObject(out) && { structuredContent: out }) } };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } };
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
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
