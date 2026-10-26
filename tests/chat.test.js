import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_URL, API_VERSION, STOPPED, addUserText, chatAttach, chatConfig, chatText, cleanMessages, estimateTokens, mcpClient, messagesApi, readStream, runTurn, toApiTools, toolOutcome, transcript, trimHistory, trayItem, withAttachments } from '../src/shared/chat.js';
import { createMcpServer } from '../src/shared/mcp.js';

test('chatConfig reads the key and model from the environment, with no default model', () => {
  assert.deepEqual(chatConfig({}), { apiKey: '', model: '', missing: ['ANTHROPIC_API_KEY (or ACC_CHAT_API_KEY)', 'ACC_CHAT_MODEL (or ANTHROPIC_MODEL)'] });
  assert.deepEqual(chatConfig({ ANTHROPIC_API_KEY: ' k1 ', ANTHROPIC_MODEL: ' m1 ' }), { apiKey: 'k1', model: 'm1', missing: [] });
  const both = chatConfig({ ANTHROPIC_API_KEY: 'k1', ACC_CHAT_API_KEY: 'k2', ANTHROPIC_MODEL: 'm1', ACC_CHAT_MODEL: 'm2' });
  assert.equal(both.apiKey, 'k2');
  assert.equal(both.model, 'm2');
  assert.deepEqual(chatConfig({ ANTHROPIC_API_KEY: '   ', ACC_CHAT_MODEL: 'm' }).missing, ['ANTHROPIC_API_KEY (or ACC_CHAT_API_KEY)']);
});

test('chatText trims and refuses blank, oversized and non-string input', () => {
  assert.equal(chatText('  hi  '), 'hi');
  assert.throws(() => chatText('   '));
  assert.throws(() => chatText(undefined));
  assert.throws(() => chatText({ text: 'hi' }));
  assert.throws(() => chatText('x'.repeat(20_001)));
});

