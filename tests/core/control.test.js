import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openAudit } from '../../core/audit.js';
import { METHODS, callControl, queryAudit, startControl } from '../../core/control.js';
import { RunnerError } from '../../core/runner.js';

/** A fake runner that records what it was asked. */
function fakeRunner() {
  const live = new Map();
  const starts = [];
  return {
    starts,
    live,
    start: async (spec) => {
      starts.push(spec);
      if (spec.identity === 'local:refused') throw new RunnerError('the identity is suspended');
      const id = `s${starts.length}`;
      const s = {
        id, identity: spec.identity, workspace: spec.workspace, startedAt: '2026-11-12T00:00:00.000Z',
        input: new PassThrough(), output: new PassThrough(),
        stop: async () => { live.delete(id); return { reason: 'stopped', exitCode: null }; },
      };
      live.set(id, s);
      return s;
    },
    get: (id) => live.get(id),
    list: () => [...live.values()].map(({ id, identity, workspace, startedAt }) => ({ id, identity, workspace, startedAt })),
    stopAll: () => Promise.all([...live.values()].map((s) => s.stop())),
  };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ctl-'));
  const audit = openAudit(path.join(dir, 'audit'));
  const runner = fakeRunner();
  const control = await startControl({ dir, runner, audit });
  t.after(async () => { await control.close(); audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, params) => callControl(dir, method, params, { timeoutMs: 5000 });
  return { dir, audit, runner, control, call };
}

/** Send raw lines on one connection; resolve with every answer line once the Core closes it or `count` arrive. */
function raw(pipe, lines, count = Infinity) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = '';
    const done = () => { sock.destroy(); resolve(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))); };
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(lines.join('\n') + '\n'));
    sock.on('data', (c) => { buf += c; if (buf.split('\n').filter(Boolean).length >= count) done(); });
    sock.on('end', done);
    sock.on('error', reject);
  });
}

test('control.json names the pipe and a token, and goes away on close', async (t) => {
  const s = await setup(t);
  const info = JSON.parse(fs.readFileSync(s.control.file, 'utf8'));
  assert.equal(info.pipe, s.control.pipe);
  assert.equal(info.pid, process.pid);
  assert.ok(info.token.length >= 40);
  if (process.platform === 'win32') assert.match(info.pipe, /^\\\\\.\\pipe\\houston-core-[0-9a-f]{32}$/);
  await s.control.close();
  assert.equal(fs.existsSync(s.control.file), false);
});

test('a request with a wrong or missing token is refused, audited, and its connection closed', async (t) => {
  const s = await setup(t);
  const answers = await raw(s.control.pipe, [
    JSON.stringify({ id: 7, token: 'nope', method: 'session.list' }),
    JSON.stringify({ id: 8, token: JSON.parse(fs.readFileSync(s.control.file, 'utf8')).token, method: 'session.list' }),
  ]);
  // The second line, with the right token, is never answered: the connection closed after the first.
  assert.deepEqual(answers, [{ id: 7, error: { code: 'unauthorized', message: 'bad or missing token' } }]);
  const none = await raw(s.control.pipe, [JSON.stringify({ id: 1, method: 'stop.all' })]);
  assert.equal(none[0].error.code, 'unauthorized');
  const denied = [...s.audit.events()].filter((e) => e.type === 'control.denied');
  assert.deepEqual(denied.map((e) => [e.resource.id, e.decision.result, e.decision.reasons[0]]), [['session.list', 'deny', 'wrong token'], ['stop.all', 'deny', 'no token']]);
});

test('lines that are not JSON objects, and oversized requests, close the connection', async (t) => {
  const s = await setup(t);
  assert.equal((await raw(s.control.pipe, ['{nope']))[0].error.code, 'bad_request');
  assert.equal((await raw(s.control.pipe, ['[1,2]']))[0].error.code, 'bad_request');
  const big = await raw(s.control.pipe, ['x'.repeat(1024 * 1024 + 10)]);
  assert.deepEqual(big[0].error, { code: 'bad_request', message: 'a request is at most 1 MB' });
});

test('unknown methods, including inherited names, are refused', async (t) => {
  const s = await setup(t);
  for (const m of ['session.delete', 'constructor', '__proto__', 'toString']) {
    await assert.rejects(s.call(m), (e) => e.code === 'unknown_method' && e.message.includes(METHODS.join(', ')));
  }
});

