import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { createApprovals } from '../../core/approvals.js';
import { RunnerError, compileGrants, containerName, createRunner, listBrokers, markInterrupted } from '../../core/runner.js';

const WIN = process.platform === 'win32';
// Workspaces can't sit in the user profile (launch.js refuses them), and the system temp folder
// is in it, so these tests work in a gitignored folder in the repo.
const SCRATCH = fileURLToPath(new URL('../../.test-tmp/', import.meta.url));
const g = (id, resource, permission, effect = 'allow', expires_at = null) => ({ id, resource, permission, effect, expires_at });

test('compileGrants: what a container can enforce, and nothing it cannot', () => {
  const c = compileGrants([
    g('w', 'file:D:/work/**', 'write'),
    g('r', 'file:C:/Program Files/nodejs/**', 'read'),
    g('f', 'file:D:/data/one.csv', 'read'),
    g('d', 'file:D:/work/secrets/**', 'read', 'deny'),
    g('a', 'file:D:/work/app/**', 'write', 'ask'),
    g('l', 'file:D:/listing/**', 'list'),
    g('mid', 'file:D:/work/*/build/**', 'write'),
    g('old', 'file:D:/old/**', 'read', 'allow', '2020-01-01T00:00:00Z'),
    g('n', 'net:api.openai.com:443', 'connect'),
    g('nask', 'net:example.com:443', 'connect', 'ask'),
    g('t', 'tool:github/*', 'call'),
  ], new Date('2026-06-01T00:00:00Z'));
  assert.deepEqual(c.readwrite, ['D:/work']);
  assert.deepEqual(c.readonly, ['C:/Program Files/nodejs', 'D:/data/one.csv']);
  assert.deepEqual(c.denied, ['D:/work/secrets']);
  assert.deepEqual(c.net.map((x) => x.id), ['n']);
  assert.deepEqual(c.skipped.map((s) => s.id), ['a', 'l', 'mid', 'old']);
  assert.throws(() => compileGrants([g('bad', 'file:D:/work/**/.env', 'read', 'deny')]), (e) => e instanceof RunnerError && /bad.*can't be enforced/.test(e.message));
  // An expired deny is dropped; one whose date doesn't parse keeps denying.
  assert.deepEqual(compileGrants([g('x', 'file:D:/a/**', 'read', 'deny', '2020-01-01T00:00:00Z')]).denied, []);
  assert.deepEqual(compileGrants([g('x', 'file:D:/a/**', 'read', 'deny', 'someday')]).denied, ['D:/a']);
});

/** A fake SDK: records each request and hands back a terminal the test drives. */
function fakeSdk({ fail } = {}) {
  const calls = [];
  return {
    calls,
    spawnWithPty: async (request, options) => {
      if (fail) throw new Error(fail);
      let settle;
      let waiting = false;
      const waited = new Promise((r) => { settle = r; });
      const streams = { input: new PassThrough(), output: new PassThrough() };
      // Like the real SDK: the streams are gone once wait() starts draining them.
      const take = (k) => { if (waiting) throw new Error(`${k} is unavailable because wait() began draining it`); return streams[k]; };
      const term = {
        get input() { return take('input'); }, get output() { return take('output'); }, streams, sizes: [], killed: 0, disposed: 0,
        resize: (s) => term.sizes.push(s), wait: () => { waiting = true; return waited; },
        kill: () => { term.killed++; settle({ exitCode: 1, timedOut: false }); },
        exit: (code) => settle({ exitCode: code, timedOut: false }),
        dispose: () => { term.disposed++; },
      };
      calls.push({ request, options, term });
      return term;
    },
  };
}

/** A Core-shaped setup in a scratch folder: database, audit log, operator, one agent. */
function setup(t, { status = 'active', containment = 'container', grants = [], backend = null, isFile } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, 'runner-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(root, 'audit'));
  t.after(() => audit.close());
  const at = '2026-01-01T00:00:00Z';
  db.prepare("INSERT INTO identities (id, kind, display_name, containment, created_at, status) VALUES ('local:me', 'operator', 'Me', 'unconfined', ?, 'active')").run(at);
  db.prepare("INSERT INTO identities (id, kind, display_name, owner, containment, created_at, status, backend) VALUES ('local:dev', 'ai-agent', 'Dev', 'local:me', ?, ?, ?, ?)").run(containment, at, status, backend);
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  for (const [id, resource, permission, effect = 'allow'] of [['ws', `file:${ws}/**`, 'write'], ...grants]) {
    db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES (?, 'local:dev', ?, ?, ?, ?, 'local:me')").run(id, resource.replaceAll('\\', '/'), permission, effect, at);
  }
  const sdk = fakeSdk();
  const runner = createRunner({
    db, audit, coreDir: path.join(root, 'core'), tempRoot: path.join(root, 'sessions'), agentsRoot: path.join(root, 'agents'), home: 'C:\\Users\\nobody-here', sdk, isFile,
    where: { home: 'C:\\Users\\nobody-here', appData: 'C:\\Users\\nobody-here\\AppData\\Roaming', PATH: 'C:\\Program Files\\Git\\cmd' },
  });
  const events = () => [...audit.events()].map((e) => e);
  return { root, db, audit, ws, sdk, runner, events };
}

test('start: a contained session on a PTY, recorded in the database and the audit log; stop closes it', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const s = setup(t, { grants: [['node', 'file:C:/Program Files/nodejs/**', 'read']] });
  const session = await s.runner.start({ identity: 'local:dev', workspace: s.ws, command: 'cmd.exe', size: { rows: 30, columns: 100 }, program: { pathDirs: ['C:\\Program Files\\nodejs'] } });

  const { request, options } = s.sdk.calls[0];
  assert.deepEqual(options, { size: { rows: 30, columns: 100 } });
  assert.equal(request.workingDirectory.toLowerCase(), s.ws.toLowerCase());
  assert.ok(request.filesystem.readwritePaths.some((p) => p.toLowerCase() === s.ws.toLowerCase()));
  assert.ok(request.filesystem.readonlyPaths.includes('C:\\Program Files\\nodejs'));
  assert.ok(request.filesystem.deniedPaths.includes('C:\\Users'));
  assert.deepEqual(request.network, { egress: { default: 'deny' } });
  // Named after the session, so a restarted Core can find it (AT-16).
  assert.match(request.containerName, /^[0-9a-f]{32}$/);
  assert.equal(request.containerName, containerName(session.id));
  const temp = request.environment.TEMP;
  assert.ok(fs.existsSync(temp));

  const row = s.db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  assert.deepEqual([row.identity_id, row.attended, row.ended_at], ['local:dev', 1, null]);
  assert.equal(s.db.prepare("SELECT last_used_at FROM identities WHERE id = 'local:dev'").get().last_used_at, session.startedAt);
  const started = s.events().find((e) => e.type === 'session.start');
  assert.equal(started.decision.result, 'allow');
  assert.deepEqual(started.decision.policy_ids, ['ws']);
  assert.deepEqual(started.launch.network, { proxy: false });
  assert.equal(started.launch.container, request.containerName);
  assert.ok(started.launch.denied.includes('C:\\Users'));
  assert.deepEqual(s.runner.list().map((x) => x.id), [session.id]);
  // The session's streams are the terminal's, taken before wait() started.
  const { streams } = s.sdk.calls[0].term;
  const typed = new Promise((r) => streams.input.once('data', (d) => r(String(d))));
  session.input.write('dir');
  assert.equal(await typed, 'dir');
  const shown = new Promise((r) => session.output.once('data', (d) => r(String(d))));
  streams.output.write('prompt> ');
  assert.equal(await shown, 'prompt> ');
  session.resize({ rows: 40, columns: 132 });
  assert.deepEqual(s.sdk.calls[0].term.sizes, [{ rows: 40, columns: 132 }]);

  const end = await session.stop();
  assert.equal(end.reason, 'stopped');
  assert.equal(s.sdk.calls[0].term.killed, 1);
  assert.equal(s.sdk.calls[0].term.disposed, 1);
  assert.ok(!fs.existsSync(path.dirname(temp)));
  assert.equal(s.db.prepare('SELECT end_reason FROM sessions WHERE id = ?').get(session.id).end_reason, 'stopped');
  assert.deepEqual(s.events().map((e) => e.type), ['session.start', 'session.end']);
  assert.deepEqual(s.runner.list(), []);
});

