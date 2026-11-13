// Local model runtimes (H6, CORE-16): find the OpenAI-compatible servers running on this
// machine, and let a session's agent CLI use one. A container can't reach the host's loopback,
// so the runtime is reached through the session's own proxy port at /runtime/: the Core relays
// each request to the runtime on 127.0.0.1, only with the session's token, only when the
// identity holds a `net:127.0.0.1:<port>` connect grant, and records each one.

import http from 'node:http';
import { bearerMatches } from './mcp-protocol.js';

/** Where each runtime listens by default. */
export const KNOWN = [
  { id: 'ollama', name: 'Ollama', port: 11434 },
  { id: 'lmstudio', name: 'LM Studio', port: 1234 },
  { id: 'llamacpp', name: 'llama.cpp server', port: 8080 },
  { id: 'koboldcpp', name: 'KoboldCpp', port: 5001 },
  { id: 'vllm', name: 'vLLM', port: 8000 },
];
/** The APIs an agent CLI may need, by the path that serves each. */
export const APIS = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };
/** The path prefix the relay answers on a session's proxy port. */
export const RELAY = '/runtime';

export class RuntimeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RuntimeError';
  }
}

/**
 * One request to 127.0.0.1, with a deadline.
 * @param {number} port @param {string} method @param {string} pathname @param {string} [body]
 * @returns {Promise<{ status: number, text: string }>}
 */
function local(port, method, pathname, body, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, timeout: timeoutMs, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 1_000_000) text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * The runtimes answering now: a known port whose /v1/models is an OpenAI model list, its models,
 * and which of the APIs it serves (a 404 or 405 to an empty POST means not).
 * @param {{ known?: typeof KNOWN, timeoutMs?: number }} [o]
 * @returns {Promise<{ id: string, name: string, port: number, baseUrl: string, models: string[], apis: Record<keyof typeof APIS, boolean> }[]>}
 */
export async function discover({ known = KNOWN, timeoutMs = 1500 } = {}) {
  const found = await Promise.all(known.map(async (k) => {
    try {
      const r = await local(k.port, 'GET', '/v1/models', undefined, timeoutMs);
      const list = r.status === 200 ? JSON.parse(r.text)?.data : null;
      if (!Array.isArray(list)) return null;
      const models = list.map((m) => m?.id).filter((id) => typeof id === 'string').slice(0, 200);
      const apis = /** @type {Record<keyof typeof APIS, boolean>} */ ({});
      for (const [api, p] of Object.entries(APIS)) {
        const s = await local(k.port, 'POST', p, '{}', timeoutMs).then((x) => x.status, () => 0);
        apis[/** @type {keyof typeof APIS} */ (api)] = s !== 0 && s !== 404 && s !== 405;
      }
      return { ...k, baseUrl: `http://127.0.0.1:${k.port}/v1`, models, apis };
    } catch { return null; }
  }));
  return /** @type {any[]} */ (found.filter(Boolean));
}

/**
 * The handler for a session's /runtime/ requests: the session's token (as `Authorization: Bearer`
 * or `x-api-key`, whichever its CLI sends), then the request as it came, to the runtime.
 * @param {{ port: number, token: string, onEvent: (e: { method: string, path: string, status: number | null, reason: string }) => void }} o
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
export function relay({ port, token, onEvent }) {
  return (req, res) => {
    const pathname = (req.url ?? '').slice(RELAY.length) || '/';
    const key = req.headers['x-api-key'];
    if (!bearerMatches(req.headers.authorization, token) && !(typeof key === 'string' && bearerMatches(`Bearer ${key}`, token))) {
      onEvent({ method: req.method ?? '', path: pathname.slice(0, 200), status: 401, reason: 'no session token' });
      res.writeHead(401, { 'content-type': 'text/plain' }).end('The session token is required.\n');
      return;
    }
    const headers = { ...req.headers };
    for (const h of ['authorization', 'x-api-key', 'host', 'proxy-authorization', 'proxy-connection', 'connection']) delete headers[h];
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: pathname, headers }, (r) => {
      onEvent({ method: req.method ?? '', path: pathname.slice(0, 200), status: r.statusCode ?? null, reason: 'relayed to the local runtime' });
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      onEvent({ method: req.method ?? '', path: pathname.slice(0, 200), status: null, reason: `the runtime did not answer: ${e.message}` });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('The local runtime did not answer.\n');
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  };
}
