import test from 'node:test';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openAudit } from '../../core/audit.js';
import { createTranscripts } from '../../core/transcripts.js';
import { createApprovals } from '../../core/approvals.js';
import { attachSession } from '../../core/client.js';
import { METHODS, callControl, queryAudit, startControl } from '../../core/control.js';
import { migrate, openDb } from '../../core/db.js';
import { OPERATOR, createRegistry, ensureOperator } from '../../core/identities.js';
import { RunnerError } from '../../core/runner.js';
import { core } from '../../src/main/core.js';

const CTL = fileURLToPath(new URL('../../core/ctl.js', import.meta.url));

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
      let settle;
      const done = new Promise((r) => { settle = r; });
      const s = {
        id, identity: spec.identity, workspace: spec.workspace, startedAt: '2026-11-12T00:00:00.000Z',
        input: new PassThrough(), output: new PassThrough(), sizes: [], done,
        resize: (size) => s.sizes.push(size),
        exit: (code) => { live.delete(id); settle({ reason: `exit ${code}`, exitCode: code }); },
        stop: async () => { live.delete(id); const end = { reason: 'stopped', exitCode: null }; settle(end); return end; },
      };
      live.set(id, s);
      return s;
    },
    get: (id) => live.get(id),
    list: () => [...live.values()].map(({ id, identity, workspace, startedAt }) => ({ id, identity, workspace, startedAt })),
    stopAll: () => Promise.all([...live.values()].map((s) => s.stop())),
    backends: () => [{ name: 'codex', displayName: 'Codex', hosts: ['chatgpt.com:443'], signIn: 'x', installed: true }],
  };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ctl-'));
  const audit = openAudit(path.join(dir, 'audit'));
  const runner = fakeRunner();
  const db = openDb(':memory:');
  migrate(db);
  ensureOperator(db, audit);
  const registry = createRegistry({ db, audit });
  const approvals = createApprovals({ audit });
  const transcripts = createTranscripts({ dir: path.join(dir, 'transcripts'), audit });
  const control = await startControl({ dir, runner, registry, audit, schema: 3, approvals, transcripts });
  t.after(async () => { await control.close(); audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, params) => callControl(dir, method, params, { timeoutMs: 5000 });
  return { dir, audit, runner, control, call, approvals };
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

  // No command is the runner's call (a backend identity's manifest sets it), so it passes through as undefined.
  await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w' });
  assert.equal(s.runner.starts[1].command, undefined);
  for (const bad of [{}, { identity: 'local:dev', workspace: 'D:\\w', command: 3 }, { identity: 1, workspace: 'D:\\w', command: 'x' },
    { identity: 'a', workspace: 'b', command: 'c', attended: 'yes' }, { identity: 'a', workspace: 'b', command: 'c', program: { readonly: 'C:\\' } }]) {
    await assert.rejects(s.call('session.start', bad), (e) => e.code === 'bad_request');
  }
  await assert.rejects(s.call('session.start', { identity: 'local:refused', workspace: 'b', command: 'c' }), (e) => e.code === 'refused' && /suspended/.test(e.message));
});

test('backend.list returns the runner\'s manifests', async (t) => {
  const s = await setup(t);
  assert.deepEqual((await s.call('backend.list')).map((b) => [b.name, b.installed]), [['codex', true]]);
});

