import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_UI, cronsoleConfig, docsTasks, failedTasks, initialize, isCronsoleUrl, listTasks, runFromUrl, runOutput, runRows, runSummary, runTask, runUrl, stdioRpc, taskHistory, taskIdArg, taskRows, taskSummary } from '../src/shared/cronsole.js';

test('cronsoleConfig reads the server path and the UI origin, http(s) only', () => {
  assert.deepEqual(cronsoleConfig({}), { server: '', ui: DEFAULT_UI });
  assert.deepEqual(cronsoleConfig({ ACC_CRONSOLE_MCP: ' "D:/work/cronsole/mcp-server/dist/index.js" ', ACC_CRONSOLE_UI: 'http://127.0.0.1:8080/tasks?x=1' }),
    { server: 'D:/work/cronsole/mcp-server/dist/index.js', ui: 'http://127.0.0.1:8080' });
  for (const bad of ['javascript:alert(1)', 'file:///C:/Users/dev', 'localhost:7373', '   ', 'acc://shell/index.html']) {
    assert.equal(cronsoleConfig({ ACC_CRONSOLE_UI: bad }).ui, DEFAULT_UI, bad);
  }
});

test('isCronsoleUrl matches the UI origin exactly', () => {
  assert.equal(isCronsoleUrl('http://localhost:7373/', DEFAULT_UI), true);
  assert.equal(isCronsoleUrl('http://localhost:7373/tasks/abc', DEFAULT_UI), true);
  assert.equal(isCronsoleUrl('http://localhost:7374/', DEFAULT_UI), false);
  assert.equal(isCronsoleUrl('https://localhost:7373/', DEFAULT_UI), false);
  assert.equal(isCronsoleUrl('http://localhost:7373.example.com/', DEFAULT_UI), false);
  assert.equal(isCronsoleUrl('', DEFAULT_UI), false);
  assert.equal(isCronsoleUrl('not a url', DEFAULT_UI), false);
});

/**
 * A fake Cronsole MCP server on the other end of stdioRpc: answers each request line,
 * in chunks split mid-line, with a log line and a server notification mixed in.
 * @param {(msg: any) => any} answer
 */
function fakeServer(answer) {
  /** @type {any[]} */
  const seen = [];
  /** @type {ReturnType<typeof stdioRpc>} */
  const rpc = stdioRpc((line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    if (!('id' in msg)) return;
    const out = `not json\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer(msg) })}\n`;
    const mid = Math.floor(out.length / 2);
    setImmediate(() => { rpc.receive(out.slice(0, mid)); rpc.receive(out.slice(mid)); });
  });
  return { rpc, seen };
}

const TASK = { id: 't1', name: 'Nightly backup', platform: 'WINDOWS_TASK_SCHEDULER', category: null, schedule: '0 2 * * *', status: 'ACTIVE', nextRunTime: '2026-10-05T02:00:00.000Z', lastRunStatus: 'SUCCESS', lastRunAt: '2026-10-04T02:00:00.000Z' };

