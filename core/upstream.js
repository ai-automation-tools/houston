// One MCP server from the gateway's side: over stdio, newline-delimited JSON-RPC both ways
// (MCP's stdio transport), or over HTTP to one already listening on loopback. The gateway is
// the only client a server has; the server can't reach an agent, and what it asks of its
// client (sampling, roots, elicitation) is refused.

import { StringDecoder } from 'node:string_decoder';
import { LEGACY_VERSIONS, isObject } from './mcp-protocol.js';

/** A message larger than this ends the connection. Screenshots are the big ones. */
const MAX_LINE = 32 * 1024 * 1024;
/** A server listing more tools than this is refused. */
const MAX_TOOLS = 1000;

export class UpstreamError extends Error {
  /** @param {string} message @param {{ code?: number, data?: unknown }} [rpc] a JSON-RPC error from the server */
  constructor(message, rpc) {
    super(message);
    this.name = 'UpstreamError';
    this.rpc = rpc;
  }
}

/**
 * @param {{ input: import('node:stream').Writable, output: import('node:stream').Readable, timeoutMs?: number }} io
 *   input: the server's stdin; output: its stdout
 */
export function connectStdio({ input, output, timeoutMs = 120_000 }) {
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  let next = 1;
  /** @type {Error | null} */
  let closed = null;

  /** @param {object} msg */
  const write = (msg) => { if (!closed) input.write(`${JSON.stringify(msg)}\n`); };

  /** @param {Error} why */
  const end = (why) => {
    if (closed) return;
    closed = why;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(why); }
    pending.clear();
    try { input.end(); } catch { /* already gone */ }
  };

  /** @param {any} msg */
  function receive(msg) {
    if (!isObject(msg)) return;
    if (msg.method === undefined && typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = /** @type {NonNullable<ReturnType<typeof pending.get>>} */ (pending.get(msg.id));
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (isObject(msg.error)) p.reject(new UpstreamError(String(msg.error.message ?? 'error').slice(0, 500), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    // A request from the server: only ping is answered.
    if (typeof msg.method === 'string' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      write(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'The gateway does not offer this to servers' } });
    }
    // Notifications (logging, list_changed) are dropped: a changed list is caught when the gateway lists again.
  }

  const decoder = new StringDecoder('utf8');
  let buf = '';
  output.on('data', (chunk) => {
    buf += decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { receive(JSON.parse(line)); } catch { /* a server that writes logs to stdout: skip the line */ }
    }
    if (buf.length > MAX_LINE) end(new UpstreamError('the server sent a message over 32 MB'));
  });
  output.on('end', () => end(new UpstreamError('the server closed its output')));
  output.on('error', (e) => end(new UpstreamError(`the server's output failed: ${e.message}`)));
  input.on('error', (e) => end(new UpstreamError(`the server's input failed: ${e.message}`)));

  return {
    /**
     * @param {string} method @param {object} [params] @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
     * @returns {Promise<any>} the result; rejects with UpstreamError
     */
    request(method, params = {}, { signal, timeoutMs: ms = timeoutMs } = {}) {
      if (closed) return Promise.reject(closed);
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } });
          reject(new UpstreamError(`no answer in ${Math.round(ms / 1000)} s`));
        }, ms);
        pending.set(id, { resolve, reject, timer });
        signal?.addEventListener('abort', () => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'the agent went away' } });
          reject(new UpstreamError('cancelled'));
        }, { once: true });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    /** @param {string} method @param {object} [params] */
    notify: (method, params = {}) => write({ jsonrpc: '2.0', method, params }),
    /** @param {string} [why] */
    close: (why = 'closed by the gateway') => end(new UpstreamError(why)),
    get closed() { return closed !== null; },
  };
}

/**
 * One MCP server already listening on loopback (Houston's own), over Streamable HTTP: a POST
 * per message and a JSON answer. The session id and protocol version it gives at initialize go
 * back on every later request. Same shape as connectStdio's client.
 * ponytail: JSON answers only; a server that answers with an event stream is refused, add an
 * SSE reader when one is registered.
 * @param {{ url: string, headers?: Record<string, string>, timeoutMs?: number }} o
 *   headers: what the registration's env resolved to (its Authorization, say)
 */