test('a session that exits by itself is recorded with its exit code', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const s = setup(t);
  const session = await s.runner.start({ identity: 'local:dev', workspace: s.ws, command: 'cmd.exe /c exit 0' });
  s.sdk.calls[0].term.exit(0);
  assert.deepEqual(await session.done, { reason: 'exit 0', exitCode: 0 });
  assert.equal(s.events().at(-1).outcome.status, 'ok');
});

test('start refuses, and writes a session.start deny, for each thing that would make the launch unsafe', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const cases = [
    [{ status: 'suspended' }, {}, /identity is suspended/],
    [{ containment: 'unconfined' }, {}, /runs unconfined/],
    [{}, { identity: 'local:ghost' }, /unknown identity/],
    [{}, { workspace: 'D:\\not-granted' }, /no write grant on the workspace/],
    [{ grants: [['env', 'file:D:/x/**/.env', 'read', 'deny']] }, {}, /can't be enforced by the container/],
    [{ grants: [['ssh', 'file:C:/Users/nobody-here/.ssh/**', 'read']] }, {}, /overlaps a global deny/],
  ];
  for (const [shape, change, want] of cases) {
    const s = setup(t, shape);
    await assert.rejects(s.runner.start({ identity: 'local:dev', workspace: s.ws, command: 'cmd.exe', ...change }), (e) => e instanceof RunnerError && want.test(e.message), String(want));
    const [ev] = s.events();
    assert.deepEqual([ev.type, ev.decision.result], ['session.start', 'deny'], String(want));
    assert.match(ev.decision.reasons[0], want);
    assert.equal(s.sdk.calls.length, 0);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
    assert.ok(!fs.existsSync(path.join(s.root, 'sessions')) || fs.readdirSync(path.join(s.root, 'sessions')).length === 0, 'temp left behind');
  }
  await assert.rejects(setup(t).runner.start({ identity: '', workspace: 'D:\\w', command: 'x' }), /identity is an id/);
});