test('toApiTools and toolOutcome translate between MCP and the Messages API', () => {
  assert.deepEqual(toApiTools([{ name: 'a', description: 'A', inputSchema: { type: 'object', properties: {} } }, { name: 'b' }]), [
    { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
    { name: 'b', description: '', input_schema: { type: 'object' } },
  ]);
  assert.deepEqual(toolOutcome({ result: { content: [{ type: 'text', text: '{"id":1}' }] } }), { text: '{"id":1}', isError: false });
  assert.deepEqual(toolOutcome({ result: { content: [{ type: 'text', text: 'denied' }], isError: true } }), { text: 'denied', isError: true });
  assert.deepEqual(toolOutcome({ error: { code: -32602, message: 'Unknown tool: x' } }), { text: 'Unknown tool: x', isError: true });
  assert.deepEqual(toolOutcome(null), { text: 'null', isError: false });
  assert.deepEqual(toolOutcome({ result: { content: 'junk' } }), { text: 'null', isError: false });
});

test('addUserText keeps the roles alternating', () => {
  /** @type {import('../src/shared/chat.js').Message[]} */
  const m = [];
  addUserText(m, 'one');
  assert.deepEqual(m, [{ role: 'user', content: 'one' }]);
  addUserText(m, 'two');
  assert.deepEqual(m, [{ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }]);
  m.push({ role: 'assistant', content: 'ok' });
  addUserText(m, 'three');
  assert.equal(m.length, 3);
});

/** @param {any[]} replies */
const scripted = (replies) => {
  /** @type {any[]} */
  const bodies = [];
  return { bodies, post: async (/** @type {any} */ body) => { bodies.push(structuredClone(body)); return replies.shift(); } };
};

test('runTurn posts, runs the tools Claude asks for, and posts the results', async () => {
  const { bodies, post } = scripted([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Opening it.' }, { type: 'tool_use', id: 't1', name: 'open_tab', input: { url: 'example.com' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  ]);
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const messages = [];
  await runTurn({
    messages, text: 'open example.com', model: 'm', tools: [{ name: 'open_tab' }], post,
    callTool: async (name, input) => ({ text: JSON.stringify({ name, input }), isError: false }),
    onEvent: (e) => events.push(e),
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].model, 'm');
  assert.deepEqual(bodies[0].tools, [{ name: 'open_tab', description: '', input_schema: { type: 'object' } }]);
  assert.deepEqual(bodies[1].messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"name":"open_tab","input":{"url":"example.com"}}', is_error: false }] });
  assert.deepEqual(events.map((e) => e.type), ['text', 'tool', 'result', 'text']);
  assert.equal(messages.length, 4);
});

test('runTurn reports tool errors and thrown tools to Claude, and stops after maxSteps', async () => {
  const use = (/** @type {string} */ id) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'boom', input: {} }] });
  const { bodies, post } = scripted([use('a'), use('b'), use('c')]);
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const messages = [];
  await runTurn({
    messages, text: 'go', model: 'm', tools: [], post, maxSteps: 2,
    callTool: async () => { throw new Error('nope'); },
    onEvent: (e) => events.push(e),
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(messages[2].content, [{ type: 'tool_result', tool_use_id: 'a', content: 'nope', is_error: true }]);
  assert.match(events.at(-1).text, /Stopped after 2 rounds/);
  // The next message joins the trailing tool results instead of starting a second user turn.
  addUserText(messages, 'carry on');
  assert.equal(messages.at(-1).content.at(-1).text, 'carry on');
  assert.equal(messages.at(-2).role, 'assistant');
});

test('chatAttach takes page and terminal only, and refuses anything else', () => {
  assert.deepEqual(chatAttach(undefined), []);
  assert.deepEqual(chatAttach(null), []);
  assert.deepEqual(chatAttach([]), []);
  assert.deepEqual(chatAttach(['terminal', 'page', 'page']), ['terminal', 'page']);
  assert.throws(() => chatAttach('page'), /page and terminal only/);
  assert.throws(() => chatAttach(['page', 'cron_run']));
  assert.throws(() => chatAttach(['__proto__']));
  assert.throws(() => chatAttach([{}]));
});

test('withAttachments puts each attachment above the text, or says it failed', () => {
  assert.equal(withAttachments('hi', []), 'hi');
  assert.equal(
    withAttachments('what failed?', [{ kind: 'page', text: 'P', isError: false }, { kind: 'terminal', text: 'No terminal is open', isError: true }]),
    "<attached page>\nP\n</attached page>\n\n(The terminal couldn't be attached: No terminal is open)\n\nwhat failed?",
  );
});

test("runTurn sends the tray's snapshots as they are, without reading again", async () => {
  const { bodies, post } = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  /** @type {string[]} */
  const called = [];
  await runTurn({
    messages: [], text: 'summarise', model: 'm', tools: [], post,
    attached: [{ kind: 'page', text: 'Example Domain', isError: false }, { kind: 'terminal', text: 'PS> npm test', isError: false }],
    callTool: async (name) => { called.push(name); return { text: 'fresh', isError: false }; },
  });
  assert.deepEqual(called, []);
  assert.equal(bodies[0].messages[0].content, '<attached page>\nExample Domain\n</attached page>\n\n<attached terminal>\nPS> npm test\n</attached terminal>\n\nsummarise');
});

test('trayItem says what an attachment is, where it came from and how big, and keeps the exact text', () => {
  const page = JSON.stringify({ id: 3, url: 'https://example.com/', title: ' Example Domain ', text: 'x'.repeat(1200), truncated: true });
  assert.deepEqual(trayItem('page', page), {
    kind: 'page', label: 'Page: Example Domain', detail: 'https://example.com/ · 1,200 characters, cut to fit', text: page,
  });
  assert.equal(trayItem('page', JSON.stringify({ url: 'about:blank', title: '', text: '' })).label, 'Page: Untitled page');
  const term = JSON.stringify({ terminal: 2, text: 'a\nb\nc' });
  assert.deepEqual(trayItem('terminal', term), { kind: 'terminal', label: 'Terminal 2', detail: 'last 3 lines', text: term });
  assert.equal(trayItem('terminal', JSON.stringify({ terminal: 1, text: 'one' })).detail, 'last 1 line');
  // Not JSON: counted as it is, still sent as it is.
  assert.deepEqual(trayItem('terminal', 'plain'), { kind: 'terminal', label: 'Terminal', detail: 'last 1 line', text: 'plain' });
  assert.equal(trayItem('page', 'null').detail, '4 characters');
});

test('runTurn answers every tool_use even when the stop reason is not tool_use', async () => {
  const { bodies, post } = scripted([
    { stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: 'x', name: 'recent', input: {} }] },
    { stop_reason: 'end_turn', content: [] },
  ]);
  await runTurn({ messages: [], text: 'hi', model: 'm', tools: [], post, callTool: async () => ({ text: '[]', isError: false }) });
  assert.equal(bodies.length, 2);
});