export function connectHttp({ url, headers = {}, timeoutMs = 120_000 }) {
  /** @type {Error | null} */
  let closed = null;
  let next = 1;
  /** @type {Record<string, string>} */
  const session = {};
  const all = new AbortController();

  /** @param {object} body @param {AbortSignal | undefined} signal @param {number} ms */
  async function post(body, signal, ms) {
    if (closed) throw closed;
    const timeout = AbortSignal.timeout(ms);
    let r;
    try {
      r = await fetch(url, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers, ...session },
        body: JSON.stringify(body),
        signal: AbortSignal.any([all.signal, timeout, ...(signal ? [signal] : [])]),
      });
    } catch (e) {
      if (closed) throw closed;
      if (timeout.aborted) throw new UpstreamError(`no answer in ${Math.round(ms / 1000)} s`);
      if (signal?.aborted) throw new UpstreamError('cancelled');
      throw new UpstreamError(`the server can't be reached: ${/** @type {Error} */ (e).message}`);
    }
    const text = await r.text();
    if (r.status === 202 && !text) return null;
    if (!r.ok) throw new UpstreamError(`the server answered HTTP ${r.status}`);
    if (!/^application\/json\b/i.test(r.headers.get('content-type') ?? '')) throw new UpstreamError('the server answered with something other than JSON (an event stream is not read yet)');
    if (text.length > MAX_LINE) throw new UpstreamError('the server sent a message over 32 MB');
    const sid = r.headers.get('mcp-session-id');
    if (sid) session['mcp-session-id'] = sid;
    try { return JSON.parse(text); } catch { throw new UpstreamError('the server answered with JSON that does not parse'); }
  }

  return {
    /**
     * @param {string} method @param {object} [params] @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
     * @returns {Promise<any>} the result; rejects with UpstreamError
     */
    async request(method, params = {}, { signal, timeoutMs: ms = timeoutMs } = {}) {
      const id = next++;
      const msg = await post({ jsonrpc: '2.0', id, method, params }, signal, ms);
      if (!isObject(msg) || msg.id !== id) throw new UpstreamError('the server answered with no response to the request');
      if (isObject(msg.error)) throw new UpstreamError(String(msg.error.message ?? 'error').slice(0, 500), { code: msg.error.code, data: msg.error.data });
      if (method === 'initialize' && isObject(msg.result) && typeof msg.result.protocolVersion === 'string') session['mcp-protocol-version'] = msg.result.protocolVersion;
      return msg.result;
    },
    /** @param {string} method @param {object} [params] */
    notify: (method, params = {}) => { post({ jsonrpc: '2.0', method, params }, undefined, timeoutMs).catch(() => {}); },
    /** @param {string} [why] */
    close: (why = 'closed by the gateway') => { if (!closed) { closed = new UpstreamError(why); all.abort(); } },
    get closed() { return closed !== null; },
  };
}

/**
 * The legacy handshake, which every stdio server speaks.
 * @param {ReturnType<typeof connectStdio> | ReturnType<typeof connectHttp>} client
 * @param {string} version the gateway's version, for clientInfo
 * @param {number} [timeoutMs] a cold `npx` start can take a while
 * @returns {Promise<{ protocolVersion: string, serverInfo?: { name?: string, version?: string } }>}
 */
export async function initialize(client, version, timeoutMs = 120_000) {
  const r = await client.request('initialize', { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: { name: 'houston-gateway', version } }, { timeoutMs });
  if (!isObject(r) || typeof r.protocolVersion !== 'string') throw new UpstreamError('the server answered initialize without a protocolVersion');
  client.notify('notifications/initialized');
  return /** @type {any} */ (r);
}

/**
 * Every tool, following `nextCursor`.
 * @param {ReturnType<typeof connectStdio> | ReturnType<typeof connectHttp>} client
 * @returns {Promise<any[]>}
 */
export async function listTools(client) {
  const tools = [];
  /** @type {string | undefined} */
  let cursor;
  do {
    const r = await client.request('tools/list', cursor ? { cursor } : {});
    if (!isObject(r) || !Array.isArray(r.tools)) throw new UpstreamError('tools/list did not return a tools array');
    tools.push(...r.tools);
    if (tools.length > MAX_TOOLS) throw new UpstreamError(`the server lists more than ${MAX_TOOLS} tools`);
    cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
  } while (cursor);
  return tools;
}