test('a backend identity runs its manifest: command, its own home, the program, and the hosts it lacks', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const claude = 'C:\\Users\\nobody-here\\.local\\bin\\claude.exe';
  const isFile = (p) => [claude, 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'].includes(p);
  const s = setup(t, { backend: 'claude-code', isFile, grants: [['anthropic', 'net:api.anthropic.com:443', 'connect']] });
  const session = await s.runner.start({ identity: 'local:dev', workspace: s.ws, program: { env: { CLAUDE_CONFIG_DIR: 'C:\\elsewhere', EXTRA: '1' } } });
  const { request } = s.sdk.calls[0];
  const home = path.join(s.root, 'agents', 'dev', 'claude-code');
  assert.equal(request.command, `${claude} --strict-mcp-config`);
  assert.ok(fs.existsSync(home));
  assert.ok(request.filesystem.readwritePaths.some((p) => p.toLowerCase() === home.toLowerCase()));
  assert.ok(request.filesystem.readonlyPaths.includes(claude));
  // The manifest's variables win over the caller's.
  assert.equal(request.environment.CLAUDE_CONFIG_DIR.toLowerCase(), home.toLowerCase());
  assert.equal(request.environment.EXTRA, '1');
  assert.match(request.environment.PATH, /\\\.local\\bin;C:\\Program Files\\Git\\cmd$/);
  const { launch } = s.events()[0];
  assert.deepEqual([launch.backend.name, launch.backend.missingHosts], ['claude-code', ['platform.claude.com:443']]);
  await session.stop();
  // The home outlives the session: it holds the identity's sign-in.
  assert.ok(fs.existsSync(home));
});

test('a backend identity refuses a command, a missing program, and a runner with no agents folder', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const s = setup(t, { backend: 'codex', isFile: () => false });
  await assert.rejects(s.runner.start({ identity: 'local:dev', workspace: s.ws, command: 'cmd.exe' }), /manifest sets the command/);
  await assert.rejects(s.runner.start({ identity: 'local:dev', workspace: s.ws }), /Codex is not installed/);
  const bare = createRunner({ db: s.db, audit: s.audit, coreDir: path.join(s.root, 'core'), tempRoot: path.join(s.root, 'sessions'), home: 'C:\\Users\\nobody-here', sdk: fakeSdk() });
  await assert.rejects(bare.start({ identity: 'local:dev', workspace: s.ws }), /no agents folder/);
  assert.deepEqual(s.events().map((e) => e.decision.result), ['deny', 'deny', 'deny']);
  // An identity with no backend still names its command.
  await assert.rejects(setup(t).runner.start({ identity: 'local:dev', workspace: s.ws }), /a command is required/);
});

