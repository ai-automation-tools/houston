import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BACKENDS } from '../../core/backends.js';
import { RELAY, discover, relay } from '../../core/runtimes.js';

/** @param {http.RequestListener} handler */
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
}

/** A runtime that serves chat completions only, as Ollama 0.12 does, and records what reached it. */
async function fakeRuntime(t) {
  /** @type {{ method: string, url: string, auth: string | undefined, body: string }[]} */
  const seen = [];
  const port = await serve(t, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
      if (req.url === '/v1/models') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'tiny:1b' }, { id: 'big:20b' }] }));
      if (req.url === '/v1/chat/completions') {
        if (body === '{}') { res.writeHead(400); return res.end('{"error":"model is required"}'); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"PO"}}]}\n\n');
        return setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"NG"}}]}\n\ndata: [DONE]\n\n'), 20);
      }
      res.writeHead(404).end('404 page not found');
    });
  });
  return { port, seen };
}

test('discover finds a runtime by its model list, names the APIs it serves, and skips a port that is something else', async (t) => {
  const rt = await fakeRuntime(t);
  const web = await serve(t, (_req, res) => res.end('<!doctype html><title>an app</title>'));
  const found = await discover({ known: [{ id: 'ollama', name: 'Ollama', port: rt.port }, { id: 'llamacpp', name: 'llama.cpp server', port: web }, { id: 'vllm', name: 'vLLM', port: 1 }] });
  assert.deepEqual(found, [{ id: 'ollama', name: 'Ollama', port: rt.port, baseUrl: `http://127.0.0.1:${rt.port}/v1`, models: ['tiny:1b', 'big:20b'], apis: { chat: true, responses: false, messages: false } }]);
});

test('the relay passes a session\'s request to the runtime, streamed, without its token; anything without the token is refused', async (t) => {
  const rt = await fakeRuntime(t);
  /** @type {any[]} */
  const events = [];
  const port = await serve(t, relay({ port: rt.port, token: 'session-token', onEvent: (e) => events.push(e) }));
  const post = (/** @type {Record<string, string>} */ headers) => fetch(`http://127.0.0.1:${port}${RELAY}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"model":"tiny:1b","stream":true}' });
  const ok = await post({ authorization: 'Bearer session-token' });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /PO[\s\S]*NG[\s\S]*\[DONE\]/);
  assert.deepEqual(rt.seen.at(-1), { method: 'POST', url: '/v1/chat/completions', auth: undefined, body: '{"model":"tiny:1b","stream":true}' });
  assert.equal((await post({ 'x-api-key': 'session-token' })).status, 200, 'an Anthropic-style key works too');
  const before = rt.seen.length;
  for (const h of [{}, { authorization: 'Bearer wrong' }, { 'x-api-key': 'session-tokeN' }]) assert.equal((await post(h)).status, 401);
  assert.equal(rt.seen.length, before, 'a refused request never reaches the runtime');
  assert.deepEqual(events.map((e) => e.status), [200, 200, 401, 401, 401]);
});

test('each backend points at the relay in the API it speaks: Codex a Responses provider keyed by the session token, Claude Code Anthropic variables', () => {
  const url = 'http://127.0.0.1:5555/runtime/v1';
  assert.equal(BACKENDS.codex.localModel?.api, 'responses');
  const args = BACKENDS.codex.localModel?.args(url, 'tiny:1b') ?? [];
  assert.ok(args.includes(`model_providers.houston-local.base_url=${url}`) && args.includes('model_providers.houston-local.env_key=HOUSTON_MCP_TOKEN'));
  assert.deepEqual(args.slice(-2), ['-m', 'tiny:1b']);
  assert.equal(BACKENDS['claude-code'].localModel?.api, 'messages');
  assert.deepEqual(BACKENDS['claude-code'].localModel?.env(url, 'tiny:1b', 'tok'), {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555/runtime', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'tiny:1b', ANTHROPIC_SMALL_FAST_MODEL: 'tiny:1b',
  });
});