test('session.start validates, passes the spec to the runner, drains the terminal, and returns the public fields', async (t) => {
  const s = await setup(t);
  const started = await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w', command: 'cmd.exe', size: { rows: 30, columns: 100 }, program: { pathDirs: ['C:\\Program Files\\nodejs'] } });
  assert.deepEqual(started, { id: 's1', identity: 'local:dev', workspace: 'D:\\w', startedAt: '2026-11-12T00:00:00.000Z' });
  assert.deepEqual(s.runner.starts[0], { identity: 'local:dev', workspace: 'D:\\w', command: 'cmd.exe', attended: undefined, size: { rows: 30, columns: 100 }, program: { readonly: undefined, pathDirs: ['C:\\Program Files\\nodejs'], env: undefined } });
  assert.equal(s.runner.live.get('s1').output.readableFlowing, true);
  assert.deepEqual(await s.call('session.list'), [started]);

  for (const bad of [{}, { identity: 'local:dev', workspace: 'D:\\w' }, { identity: 1, workspace: 'D:\\w', command: 'x' },
    { identity: 'a', workspace: 'b', command: 'c', attended: 'yes' }, { identity: 'a', workspace: 'b', command: 'c', program: { readonly: 'C:\\' } }]) {
    await assert.rejects(s.call('session.start', bad), (e) => e.code === 'bad_request');
  }
  await assert.rejects(s.call('session.start', { identity: 'local:refused', workspace: 'b', command: 'c' }), (e) => e.code === 'refused' && /suspended/.test(e.message));
});

test('session.stop, stop.all', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.call('session.stop', { id: 'missing' }), (e) => e.code === 'not_found');
  await assert.rejects(s.call('session.stop', {}), (e) => e.code === 'bad_request');
  for (let i = 0; i < 3; i++) await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w', command: 'c' });
  assert.deepEqual(await s.call('session.stop', { id: 's2' }), { reason: 'stopped', exitCode: null });
  assert.deepEqual(await s.call('stop.all'), { stopped: 2 });
  assert.deepEqual(await s.call('session.list'), []);
});

test('several requests on one connection are each answered with their id', async (t) => {
  const s = await setup(t);
  const { token } = JSON.parse(fs.readFileSync(s.control.file, 'utf8'));
  const answers = await raw(s.control.pipe, [
    JSON.stringify({ id: 'a', token, method: 'session.list' }),
    JSON.stringify({ id: 'b', token, method: 'nope' }),
    JSON.stringify({ id: 'c', token, method: 'audit.query', params: [] }),
  ], 3);
  assert.deepEqual(answers.map((a) => [a.id, a.error?.code ?? 'ok']).sort(), [['a', 'ok'], ['b', 'unknown_method'], ['c', 'bad_request']]);
});

test('audit.query filters, keeps the newest, and says when it cut', async (t) => {
  const s = await setup(t);
  const ev = (type, session, result, subject = 'local:dev') => s.audit.append({ type, action: type, identity: { subject }, session_id: session, resource: { type: 'Session', id: session }, decision: { result, policy_version: 'v' } });
  ev('session.start', 'x', 'allow'); ev('egress.connect', 'x', 'deny'); ev('egress.connect', 'x', 'allow'); ev('session.start', 'y', 'deny', 'local:other');
  const types = (r) => r.events.map((e) => `${e.type}/${e.session_id}/${e.decision.result}`);
  assert.deepEqual(types(await s.call('audit.query', { session_id: 'x' })), ['session.start/x/allow', 'egress.connect/x/deny', 'egress.connect/x/allow']);
  assert.deepEqual(types(await s.call('audit.query', { type: 'egress.connect', result: 'deny' })), ['egress.connect/x/deny']);
  assert.deepEqual(types(await s.call('audit.query', { identity: 'local:other' })), ['session.start/y/deny']);
  const last = await s.call('audit.query', { session_id: 'x', limit: 2 });
  assert.deepEqual([types(last), last.truncated], [['egress.connect/x/deny', 'egress.connect/x/allow'], true]);
  assert.equal((await s.call('audit.query', { since: '2999-01-01' })).events.length, 0);
  for (const bad of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { since: 'soon' }, { type: 3 }]) {
    await assert.rejects(s.call('audit.query', bad), (e) => e.code === 'bad_request');
  }
  assert.equal(queryAudit(s.audit, {}).truncated, false);
});