test('an ask grant gets a proxy; its CONNECT waits in the approval inbox, and the operator\'s deny refuses it', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const s = setup(t, { grants: [['maybe', 'net:example.com:443', 'connect', 'ask']] });
  const approvals = createApprovals({ audit: s.audit });
  const sdk = fakeSdk();
  const runner = createRunner({ db: s.db, audit: s.audit, coreDir: path.join(s.root, 'core'), tempRoot: path.join(s.root, 'sessions'), home: 'C:\\Users\\nobody-here', sdk, approvals });
  const session = await runner.start({ identity: 'local:dev', workspace: s.ws, command: 'cmd.exe' });
  const { launch } = s.events().find((e) => e.type === 'session.start');
  assert.deepEqual(launch.network, { proxy: true, hosts: [], ask: ['example.com:443'] });
  const port = Number(/:(\d+)$/.exec(sdk.calls[0].request.network.runtimeConfig.networkProxy)[1]);
  const status = new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
    c.once('data', (d) => { resolve(Number(String(d).slice(9, 12))); c.destroy(); });
  });
  for (let i = 0; i < 50 && !approvals.list().length; i++) await new Promise((r) => setTimeout(r, 20));
  const [card] = approvals.list();
  assert.deepEqual([card.identity, card.session_id, card.action, card.resource.id], ['local:dev', session.id, 'net.connect', 'example.com:443']);
  assert.equal(card.workspace.toLowerCase(), s.ws.toLowerCase());
  approvals.decide(card.id, 'deny');
  assert.equal(await status, 403);
  const ev = s.events().find((e) => e.type === 'egress.connect');
  assert.deepEqual([ev.decision.result, ev.decision.reasons[0]], ['deny', 'denied by the operator']);
  // A card left waiting when the session ends is denied with it.
  void approvals.ask({ identity: 'local:dev', session_id: session.id, workspace: s.ws, action: 'net.connect', resource: { type: 'Host', id: 'x:443' }, policy_version: 'v' });
  await session.stop();
  assert.deepEqual(approvals.list(), []);
});

test('a container that fails to start ends the session and cleans up', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const s = setup(t);
  const runner = createRunner({ db: s.db, audit: s.audit, coreDir: path.join(s.root, 'core'), tempRoot: path.join(s.root, 'sessions'), home: 'C:\\Users\\nobody-here', sdk: fakeSdk({ fail: 'backend_unavailable' }) });
  await assert.rejects(runner.start({ identity: 'local:dev', workspace: s.ws, command: 'cmd.exe' }), /did not start: backend_unavailable/);
  assert.match(s.db.prepare('SELECT end_reason FROM sessions').get().end_reason, /failed to start/);
  assert.deepEqual(s.events().map((e) => e.type), ['session.start', 'session.end']);
  assert.deepEqual(fs.readdirSync(path.join(s.root, 'sessions')), []);
});

test('a net grant starts the egress proxy on the frozen grants, and its decisions are audited', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const s = setup(t, { grants: [['openai', 'net:api.openai.com:443', 'connect']] });
  const session = await s.runner.start({ identity: 'local:dev', workspace: s.ws, command: 'cmd.exe' });
  t.after(() => session.stop());
  const { request } = s.sdk.calls[0];
  const port = Number(/:(\d+)$/.exec(request.network.runtimeConfig.networkProxy)[1]);
  assert.equal(request.environment.NODE_USE_ENV_PROXY, '1');
  assert.deepEqual(s.events()[0].launch.network, { proxy: true, hosts: ['api.openai.com:443'] });

  // A grant added after the start does not reach this session.
  s.db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES ('late', 'local:dev', 'net:example.com:443', 'connect', 'allow', '2026-01-01T00:00:00Z', 'local:me')").run();
  const status = await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'));
    c.once('data', (d) => { resolve(Number(String(d).slice(9, 12))); c.destroy(); });
  });
  assert.equal(status, 403);
  const ev = s.events().find((e) => e.type === 'egress.connect');
  assert.deepEqual([ev.decision.result, ev.resource.id, ev.session_id, ev.decision.reasons[0]], ['deny', 'example.com:443', session.id, 'not on the allow-list']);
  assert.equal(ev.decision.policy_version, s.events()[0].decision.policy_version);

  await session.stop();
  await assert.rejects(new Promise((resolve, reject) => net.connect(port, '127.0.0.1', resolve).on('error', reject)), /ECONNREFUSED/);
});