test('session.attach: replays recent output, streams the rest, types and resizes, and ends with the session', async (t) => {
  const s = await setup(t);
  await assert.rejects(attachSession(s.dir, 'nope', { onData() {}, onEnd() {} }), (e) => e.code === 'not_found');
  await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w', command: 'c' });
  const live = s.runner.live.get('s1');
  // Split inside a multi-byte character: the Core decodes across chunks.
  const euro = Buffer.from('€');
  live.output.write(Buffer.concat([Buffer.from('before '), euro.subarray(0, 1)]));
  live.output.write(euro.subarray(1));
  await new Promise((r) => setImmediate(r));

  const seen = [];
  let ended;
  const gotEnd = new Promise((r) => { ended = r; });
  const a = await attachSession(s.dir, 's1', { onData: (d) => seen.push(d), onEnd: ended });
  const typed = new Promise((r) => live.input.once('data', (d) => r(String(d))));
  a.write('dir\r');
  assert.equal(await typed, 'dir\r');
  a.resize(40, 9999);
  live.output.write('after');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(live.sizes, [{ rows: 40, columns: 500 }]);
  assert.equal(seen.join(''), 'before €after');

  // A second viewer gets the same tail; detaching it leaves the session running.
  const b = await attachSession(s.dir, 's1', { onData() {}, onEnd() {} });
  b.close();
  live.exit(0);
  assert.deepEqual(await gotEnd, { reason: 'exit 0', exitCode: 0 });
  await assert.rejects(attachSession(s.dir, 's1', { onData() {}, onEnd() {} }), (e) => e.code === 'not_found');
});

test('an attached connection that sends anything else is closed, and the session runs on', async (t) => {
  const s = await setup(t);
  await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w', command: 'c' });
  const { pipe, token } = JSON.parse(fs.readFileSync(path.join(s.dir, 'control.json'), 'utf8'));
  const lines = await raw(pipe, [{ id: 1, token, method: 'session.attach', params: { id: 's1' } }, { method: 'stop.all', token }].map((m) => JSON.stringify(m)));
  assert.deepEqual(lines[0], { id: 1, result: { attached: 's1' } });
  assert.equal(lines.at(-1).error.code, 'bad_request');
  assert.deepEqual((await s.call('session.list')).map((x) => x.id), ['s1']);
});

test('approval.list and approval.decide: the inbox over the pipe', async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.call('approval.list'), []);
  const waiting = s.approvals.ask({ identity: 'local:dev', session_id: 's1', workspace: 'D:/w', action: 'net.connect', resource: { type: 'Host', id: 'example.com:443' }, policy_version: 'v' });
  const [card] = await s.call('approval.list');
  assert.deepEqual([card.identity, card.resource.id], ['local:dev', 'example.com:443']);
  await assert.rejects(s.call('approval.decide', { id: card.id, answer: 'sure' }), (e) => e.code === 'bad_request');
  await assert.rejects(s.call('approval.decide', { answer: 'once' }), (e) => e.code === 'bad_request');
  assert.deepEqual(await s.call('approval.decide', { id: card.id, answer: 'session' }), { result: 'allow' });
  assert.equal((await waiting).result, 'allow');
  await assert.rejects(s.call('approval.decide', { id: card.id, answer: 'deny' }), (e) => e.code === 'not_found');
  s.approvals.endSession('s1');
});