test('messagesApi sends the key and version headers and surfaces API errors', async () => {
  /** @type {any[]} */
  const calls = [];
  /** @param {number} status @param {any} json */
  const fake = (status, json) => /** @type {typeof fetch} */ (async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status });
  });
  const ok = await messagesApi('sk-test', fake(200, { content: [], stop_reason: 'end_turn' }))({ model: 'm' });
  assert.deepEqual(ok, { content: [], stop_reason: 'end_turn' });
  assert.equal(calls[0].url, API_URL);
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
  assert.equal(calls[0].init.headers['anthropic-version'], API_VERSION);
  await assert.rejects(messagesApi('k', fake(401, { error: { message: 'invalid x-api-key' } }))({}), /401: invalid x-api-key/);
  await assert.rejects(messagesApi('k', fake(200, { nope: true }))({}), /without content/);
  const html = /** @type {typeof fetch} */ (async () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' }));
  await assert.rejects(messagesApi('k', html)({}), /502/);
});

test('a chat turn drives a real MCP server over HTTP with its token', async (t) => {
  const TOKEN = 'b'.repeat(64);
  /** @type {any[]} */
  const opened = [];
  const tools = new Map([
    ['open_tab', { description: 'Open a tab', inputSchema: { type: 'object' }, run: (/** @type {any} */ a) => { opened.push(a.url); return { id: 7 }; } }],
    ['terminal_run', { description: 'Run', inputSchema: { type: 'object' }, run: () => { throw new Error('The user denied this command.'); } }],
  ]);
  /** @type {string[]} */
  const logged = [];
  const server = createMcpServer({ token: TOKEN, tools, version: '0', onCall: (e) => logged.push(`${e.tool || e.method} ${e.client}`) });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://127.0.0.1:${port}/mcp`;

  const client = mcpClient(url, TOKEN);
  const list = await client.list();
  assert.deepEqual(list.map((x) => x.name), ['open_tab', 'terminal_run']);
  const { bodies, post } = scripted([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'u1', name: 'open_tab', input: { url: 'example.com' } },
      { type: 'tool_use', id: 'u2', name: 'terminal_run', input: { command: 'npm test' } },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Opened; the command was denied.' }] },
  ]);
  await runTurn({ messages: [], text: 'go', model: 'm', tools: list, post, callTool: (n, a) => client.call(n, a) });
  assert.deepEqual(opened, ['example.com']);
  assert.deepEqual(bodies[1].messages[2].content, [
    { type: 'tool_result', tool_use_id: 'u1', content: '{"id":7}', is_error: false },
    { type: 'tool_result', tool_use_id: 'u2', content: 'The user denied this command.', is_error: true },
  ]);
  // Each call names the chat, from its 2026-07-28 _meta.
  assert.deepEqual(logged, ['tools/list houston-chat', 'open_tab houston-chat', 'terminal_run houston-chat']);

  const wrong = mcpClient(url, 'wrong');
  assert.deepEqual(await wrong.call('open_tab', {}), { text: 'MCP server answered 401', isError: true });
  await assert.rejects(wrong.list(), /401/);
});

