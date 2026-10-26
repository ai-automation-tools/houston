import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_VERSIONS, MODERN_VERSIONS, PROTOCOL_VERSIONS, checkRequest, mirrorHeaders, bearerMatches, createMcpServer, handleMessage, isLoopbackHost, isLoopbackOrigin } from '../src/shared/mcp.js';

const TOKEN = 'a'.repeat(64);
const tools = new Map([
  ['echo', { description: 'Echo', inputSchema: { type: 'object' }, run: (/** @type {any} */ a) => a }],
  ['boom', { description: 'Fails', inputSchema: { type: 'object' }, run: () => { throw new Error('nope'); } }],
]);

test('bearerMatches needs the exact token', () => {
  assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(undefined, TOKEN), false);
  assert.equal(bearerMatches('Bearer ', TOKEN), false);
  assert.equal(bearerMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerMatches('Bearer ', ''), false);
});

test('isLoopbackHost refuses anything but loopback', () => {
  assert.equal(isLoopbackHost('127.0.0.1:5000'), true);
  assert.equal(isLoopbackHost('localhost:5000'), true);
  assert.equal(isLoopbackHost('evil.com'), false);
  assert.equal(isLoopbackHost('127.0.0.1.evil.com:5000'), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test('handleMessage: initialize, notifications, tools, errors', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools, '0.1.0');
  assert.equal(/** @type {any} */ (init?.result).protocolVersion, '2025-06-18');
  const odd = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, tools, '0.1.0');
  assert.equal(/** @type {any} */ (odd?.result).protocolVersion, LEGACY_VERSIONS[0]);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, ''), null);
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools, '');
  assert.deepEqual(/** @type {any} */ (list?.result).tools.map((/** @type {any} */ t) => t.name), ['echo', 'boom']);
  assert.equal('annotations' in /** @type {any} */ (list?.result).tools[0], false);
  const call = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } }, tools, '');
  assert.deepEqual(/** @type {any} */ (call?.result).structuredContent, { x: 1 });
  const fail = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } }, tools, '');
  assert.equal(/** @type {any} */ (fail?.result).isError, true);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, tools, ''))?.error?.code, -32602);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 6, method: 'nope' }, tools, ''))?.error?.code, -32601);
  assert.equal((await handleMessage([{ jsonrpc: '2.0', id: 7, method: 'ping' }], tools, ''))?.error?.code, -32600);
});

test('the HTTP server refuses calls without the token and answers with it', async (t) => {
  const server = createMcpServer({ token: TOKEN, tools, version: '0.1.0' });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://127.0.0.1:${port}/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const post = (/** @type {Record<string, string>} */ headers) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 401);
  const ok = await post({ Authorization: `Bearer ${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.tools.length, 2);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
  const note = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const bad = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{' });
  assert.equal(bad.status, 400);
});

test("Claude Code's handshake logs as one named connection, with no failures", async (t) => {
  /** @type {import('../src/shared/mcplog.js').LogEntry[]} */
  const log = [];
  const server = createMcpServer({ token: TOKEN, tools, version: '0.1.0', onCall: (e) => log.push(e) });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://127.0.0.1:${port}/mcp`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const post = (/** @type {object} */ msg, /** @type {Record<string, string>} */ extra = {}) => fetch(url, { method: 'POST', headers: { ...auth, ...extra }, body: JSON.stringify(msg) });
  const clientInfo = { name: 'claude-code', version: '2.1.307' };
  // What Claude Code 2.1.307 sent on 2026-10-21, in order.
  assert.equal((await post({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} }, { 'MCP-Protocol-Version': '2026-07-28' })).status, 400);
  const init = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo } });
  assert.equal(init.status, 200);
  const session = { 'Mcp-Session-Id': String(init.headers.get('mcp-session-id')) };
  assert.match(session['Mcp-Session-Id'], /^[0-9a-f-]{36}$/);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'MCP-Protocol-Version': '2025-11-25', ...session })).status, 202);
  assert.equal((await fetch(url, { headers: { ...auth, ...session, Accept: 'text/event-stream' } })).status, 405);
  assert.equal((await fetch(url, { method: 'DELETE', headers: { ...auth, ...session } })).status, 405);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, session)).status, 200);
  assert.deepEqual(log.filter((e) => !e.ok), []);
  assert.equal(log.find((e) => e.method === 'initialize')?.client, 'claude-code 2.1.307');
  // Later calls carry the session, so they name the client too; no session or an unknown one, no name.
  assert.deepEqual(log.filter((e) => e.method.includes('/')).map((e) => e.client), ['claude-code 2.1.307', 'claude-code 2.1.307']);
  assert.equal((await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 200);
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'Mcp-Session-Id': 'not-one-of-ours' })).status, 200);
  assert.deepEqual(log.slice(-2).map((e) => e.client), [undefined, undefined]);
  assert.deepEqual(log.filter((e) => e.note).map((e) => e.status), [400, 405, 405]);
  assert.match(String(log[0].note), /2026-07-28/);
  // Not part of a handshake: still failures.
  assert.equal((await fetch(url, { method: 'PUT', headers: auth })).status, 405);
  assert.equal((await fetch(url, { headers: { Accept: 'text/event-stream' } })).status, 401);
  assert.deepEqual(log.slice(-2).map((e) => e.ok), [false, false]);
});