test('transcript.get: what the session printed, redacted, while it runs and after it ends', async (t) => {
  const s = await setup(t);
  await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w', command: 'c' });
  s.runner.get('s1').output.write('hello\r\nDB_PASSWORD=hunter22\r\n');
  await new Promise((r) => setImmediate(r));
  const running = await s.call('transcript.get', { id: 's1' });
  assert.match(running.text, /^# session s1 · local:dev · D:\\w · started .*\nhello\nDB_PASSWORD=\[REDACTED:secret\]\n$/);
  s.runner.get('s1').exit(0);
  await new Promise((r) => setTimeout(r, 20));
  assert.match((await s.call('transcript.get', { id: 's1' })).text, /\n# ended: exit 0\n$/);
  await assert.rejects(s.call('transcript.get', { id: 'missing' }), (e) => e.code === 'not_found');
  await assert.rejects(s.call('transcript.get', {}), (e) => e.code === 'bad_request');
});

test('session.stop, stop.all', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.call('session.stop', { id: 'missing' }), (e) => e.code === 'not_found');
  await assert.rejects(s.call('session.stop', {}), (e) => e.code === 'bad_request');
  for (let i = 0; i < 3; i++) await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w', command: 'c' });
  assert.deepEqual(await s.call('session.stop', { id: 's2' }), { reason: 'stopped', exitCode: null });
  assert.deepEqual(await s.call('stop.all'), { stopped: 2 });
  assert.deepEqual(await s.call('session.list'), []);
  const { events: [e] } = await s.call('audit.query', { type: 'stop.all' });
  assert.deepEqual([e.identity.subject, e.decision.reasons], ['local:operator', ['2 running']]);
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

test('identities and grants over the pipe; suspending or retiring stops that identity\'s sessions only', async (t) => {
  const s = await setup(t);
  const made = await s.call('identity.create', { id: 'local:dev-shell', kind: 'ai-agent', displayName: 'Dev shell' });
  assert.deepEqual([made.status, made.owner], ['draft', OPERATOR]);
  await assert.rejects(s.call('identity.create', { id: 'local:dev-shell', kind: 'ai-agent', displayName: 'Again' }), (e) => e.code === 'conflict');
  await assert.rejects(s.call('identity.create', { id: 'nope', kind: 'ai-agent', displayName: 'X' }), (e) => e.code === 'bad_request');
  await assert.rejects(s.call('identity.get', { id: 'local:nobody' }), (e) => e.code === 'not_found');

  const g = await s.call('grant.add', { identity: 'local:dev-shell', resource: 'file:D:/work/**', permission: 'write' });
  assert.equal((await s.call('identity.get', { id: 'local:dev-shell' })).grants[0].id, g.id);
  assert.equal((await s.call('identity.activate', { id: 'local:dev-shell' })).status, 'active');
  assert.deepEqual((await s.call('identity.list', { status: 'active' })).map((i) => i.id), ['local:dev-shell', OPERATOR]);

  await s.call('session.start', { identity: 'local:dev-shell', workspace: 'D:\\work', command: 'c' });
  await s.call('session.start', { identity: 'local:dev-shell', workspace: 'D:\\work', command: 'c' });
  await s.call('session.start', { identity: 'local:other', workspace: 'D:\\work', command: 'c' });
  const suspended = await s.call('identity.suspend', { id: 'local:dev-shell', reason: 'checking' });
  assert.deepEqual([suspended.identity.status, suspended.stopped], ['suspended', 2]);
  assert.deepEqual((await s.call('session.list')).map((x) => x.identity), ['local:other']);
  await s.call('identity.activate', { id: 'local:dev-shell' });
  const retired = await s.call('identity.retire', { id: 'local:dev-shell' });
  assert.deepEqual([retired.identity.status, retired.stopped], ['retired', 0]);
  await assert.rejects(s.call('identity.activate', { id: 'local:dev-shell' }), (e) => e.code === 'conflict');
  await assert.rejects(s.call('grant.add', { identity: 'local:dev-shell', resource: 'file:D:/w/**', permission: 'read' }), (e) => e.code === 'conflict');
  assert.equal((await s.call('grant.remove', { id: g.id })).id, g.id);
  await assert.rejects(s.call('grant.remove', { id: g.id }), (e) => e.code === 'not_found');

  const changes = (await s.call('audit.query', { type: 'identity.lifecycle' })).events.map((e) => `${e.resource.id} ${e.lifecycle.from}->${e.lifecycle.to}`);
  assert.deepEqual(changes, [`${OPERATOR} null->active`, 'local:dev-shell null->draft', 'local:dev-shell draft->active', 'local:dev-shell active->suspended', 'local:dev-shell suspended->active', 'local:dev-shell active->retired']);
  assert.deepEqual((await s.call('audit.query', { type: 'grant.change' })).events.map((e) => e.action), ['grant.add', 'grant.remove']);
});

test('ctl.js calls the API from the command line, with key=value or JSON params', async (t) => {
  const s = await setup(t);
  const ctl = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [CTL, ...args], { env: { ...process.env, HOUSTON_CORE_DATA: s.dir } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  const made = await ctl('identity.create', 'id=local:cli', 'kind=ai-agent', 'displayName=From the CLI', 'tags=["a","b"]');
  assert.equal(made.code, 0, made.stderr);
  assert.deepEqual(((x) => [x.id, x.displayName, x.tags])(JSON.parse(made.stdout)), ['local:cli', 'From the CLI', ['a', 'b']]);
  const got = await ctl('identity.get', '{"id":"local:cli"}');
  assert.equal(JSON.parse(got.stdout).status, 'draft');
  const bad = await ctl('identity.get', 'local:cli');
  assert.deepEqual([bad.code, bad.stderr.trim()], [1, "error: 'local:cli' is not key=value"]);
  const missing = await ctl('identity.get', 'id=local:nobody');
  assert.deepEqual([missing.code, missing.stderr.trim()], [1, 'not_found: no identity local:nobody']);
});
test('core.status: pid, schema, the containment rung, how many sessions run and the limits', async (t) => {
  const s = await setup(t);
  await s.call('session.start', { identity: 'local:dev', workspace: 'D:\\w', command: 'c' });
  const st = await s.call('core.status');
  assert.deepEqual({ ...st, startedAt: typeof st.startedAt }, {
    pid: process.pid, startedAt: 'string', schema: 3, containment: 'container', sessions: 1,
    limits: { approvalSeconds: 120, transcriptBytes: 5 * 1024 ** 3, sessionTranscriptBytes: 100 * 1024 ** 2 },
  });
});

test("Houston's client finds the Core through HOUSTON_CORE_DATA, and says ENOENT when it isn't running", async (t) => {
  const s = await setup(t);
  const before = process.env.HOUSTON_CORE_DATA;
  t.after(() => { if (before === undefined) delete process.env.HOUSTON_CORE_DATA; else process.env.HOUSTON_CORE_DATA = before; });
  process.env.HOUSTON_CORE_DATA = s.dir;
  assert.deepEqual(await core.call('session.list'), []);
  if (process.platform === 'win32') assert.equal((await core.status())?.containment, 'container');
  else assert.equal(await core.status(), null);
  await s.control.close();
  await assert.rejects(core.call('session.list'), (e) => e.code === 'ENOENT');
  if (process.platform === 'win32') assert.equal((await core.status())?.code, 'ENOENT');
});
test('secrets go in through secret.set (ctl reads the value from stdin) and never come out; mcp.* and secret.* need their parts', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('mcp.list', {}).catch((e) => e)).code, 'not_found');
  assert.equal((await s.call('secret.list', {}).catch((e) => e)).code, 'not_found');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ctl-vault-'));
  const db = openDb(':memory:');
  migrate(db);
  ensureOperator(db, s.audit);
  const vault = await (await import('../../core/vault.js')).openVault({ db, dir: path.join(dir), audit: s.audit });
  const v = await startControl({ dir, runner: fakeRunner(), registry: createRegistry({ db, audit: s.audit }), audit: s.audit, vault });
  t.after(async () => { await v.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method, params) => callControl(dir, method, params, { timeoutMs: 5000 });
  const value = ['sk', 'ctltest', 'Zr7KpL0xQ8w2abcd'].join('-');

  const piped = await new Promise((resolve) => {
    const child = execFile(process.execPath, [CTL, 'secret.set', 'name=api-key'], { env: { ...process.env, HOUSTON_CORE_DATA: dir } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end(`${value}\n`);
  });
  assert.equal(piped.code, 0, piped.stderr);
  assert.ok(!piped.stdout.includes(value));
  assert.equal(vault.reveal('api-key'), value, 'the trailing newline is not part of it');
  const listed = await call('secret.list', {});
  assert.deepEqual(listed.map((x) => x.name), ['api-key']);
  assert.ok(!JSON.stringify(listed).includes(value));
  assert.equal((await call('secret.get', { name: 'api-key' }).catch((e) => e)).code, 'unknown_method');
  assert.equal((await call('secret.set', { name: 'Bad Name', value }).catch((e) => e)).code, 'bad_request');
  assert.deepEqual(await call('secret.delete', { name: 'api-key' }), { name: 'api-key', deleted: true });
  assert.ok(![...s.audit.events()].some((e) => JSON.stringify(e).includes(value)));
});