/** A streamed reply as server-sent events, cut into awkward chunks. @param {any[]} events @param {number} size */
const sse = (events, size) => {
  const text = events.map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
  /** @type {string[]} */
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
};
const STREAM = [
  { type: 'message_start', message: { content: [] } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Open' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ing é.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'open_tab', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"example.com"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't2', name: 'recent', input: {} } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
];

test('readStream puts a streamed reply back together, whatever the chunk size', async () => {
  for (const size of [1, 7, 10_000]) {
    /** @type {string[]} */
    const texts = [];
    const reply = await readStream(sse(STREAM, size), (t) => texts.push(t));
    assert.deepEqual(reply, { stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Opening é.' },
      { type: 'tool_use', id: 't1', name: 'open_tab', input: { url: 'example.com' } },
      { type: 'tool_use', id: 't2', name: 'recent', input: {} },
    ] }, `chunk size ${size}`);
    assert.equal(texts.join(''), 'Opening é.');
  }
  // Bytes split inside a multi-byte character decode as one.
  const bytes = new TextEncoder().encode(sse(STREAM, 1e6)[0]);
  const at = bytes.indexOf(0xc3) + 1;
  const reply = await readStream([bytes.slice(0, at), bytes.slice(at)]);
  assert.deepEqual(reply.content[0], { type: 'text', text: 'Opening é.' });
});

test('readStream drops empty text and refuses errors, broken input and a cut-off stream', async () => {
  const empty = [STREAM[1], STREAM[5], { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }];
  assert.deepEqual(await readStream(sse(empty, 5)), { content: [], stop_reason: 'end_turn' });
  await assert.rejects(readStream(sse([STREAM[0], { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }], 9)), /Overloaded/);
  const broken = [STREAM[6], { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"url":' } }, STREAM[9]];
  await assert.rejects(readStream(sse(broken, 9)), /open_tab broken input/);
  await assert.rejects(readStream(sse(STREAM.slice(0, 5), 9)), /ended before/);
  await assert.rejects(readStream(['data: not json\n\n']), /ended before/);
});

test('messagesApi asks for a stream and passes the text along as it arrives', async () => {
  /** @type {any} */
  let sent;
  const fake = /** @type {typeof fetch} */ (async (url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(sse(STREAM, 13).join(''), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  });
  /** @type {string[]} */
  const texts = [];
  const reply = await messagesApi('k', fake)({ model: 'm' }, (t) => texts.push(t));
  assert.equal(sent.stream, true);
  assert.equal(reply.content.length, 3);
  assert.deepEqual(texts, ['Open', 'ing é.']);
});

test('runTurn shows streamed text as deltas, not again as text, and skips an empty reply', async () => {
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const messages = [];
  await runTurn({
    messages, text: 'hi', model: 'm', tools: [], callTool: async () => ({ text: '', isError: false }),
    post: async (_body, onText) => { onText('He'); onText('llo'); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello' }] }; },
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(events, [{ type: 'delta', text: 'He' }, { type: 'delta', text: 'llo' }]);
  await runTurn({ messages, text: 'again', model: 'm', tools: [], callTool: async () => ({ text: '', isError: false }), post: async () => ({ stop_reason: 'end_turn', content: [] }) });
  // The empty reply isn't kept, so the next message joins this user turn.
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

/** A conversation of `turns` user/assistant pairs, each question about `size` characters. @param {number} turns @param {number} size @returns {any[]} */
const conversation = (turns, size) => Array.from({ length: turns }, (_, i) => [
  { role: 'user', content: `q${i} ${'x'.repeat(size)}` },
  { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] },
]).flat();

test('trimHistory drops whole turns, oldest first, and always keeps the last', () => {
  const m = conversation(5, 400);
  assert.equal(trimHistory(m, 1e6), 0);
  assert.equal(m.length, 10);
  assert.equal(trimHistory(m, 250), 6);
  assert.deepEqual(m.map((x) => (typeof x.content === 'string' ? x.content.slice(0, 2) : 'a')), ['q3', 'a', 'q4', 'a']);
  assert.equal(trimHistory(m, 1), 2);
  assert.equal(m.length, 2);
  assert.equal(trimHistory(m, 1), 0);
  assert.equal(trimHistory([], 1), 0);
  // A user message holding tool results never becomes the first message.
  /** @type {any[]} */
  const tools = [
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'recent', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: '[]', is_error: false }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  assert.equal(trimHistory(tools, 10), 0);
  assert.equal(estimateTokens({ role: 'user', content: 'abcd' }), Math.ceil('{"role":"user","content":"abcd"}'.length / 4));
});

test('runTurn trims an over-budget conversation before posting and says so', async () => {
  const messages = conversation(3, 400);
  /** @type {any[]} */
  const events = [];
  const { bodies, post } = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  await runTurn({ messages, text: 'new', model: 'm', tools: [], post, callTool: async () => ({ text: '', isError: false }), budget: 50, onEvent: (e) => events.push(e) });
  assert.deepEqual(bodies[0].messages, [{ role: 'user', content: 'new' }]);
  assert.equal(events[0].type, 'note');
  assert.match(events[0].text, /Dropped the 6 oldest messages/);
});

test('cleanMessages keeps a well-formed conversation and empties anything else', () => {
  const good = conversation(2, 3);
  assert.deepEqual(cleanMessages(structuredClone(good)), good);
  for (const bad of [null, {}, 'chat', [], [{ role: 'assistant', content: 'hi' }], [{ role: 'user', content: '' }],
    [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], [{ role: 'user', content: [{ type: 'image' }] }],
    [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: [] }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'x', input: null }] }],
    [{ role: 'user', content: 'a' }, null]]) {
    assert.deepEqual(cleanMessages(bad), [], JSON.stringify(bad));
  }
  // Cut off between a tool call and its result: the call goes.
  const cut = [...good, { role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'recent', input: {} }] }];
  assert.deepEqual(cleanMessages(cut), [...good, { role: 'user', content: 'q' }]);
});

test('transcript replays a saved conversation with attachments folded', () => {
  /** @type {any[]} */
  const m = [
    { role: 'user', content: withAttachments('what failed?', [{ kind: 'page', text: 'P\n</p>', isError: false }, { kind: 'terminal', text: 'No terminal', isError: true }]) },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'u', name: 'recent', input: { limit: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'y'.repeat(400), is_error: true }, { type: 'text', text: 'and?' }] },
  ];
  assert.deepEqual(transcript(m), [
    { type: 'user', text: '[+ page] [+ terminal] what failed?' },
    { type: 'text', text: 'Looking.' },
    { type: 'tool', name: 'recent', input: { limit: 1 } },
    { type: 'result', name: 'recent', ok: false, text: 'y'.repeat(300) },
    { type: 'user', text: 'and?' },
  ]);
  assert.deepEqual(transcript([]), []);
});

