import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../src/shared/mcp.js';
import { describeCall, expectedCall, logLine, pushEntry, refusedCall } from '../src/shared/mcplog.js';

const call = (/** @type {string} */ name, /** @type {unknown} */ args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('describeCall records the tool, its arguments and success', () => {
  const e = describeCall({ msg: call('open_tab', { url: 'example.com' }), out: { result: { content: [] } }, ms: 4, at: 1 });
  assert.deepEqual(e, { at: 1, method: 'tools/call', tool: 'open_tab', args: '{"url":"example.com"}', ok: true, ms: 4 });
});

test('describeCall marks tool errors and JSON-RPC errors as failed, with the message', () => {
  const toolErr = describeCall({ msg: call('terminal_run', { command: 'x' }), out: { result: { isError: true, content: [{ type: 'text', text: 'Not run: the user denied' }] } }, ms: 9 });
  assert.equal(toolErr.ok, false);
  assert.match(String(toolErr.error), /denied/);
  const rpcErr = describeCall({ msg: { jsonrpc: '2.0', id: 1, method: 'nope' }, out: { error: { code: -32601, message: 'Method not found: nope' } }, ms: 0 });
  assert.deepEqual([rpcErr.ok, rpcErr.method, rpcErr.tool], [false, 'nope', undefined]);
});

test('describeCall copes with junk and clips long arguments', () => {
  assert.equal(describeCall({ msg: null, out: null, ms: 0 }).method, '(invalid)');
  assert.equal(describeCall({ msg: [1, 2], out: null, ms: 0 }).method, '(invalid)');
  const long = describeCall({ msg: call('sidebar_search', { query: 'x'.repeat(1000) }), out: { result: {} }, ms: 0 });
  assert.equal(long.args?.length, 300);
  assert.ok(long.args?.endsWith('…'));
});

test('refusedCall, logLine and pushEntry', () => {
  const r = refusedCall(401, 'Missing or wrong token', 0);
  assert.deepEqual([r.method, r.ok, r.status], ['(refused)', false, 401]);
  const line = logLine(r);
  assert.ok(line.endsWith('\n'));
  assert.equal(JSON.parse(line).at, '1970-01-01T00:00:00.000Z');
  const list = [];
  for (let i = 0; i < 5; i++) pushEntry(list, refusedCall(400, String(i), i), 3);
  assert.deepEqual(list.map((e) => e.error), ['4', '3', '2']);
});

test('the server reports refused, answered and notification calls through onCall', async (t) => {
  const token = 'b'.repeat(64);
  /** @type {import('../src/shared/mcplog.js').LogEntry[]} */
  const seen = [];
  const tools = new Map([['echo', { description: 'Echo', inputSchema: { type: 'object' }, run: (/** @type {any} */ a) => a }]]);
  const server = createMcpServer({ token, tools, version: '0.1.0', onCall: (e) => seen.push(e) });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const post = (/** @type {object} */ msg, auth = true) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: auth ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(msg),
  });

  await post(call('echo', { a: 1 }), false);
  await post(call('echo', { a: 1 }));
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(seen.map((e) => [e.method, e.tool, e.ok, e.status]), [
    ['(refused)', undefined, false, 401],
    ['tools/call', 'echo', true, undefined],
    ['notifications/initialized', undefined, true, undefined],
  ]);
});

test('mcp.log on disk gets terminal_run commands as a length; the panel entry keeps them', () => {
  const e = describeCall({ msg: call('terminal_run', { command: 'git push https://user:sentinel-token@x.dev/r.git', cwd: 'D:/w' }), out: { result: { content: [] } }, ms: 1, at: 0 });
  assert.match(String(e.args), /git push/, 'the in-memory panel shows what ran');
  const line = logLine(e);
  assert.equal(line.includes('sentinel'), false);
  assert.equal(line.includes('git push'), false);
  assert.equal(JSON.parse(line).args, '{"command":"[48 chars]","cwd":"D:/w"}');
  assert.equal('argsAtRest' in JSON.parse(line), false);
});

test('initialize records the client by name and version, stripped and clipped', () => {
  const init = (/** @type {unknown} */ clientInfo) => describeCall({ msg: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo } }, out: { result: {} }, ms: 0 }).client;
  assert.equal(init({ name: 'claude-code', version: '2.1.307' }), 'claude-code 2.1.307');
  assert.equal(init({ name: 'codex' }), 'codex');
  assert.equal(init({ name: 'evil\u001b[31m\nname', version: 7 }), 'evil[31mname');
  assert.equal(init({ name: 'x'.repeat(200) })?.length, 60);
  assert.equal(init(undefined), undefined);
  assert.equal(init({ name: '' }), undefined);
});

test('expectedCall is a handshake note, not a failure', () => {
  assert.deepEqual(expectedCall(405, 'no stream', 3), { at: 3, method: '(handshake)', ok: true, ms: 0, status: 405, note: 'no stream' });
});

test('query strings and fragments are cut from logged URLs and errors', () => {
  const e = describeCall({ msg: call('open_tab', { url: 'https://x.dev/cb?code=sentinel-1#t=2' }), out: { result: { isError: true, content: [{ type: 'text', text: 'failed https://x.dev/a?token=sentinel-2' }] } }, ms: 0 });
  assert.equal(JSON.stringify(e).includes('sentinel'), false);
  assert.match(String(e.args), /https:\/\/x\.dev\/cb\?…/);
  assert.equal(e.error, 'failed https://x.dev/a?…');
});

test("a later call names its client from its own _meta, else from its session's", () => {
  const call = (/** @type {object} */ params, /** @type {string} */ [client] = []) => describeCall({ msg: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tabs', ...params } }, out: { result: {} }, ms: 0, client }).client;
  assert.equal(call({ _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'opencode', version: '1' } } }, ['claude-code 2']), 'opencode 1');
  assert.equal(call({}, ['claude-code 2']), 'claude-code 2');
  assert.equal(call({}), undefined);
  // Only initialize names a client in params; anything else's clientInfo is ignored.
  assert.equal(call({ clientInfo: { name: 'spoof' } }), undefined);
});

test("server/discover records a modern client's name from _meta", () => {
  const msg = { jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '3.0.0' } } } };
  assert.equal(describeCall({ msg, out: { result: {} }, ms: 0 }).client, 'claude-code 3.0.0');
});

test('mcp.log on disk gets tab_fill text as a length too', () => {
  const e = describeCall({ msg: call('tab_fill', { ref: 2, text: 'sentinel-password' }), out: { result: { content: [] } }, ms: 1, at: 0 });
  assert.match(String(e.args), /sentinel/);
  assert.equal(JSON.parse(logLine(e)).args, '{"ref":2,"text":"[17 chars]"}');
});