test('stopAll stops every live session', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const s = setup(t);
  await s.runner.start({ identity: 'local:dev', workspace: s.ws, command: 'a' });
  await s.runner.start({ identity: 'local:dev', workspace: s.ws, command: 'b' });
  const ends = await s.runner.stopAll();
  assert.deepEqual(ends.map((e) => e.reason), ['stopped', 'stopped']);
  assert.ok(s.sdk.calls.every((c) => c.term.killed === 1));
  assert.deepEqual(s.runner.list(), []);
});

/** A database with sessions in it, and an audit log. @param {import('node:test').TestContext} t @param {[string, string | null][]} sessions [id, end_reason] */
function deadCore(t, sessions) {
  const db = openDb(':memory:');
  migrate(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-int-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = openAudit(dir);
  t.after(() => audit.close());
  db.exec("INSERT INTO identities (id, kind, display_name, containment, created_at) VALUES ('local:me', 'operator', 'Me', 'unconfined', 'x')");
  const add = db.prepare("INSERT INTO sessions (id, identity_id, workspace, containment, attended, policy_version, started_at, ended_at, end_reason) VALUES (?, 'local:me', 'D:/w', 'container', 1, 'v', 'x', ?, ?)");
  for (const [id, reason] of sessions) add.run(id, reason && 'y', reason);
  const ends = () => [...audit.events()].map((e) => [e.session_id, e.outcome.error_code, e.decision.reasons[0]]);
  return { db, audit, ends };
}

test('markInterrupted ends a dead Core\'s containers and closes its sessions (AT-16)', (t) => {
  const [running, gone, stuck, done] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const s = deadCore(t, [[running, null], [gone, null], [stuck, null], [done, 'exit 0']]);
  const killed = [];
  const brokers = () => [
    { pid: 11, containerId: containerName(running) },
    { pid: 12, containerId: containerName(stuck) },
    { pid: 13, containerId: containerName(done) },   // a finished session's name: not touched
    { pid: 14, containerId: 'someone-elses' },
    { pid: 15, containerId: null },
  ];
  const kill = (pid) => {
    if (pid === 12) throw Object.assign(new Error('Access is denied'), { code: 'EPERM' });
    killed.push(pid);
  };
  assert.deepEqual(markInterrupted(s.db, s.audit, { brokers, kill }).sort(), [running, gone, stuck].sort());
  assert.deepEqual(killed, [11]);
  const reason = (id) => s.db.prepare('SELECT end_reason FROM sessions WHERE id = ?').get(id).end_reason;
  assert.deepEqual([running, gone, stuck, done].map(reason), ['interrupted', 'interrupted', 'interrupted', 'exit 0']);
  const ends = new Map(s.ends().map(([id, code, why]) => [id, [code, why]]));
  assert.deepEqual(ends.get(running), ['interrupted', 'ended its container']);
  assert.deepEqual(ends.get(gone), ['interrupted', 'no container was running']);
  assert.deepEqual(ends.get(stuck), ['interrupted', 'could not end its container (pid 12: Access is denied)']);
  assert.equal(ends.has(done), false);
  // Already closed: nothing to do, and the process list isn't read.
  assert.deepEqual(markInterrupted(s.db, s.audit, { brokers: () => assert.fail('listed') }), []);
});

test('markInterrupted still closes the sessions when the process list can\'t be read, and says so', (t) => {
  const id = crypto.randomUUID();
  const s = deadCore(t, [[id, null]]);
  assert.deepEqual(markInterrupted(s.db, s.audit, { brokers: () => { throw new Error('no CIM'); } }), [id]);
  assert.deepEqual(s.ends(), [[id, 'interrupted', 'could not check for its container: no CIM']]);
});

test('markInterrupted: a broker that exited between the listing and the kill counts as ended', (t) => {
  const id = crypto.randomUUID();
  const s = deadCore(t, [[id, null]]);
  const kill = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  markInterrupted(s.db, s.audit, { brokers: () => [{ pid: 9, containerId: containerName(id) }], kill });
  assert.deepEqual(s.ends(), [[id, 'interrupted', 'ended its container']]);
});

test('listBrokers reads the real process list', { skip: !WIN && 'the Core is Windows only' }, () => {
  const all = listBrokers();
  assert.ok(Array.isArray(all));
  for (const b of all) assert.ok(Number.isInteger(b.pid));
});