/** A promise that rejects with the signal's reason when it aborts. @param {AbortSignal | undefined} signal */
const hang = (signal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

test('Stop during the model request rejects the turn and leaves the conversation sendable', async () => {
  /** @type {any[]} */
  const messages = [];
  const ctrl = new AbortController();
  const turn = runTurn({ messages, text: 'hi', model: 'm', tools: [], post: (_b, _t, signal) => hang(signal), callTool: async () => ({ text: '', isError: false }), signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(turn);
  assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
});

test('Stop during a tool call answers the open tool_use as stopped, so the next request is valid', async () => {
  /** @type {any[]} */
  const messages = [];
  const ctrl = new AbortController();
  /** @type {AbortSignal | undefined} */
  let toolSignal;
  const post = async () => ({ content: [{ type: 'tool_use', id: 'u1', name: 'terminal_run', input: { command: 'npm test' } }], stop_reason: 'tool_use' });
  const turn = runTurn({
    messages, text: 'run tests', model: 'm', tools: [], post, signal: ctrl.signal,
    callTool: (_n, _i, signal) => { toolSignal = signal; return hang(signal); },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(toolSignal, ctrl.signal, 'the tool call gets the Stop signal');
  ctrl.abort();
  await assert.rejects(turn);
  assert.deepEqual(messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: STOPPED, is_error: true }] });
});

test('a tool call that fails on its own (a deadline) is reported to Claude, not treated as Stop', async () => {
  /** @type {any[]} */
  const messages = [];
  let posts = 0;
  const post = async () => (posts++ === 0
    ? { content: [{ type: 'tool_use', id: 'u1', name: 'list_tabs', input: {} }], stop_reason: 'tool_use' }
    : { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  await runTurn({ messages, text: 'x', model: 'm', tools: [], post, signal: new AbortController().signal, callTool: async () => { throw new Error('timed out'); } });
  assert.deepEqual(messages[2].content[0], { type: 'tool_result', tool_use_id: 'u1', content: 'timed out', is_error: true });
});