test('initialize then list_tasks over stdio, the way the sidebar asks', async () => {
  const { rpc, seen } = fakeServer((msg) => {
    if (msg.method === 'initialize') return { result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cronsole' } } };
    if (msg.method === 'tools/call') return { result: { content: [{ type: 'text', text: '1 task(s).' }], structuredContent: { matched: 1, returned: 1, tasks: [TASK] } } };
    return { error: { code: -32601, message: 'nope' } };
  });
  await initialize(rpc, '0.1.0');
  const tasks = await listTasks(rpc);
  assert.deepEqual(seen.map((m) => m.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(seen[0].params.clientInfo.name, 'ai-command-center');
  assert.deepEqual(seen[2].params, { name: 'list_tasks', arguments: { limit: 500 } });
  assert.deepEqual(tasks, [{ id: 't1', name: 'Nightly backup', platform: 'WINDOWS_TASK_SCHEDULER', schedule: '0 2 * * *', status: 'ACTIVE', nextRunTime: '2026-10-05T02:00:00.000Z', lastRunStatus: 'SUCCESS', lastRunAt: '2026-10-04T02:00:00.000Z' }]);
});

test('runTask calls run_task with the id and returns the result; a tool error throws; a failed run is a result', async () => {
  const { rpc, seen } = fakeServer((msg) => {
    const id = msg.params?.arguments?.taskId;
    if (id === 'bad') return { result: { isError: true, content: [{ type: 'text', text: 'No task with id bad' }] } };
    if (id === 'text-only') return { result: { content: [{ type: 'text', text: 'Started.' }] } };
    return { result: { content: [{ type: 'text', text: 'ran' }], structuredContent: { ran: true, success: false, exitCode: 1 } } };
  });
  assert.deepEqual(await runTask(rpc, 't1'), { ran: true, success: false, exitCode: 1 });
  assert.deepEqual(seen.at(-1).params, { name: 'run_task', arguments: { taskId: 't1' } });
  assert.deepEqual(await runTask(rpc, 'text-only'), { text: 'Started.' });
  await assert.rejects(runTask(rpc, 'bad'), /No task with id bad/);
});

test('taskIdArg takes a short printable id and refuses the rest', () => {
  assert.equal(taskIdArg(' t1 '), 't1');
  for (const bad of ['', '  ', 5, null, 'a\nb', 'x\u200b', 'y'.repeat(201)]) assert.throws(() => taskIdArg(bad), String(bad));
});

test('stdioRpc surfaces JSON-RPC errors, times out, and fails what is pending', async () => {
  const { rpc } = fakeServer(() => ({ error: { code: -32601, message: 'Method not found' } }));
  await assert.rejects(rpc.request('x'), /Method not found/);

  const silent = stdioRpc(() => {}, 20);
  await assert.rejects(silent.request('initialize'), /didn't answer initialize/);

  const dying = stdioRpc(() => {});
  const p = dying.request('tools/call');
  dying.receive('{"jsonrpc":"2.0","id":99,"result":{}}\n{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage"}\n');
  dying.fail(new Error('exited (1)'));
  await assert.rejects(p, /exited \(1\)/);
});

test('taskRows: tool errors throw their text, malformed rows are dropped or nulled', () => {
  assert.throws(() => taskRows({ isError: true, content: [{ type: 'text', text: 'Cronsole API error (HTTP 403): Invalid or expired token' }] }), /HTTP 403/);
  assert.throws(() => taskRows({ isError: true }), /refused list_tasks/);
  assert.deepEqual(taskRows(null), []);
  assert.deepEqual(taskRows({ content: [] }), []);
  assert.deepEqual(taskRows({ structuredContent: { tasks: 'junk' } }), []);
  const rows = taskRows({ structuredContent: { tasks: [null, 7, { id: 'x' }, { name: 'no id' }, { id: 'a', name: 'A', platform: 3, schedule: '', status: null, nextRunTime: {}, lastRunAt: 'then' }] } });
  assert.deepEqual(rows, [{ id: 'a', name: 'A', platform: 'UNKNOWN', schedule: null, status: 'UNKNOWN', nextRunTime: null, lastRunStatus: null, lastRunAt: 'then' }]);
});

test('taskSummary: next run, paused, missing and failed tasks', () => {
  const now = Date.parse('2026-10-04T20:00:00.000Z');
  const row = /** @type {import('../src/shared/cronsole.js').CronTask} */ ({ ...TASK, nextRunTime: '2026-10-04T20:30:00.000Z' });
  assert.deepEqual({ ...taskSummary(row, now), title: undefined }, { icon: '⏱', sub: 'in 30m', title: undefined, failed: false });
  assert.match(taskSummary(row, now).title, /Nightly backup {2}\[WINDOWS_TASK_SCHEDULER\]\nSchedule: 0 2 \* \* \*\nStatus: ACTIVE\nNext run: .*\nLast run: .*\(SUCCESS\)/);
  assert.equal(taskSummary({ ...row, nextRunTime: '2026-10-05T02:00:00.000Z' }, now).sub, 'in 6h');
  assert.equal(taskSummary({ ...row, nextRunTime: '2026-10-09T20:00:00.000Z' }, now).sub, 'in 5d');
  assert.equal(taskSummary({ ...row, nextRunTime: '2026-10-04T19:00:00.000Z' }, now).sub, 'due');
  assert.equal(taskSummary({ ...row, nextRunTime: null }, now).sub, '0 2 * * *');
  assert.equal(taskSummary({ ...row, nextRunTime: 'garbage', schedule: null }, now).sub, '');
  assert.deepEqual([taskSummary({ ...row, status: 'DISABLED' }, now).icon, taskSummary({ ...row, status: 'DISABLED' }, now).sub], ['⏸', 'disabled']);
  assert.equal(taskSummary({ ...row, status: 'MISSING' }, now).icon, '⚠');
  const failed = taskSummary({ ...row, lastRunStatus: 'FAILURE' }, now);
  assert.equal(failed.icon, '✗');
  assert.equal(failed.failed, true);
});

test('failedTasks counts active tasks whose last run failed', () => {
  const t = /** @type {import('../src/shared/cronsole.js').CronTask} */ ({ ...TASK });
  const tasks = [
    t,
    { ...t, id: 'a', lastRunStatus: 'FAILURE' },
    { ...t, id: 'b', lastRunStatus: 'error: exit 1' },
    { ...t, id: 'c', lastRunStatus: 'FAILURE', status: 'DISABLED' },
    { ...t, id: 'd', lastRunStatus: 'FAILURE', status: 'MISSING' },
    { ...t, id: 'e', lastRunStatus: null },
  ];
  assert.deepEqual(failedTasks(tasks).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(failedTasks([]), []);
});

test('docsTasks keeps tasks whose name has a docs word, whole words only', () => {
  const t = /** @type {import('../src/shared/cronsole.js').CronTask} */ ({ ...TASK });
  const names = ['Docs link check', 'README refresh', 'diagram-upkeep', 'weekly_changelog', 'Doc drift (houston)', 'Documentation sweep',
    'Dockerfile lint', 'Roadmap routine', 'Nightly backup', 'readmeish', 'docsite deploy', ''];
  const kept = docsTasks(names.map((name, i) => ({ ...t, id: String(i), name }))).map((x) => x.name);
  assert.deepEqual(kept, ['Docs link check', 'README refresh', 'diagram-upkeep', 'weekly_changelog', 'Doc drift (houston)', 'Documentation sweep']);
  assert.deepEqual(docsTasks([]), []);
});

const RUN = { id: 'e1', status: 'FAILURE', triggeredAt: '2026-10-04T02:00:00.000Z', durationMs: 4200, log: '2 broken links', platformRunId: null };

test('taskHistory asks get_task_history for the last 5 runs; runOutput asks get_run_output for one; tool errors throw', async () => {
  const { rpc, seen } = fakeServer((msg) => {
    const { name, arguments: args } = msg.params;
    if (args.taskId === 'bad') return { result: { isError: true, content: [{ type: 'text', text: 'Task not found' }] } };
    if (name === 'get_task_history') return { result: { content: [{ type: 'text', text: '1 run' }], structuredContent: { taskId: 't1', returned: 1, runs: [RUN] } } };
    return { result: { content: [{ type: 'text', text: 'What it did: read → write' }, { type: 'text', text: 'Output:\nok' }], structuredContent: { available: true } } };
  });
  assert.deepEqual(await taskHistory(rpc, 't1'), [RUN]);
  assert.deepEqual(seen.at(-1).params, { name: 'get_task_history', arguments: { taskId: 't1', limit: 5 } });
  assert.equal(await runOutput(rpc, 't1', 'run_9'), 'What it did: read → write\nOutput:\nok');
  assert.deepEqual(seen.at(-1).params, { name: 'get_run_output', arguments: { taskId: 't1', runId: 'run_9', maxChars: 20000 } });
  await assert.rejects(taskHistory(rpc, 'bad'), /Task not found/);
  await assert.rejects(runOutput(rpc, 'bad', 'run_9'), /Task not found/);
});

test('runRows: no history is empty, malformed rows are dropped or nulled, at most 5', () => {
  assert.deepEqual(runRows({ content: [{ type: 'text', text: 'No run history recorded for this task.' }], structuredContent: { runs: [] } }), []);
  assert.deepEqual(runRows({}), []);
  assert.deepEqual(runRows({ structuredContent: { runs: 'nope' } }), []);
  assert.deepEqual(runRows({ structuredContent: { runs: [null, { status: 'SUCCESS' }, { id: 'e2', status: 7, durationMs: 'slow', log: '', platformRunId: 'p1' }] } }),
    [{ id: 'e2', status: 'UNKNOWN', triggeredAt: null, durationMs: null, log: null, platformRunId: 'p1' }]);
  assert.equal(runRows({ structuredContent: { runs: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}` })) } }).length, 5);
  assert.throws(() => runRows({ isError: true, content: [] }), /refused get_task_history/);
});

test('runUrl and runFromUrl round-trip ids, and refuse anything else', () => {
  const url = runUrl('task/1', 'run 2');
  assert.equal(url, 'acc://run/task%2F1/run%202');
  assert.deepEqual(runFromUrl(url), { taskId: 'task/1', runId: 'run 2' });
  for (const bad of ['acc://doc/a/b', 'https://run/a/b', 'acc://run/a', 'acc://run/a/b/c', 'acc://run//b', 'acc://run/a/%E0%A4%A', 'acc://run/a/%0Ab']) {
    assert.throws(() => runFromUrl(bad), bad);
  }
});

test('runSummary: when, status and how long; failures and timeouts are marked', () => {
  const now = Date.parse('2026-10-04T05:00:00.000Z');
  assert.deepEqual(runSummary(RUN, now), { icon: '✗', text: '3h ago · failure · 4.2 s', title: 'Started: 2026-10-04T02:00:00.000Z\nStatus: FAILURE\nTook: 4.2 s\nClick to show its output', failed: true });
  assert.equal(runSummary({ ...RUN, status: 'TIMEOUT' }, now).failed, true);
  const ok = runSummary({ ...RUN, status: 'SUCCESS', durationMs: 300_000, triggeredAt: '2026-10-04T04:59:30.000Z' }, now);
  assert.equal(ok.icon, '✓');
  assert.equal(ok.text, 'just now · success · 5 min');
  assert.equal(runSummary({ ...RUN, status: 'PENDING', durationMs: null, triggeredAt: null }, now).text, 'unknown time · pending');
});