test('handleMessage answers malformed params, arguments, ids and names with JSON-RPC errors', async () => {
  const code = async (/** @type {any} */ msg) => (await handleMessage(msg, tools, ''))?.error?.code;
  assert.equal(await code({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null }), -32602);
  assert.equal(await code({ jsonrpc: '2.0', id: 1, method: 'initialize', params: [] }), -32602);
  assert.equal(await code({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'echo' }), -32602);
  for (const args of [null, [], 'x', 5]) {
    assert.equal(await code({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: args } }), -32602, JSON.stringify(args));
  }
  assert.equal(await code({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: { toString: 1 } } }), -32602);
  assert.equal(await code({ jsonrpc: '2.0', id: {}, method: 'ping' }), -32600);
  assert.equal(await code({ jsonrpc: '2.0', id: null, method: 'ping' }), -32600);
});

test('structuredContent is only ever a JSON object', async () => {
  const shaped = new Map([
    ['list', { description: '', inputSchema: { type: 'object' }, run: () => [1, 2] }],
    ['none', { description: '', inputSchema: { type: 'object' }, run: () => null }],
    ['obj', { description: '', inputSchema: { type: 'object' }, run: () => ({ tabs: [] }) }],
  ]);
  const res = async (/** @type {string} */ name) => /** @type {any} */ ((await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }, shaped, ''))?.result);
  assert.equal('structuredContent' in await res('list'), false);
  assert.equal((await res('list')).content[0].text, '[1,2]');
  assert.equal('structuredContent' in await res('none'), false);
  assert.deepEqual((await res('obj')).structuredContent, { tabs: [] });
});

test('isLoopbackOrigin takes only loopback http(s) origins', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isLoopbackOrigin('http://localhost'), true);
  assert.equal(isLoopbackOrigin('https://evil.example'), false);
  assert.equal(isLoopbackOrigin('http://localhost.evil.example'), false);
  assert.equal(isLoopbackOrigin('null'), false);
});

/** @param {import('node:test').TestContext} t @param {Map<string, any>} [toolMap] */
async function serve(t, toolMap = tools) {
  const server = createMcpServer({ token: TOKEN, tools: toolMap, version: '0.1.0' });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://127.0.0.1:${port}/mcp`;
  return (/** @type {unknown} */ msg, /** @type {Record<string, string>} */ headers = {}) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(msg) });
}

test('the HTTP server refuses foreign origins and unsupported protocol versions', async (t) => {
  const post = await serve(t);
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await post(ping, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(ping, { Origin: 'http://localhost:3000' })).status, 200);
  assert.equal((await post(ping, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);
  assert.equal((await post(ping, { 'MCP-Protocol-Version': LEGACY_VERSIONS[0] })).status, 200);
});

test('a failure inside the handler becomes a JSON-RPC error, and the next request still works', async (t) => {
  const broken = new Map(tools);
  broken.get = () => { throw new Error('boom'); };
  const post = await serve(t, broken);
  const res = await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'Internal error' } });
  assert.deepEqual(await (await post({ jsonrpc: '2.0', id: 10, method: 'ping' })).json(), { jsonrpc: '2.0', id: 10, result: {} });
});

test('a strict client session: initialize, initialized, tools/list, tools/call, every reply well-formed', async (t) => {
  const post = await serve(t);
  /** @param {any} r @param {number} id */
  const wellFormed = (r, id) => {
    assert.equal(r.jsonrpc, '2.0');
    assert.equal(r.id, id);
    assert.equal(('result' in r) !== ('error' in r), true, 'exactly one of result and error');
  };
  const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: { name: 'strict', version: '1' } } })).json();
  wellFormed(init, 1);
  assert.equal(init.result.protocolVersion, LEGACY_VERSIONS[0]);
  assert.equal(typeof init.result.serverInfo.name, 'string');
  const h = { 'MCP-Protocol-Version': init.result.protocolVersion };
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, h)).status, 202);
  const list = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, h)).json();
  wellFormed(list, 2);
  for (const tool of list.result.tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
  for (const [id, name] of [[3, 'echo'], [4, 'boom']]) {
    const call = await (await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { a: 1 } } }, h)).json();
    wellFormed(call, id);
    assert.equal(Array.isArray(call.result.content), true);
    for (const c of call.result.content) assert.deepEqual(Object.keys(c).sort(), ['text', 'type']);
    if ('structuredContent' in call.result) assert.equal(typeof call.result.structuredContent === 'object' && !Array.isArray(call.result.structuredContent), true);
  }
});

test('a client that disconnects mid-call aborts the tool it was waiting on', async (t) => {
  /** @type {(v: boolean) => void} */
  let heard = () => {};
  const aborted = new Promise((r) => { heard = r; });
  const waiting = new Map([['wait', {
    description: '', inputSchema: { type: 'object' },
    run: (/** @type {any} */ _a, /** @type {{ signal?: AbortSignal }} */ { signal } = {}) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => { heard(true); resolve(null); });
    }),
  }]]);
  const server = createMcpServer({ token: TOKEN, tools: waiting, version: '' });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const client = new AbortController();
  const call = fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', signal: client.signal,
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait' } }),
  }).catch((/** @type {Error} */ e) => e.name);
  setTimeout(() => client.abort(), 50);
  assert.equal(await call, 'AbortError');
  assert.equal(await aborted, true);
});

/** A modern (2026-07-28) request and the headers that mirror it. @param {string | number} id @param {string} method @param {object} [params] */
const modern = (id, method, params = {}) => {
  const msg = { jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSIONS[0], 'io.modelcontextprotocol/clientInfo': { name: 'modern', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } };
  return { msg, headers: mirrorHeaders(msg) };
};

test('a modern client: server/discover, tools/list and tools/call with per-request _meta, no initialize', async (t) => {
  const post = await serve(t);
  const send = async (/** @type {{ msg: object, headers: Record<string, string> }} */ r) => { const res = await post(r.msg, r.headers); return { status: res.status, body: await res.json() }; };
  const disc = await send(modern('d', 'server/discover'));
  assert.equal(disc.status, 200);
  assert.deepEqual(disc.body.result.supportedVersions, PROTOCOL_VERSIONS);
  assert.equal(disc.body.result.resultType, 'complete');
  assert.deepEqual(disc.body.result.capabilities, { tools: {} });
  assert.equal(disc.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'houston');
  const list = await send(modern(1, 'tools/list'));
  assert.equal(list.status, 200);
  assert.equal(list.body.result.resultType, 'complete');
  assert.deepEqual(list.body.result.tools.map((/** @type {any} */ x) => x.name), ['echo', 'boom']);
  const call = await send(modern(2, 'tools/call', { name: 'echo', arguments: { x: 1 } }));
  assert.deepEqual(call.body.result.structuredContent, { x: 1 });
  assert.equal(call.body.result.resultType, 'complete');
  const nope = await send(modern(3, 'resources/list'));
  assert.equal(nope.status, 404);
  assert.equal(nope.body.error.code, -32601);
  // The token check is unchanged for modern requests.
  const r = modern(4, 'tools/list');
  assert.equal((await post(r.msg, { ...r.headers, Authorization: '' })).status, 401);
  assert.equal((await post(r.msg, { ...r.headers, Authorization: 'Bearer wrong' })).status, 401);
});

test('a modern request without its fields or with headers that disagree gets 400 and a modern error', async (t) => {
  const post = await serve(t);
  const code = async (/** @type {object} */ msg, /** @type {Record<string, string>} */ headers) => { const res = await post(msg, headers); assert.equal(res.status, 400); return (await res.json()).error; };
  const ok = modern(1, 'tools/call', { name: 'echo' });
  const err = await code({ ...ok.msg, params: { ...ok.msg.params, _meta: { ...ok.msg.params._meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }, { ...ok.headers, 'MCP-Protocol-Version': '2026-07-28' });
  assert.equal(err.code, -32022);
  assert.deepEqual(err.data, { supported: PROTOCOL_VERSIONS, requested: '2099-01-01' });
  assert.equal((await code(ok.msg, { ...ok.headers, 'MCP-Protocol-Version': '2099-01-01' })).code, -32022);
  const noCaps = { ...ok.msg, params: { name: 'echo', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } };
  assert.equal((await code(noCaps, ok.headers)).code, -32602);
  assert.equal((await code(ok.msg, { ...ok.headers, 'MCP-Protocol-Version': '2025-11-25' })).code, -32020);
  assert.equal((await code(ok.msg, { ...ok.headers, 'Mcp-Method': 'tools/list' })).code, -32020);
  assert.equal((await code(ok.msg, { ...ok.headers, 'Mcp-Name': 'boom' })).code, -32020);
  const { 'Mcp-Name': _n, ...noName } = ok.headers;
  assert.equal((await code(ok.msg, noName)).code, -32020);
  // server/discover is modern-only: with no _meta it's malformed, not unknown.
  assert.equal((await code({ jsonrpc: '2.0', id: 9, method: 'server/discover' }, {})).code, -32602);
});

test('checkRequest leaves legacy requests alone and decodes a base64 Mcp-Name', () => {
  assert.deepEqual(checkRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {}), { modern: false });
  assert.deepEqual(checkRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' }), { modern: false });
  assert.equal(checkRequest(null, {}).reject, undefined);
  const r = modern(1, 'tools/call', { name: 'héllo wörld' });
  assert.match(r.headers['Mcp-Name'], /^=\?base64\?.+\?=$/);
  const lower = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.deepEqual(checkRequest(r.msg, lower), { modern: true });
  assert.deepEqual(mirrorHeaders({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {});
  assert.equal(mirrorHeaders(modern(1, 'tools/call', { name: '=?base64?x?=' }).msg)['Mcp-Name'], `=?base64?${Buffer.from('=?base64?x?=').toString('base64')}?=`);
});
