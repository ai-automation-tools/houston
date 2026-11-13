import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { EXIT, endFromEvent, parseArgs, refusalExit, sessionExit } from '../../core/harness.js';
import { createRunner } from '../../core/runner.js';
import { StandingError, createStanding, grantsHash } from '../../core/standing.js';

const WIN = process.platform === 'win32';
// Workspaces can't sit in the user profile (launch.js refuses them): a gitignored folder in the repo.
const SCRATCH = fileURLToPath(new URL('../../.test-tmp/', import.meta.url));

/** A stand-in for the container SDK: a terminal the test ends, by exit code or by its timeout. */
function fakeSdk() {
  /** @type {{ request: any, end: (r: { exitCode: number | null, timedOut: boolean }) => void }[]} */
  const calls = [];
  return {
    calls,
    spawnWithPty: async (/** @type {any} */ request) => {
      let end = (/** @type {any} */ _r) => {};
      const waited = new Promise((r) => { end = r; });
      calls.push({ request, end });
      return {
        input: new PassThrough(), output: new PassThrough(), resize() {}, dispose() {},
        wait: () => waited, kill: () => end({ exitCode: 1, timedOut: false }),
      };
    },
  };
}

/** @param {import('node:test').TestContext} t */
function setup(t) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, 'standing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(root, 'audit'));
  t.after(() => audit.close());
  const at = '2026-01-01T00:00:00Z';
  db.prepare("INSERT INTO identities (id, kind, display_name, containment, created_at, status) VALUES ('local:operator', 'operator', 'Me', 'unconfined', ?, 'active')").run(at);
  /** @param {string} id @param {string} [kind] @param {string | null} [backend] */
  const identity = (id, kind = 'ai-agent', backend = null) => db.prepare("INSERT INTO identities (id, kind, display_name, owner, containment, created_at, status, backend) VALUES (?, ?, 'x', 'local:operator', 'container', ?, 'active', ?)").run(id, kind, at, backend);
  identity('local:nightly');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  let n = 0;
  /** @param {string} resource @param {string} permission */
  const grant = (resource, permission) => db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES (?, 'local:nightly', ?, ?, 'allow', ?, 'local:operator')")
    .run(`g${++n}`, resource.replaceAll('\\', '/'), permission, at);
  grant(`file:${ws}/**`, 'write');
  const sdk = fakeSdk();
  const runner = createRunner({ db, audit, coreDir: path.join(root, 'core'), tempRoot: path.join(root, 'sessions'), home: 'C:\\Users\\nobody-here', sdk });
  let clock = new Date('2026-11-13T00:00:00Z');
  const standing = createStanding({ db, audit, runner, now: () => clock });
  const events = () => [...audit.events()];
  const nightly = () => standing.create({ id: 'nightly', identity: 'local:nightly', workspace: ws, command: 'cmd.exe /c echo hi', maxMinutes: 30, expiresAt: '2026-12-01T00:00:00Z' });
  return { db, ws, sdk, runner, standing, events, identity, grant, nightly, tick: (/** @type {number} */ ms) => { clock = new Date(clock.getTime() + ms); } };
}

test('create approves a command identity\'s run with its grants as they are; bad specs are refused', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const { standing, ws, identity, nightly, events, db } = setup(t);
  const s = nightly();
  assert.deepEqual([s.status, s.identity, s.maxMinutes, s.grantsChanged, s.running, s.lastRunAt], ['active', 'local:nightly', 30, false, null, null]);
  assert.equal(s.workspace.toLowerCase(), ws.toLowerCase());
  assert.equal(events().at(-1).type, 'standing.change');
  assert.equal(events().at(-1).identity.subject, 'local:operator');
  identity('local:claude', 'ai-agent', 'claude-code');
  identity('local:mcp/x', 'mcp-server');
  const spec = { identity: 'local:nightly', workspace: ws, command: 'x', maxMinutes: 5, expiresAt: '2026-12-01T00:00:00Z' };
  const bad = (/** @type {object} */ o, /** @type {RegExp} */ re) => assert.throws(() => standing.create({ id: 'two', ...spec, ...o }), (e) => e instanceof StandingError && re.test(e.message));
  bad({ id: 'nightly' }, /exists/);
  bad({ id: 'Bad Id' }, /lower-case/);
  bad({ identity: 'local:nobody' }, /identity is an identity id/);
  bad({ identity: 'local:claude' }, /name a prompt, not a command/);
  bad({ identity: 'local:claude', command: undefined }, /prompt is what the agent is asked to do/);
  bad({ prompt: 'do it' }, /no backend: name the command/);
  identity('local:codex', 'ai-agent', 'codex');
  bad({ identity: 'local:codex', command: undefined, prompt: 'x' }, /no unattended start yet/);
  const p = standing.create({ id: 'prompted', identity: 'local:claude', workspace: ws, prompt: 'Update the "docs"\nand commit', maxMinutes: 5, expiresAt: '2026-12-01T00:00:00Z' });
  assert.deepEqual([p.prompt, p.command], ['Update the "docs"\nand commit', null]);
  bad({ identity: 'local:mcp/x' }, /can't hold a standing grant/);
  bad({ command: 'two\nlines' }, /one line/);
  bad({ maxMinutes: 0 }, /maxMinutes/);
  bad({ maxMinutes: 1441 }, /maxMinutes/);
  bad({ expiresAt: '2026-11-12T00:00:00Z' }, /future/);
  bad({ expiresAt: '2028-01-01T00:00:00Z' }, /a year/);
  bad({ workspace: 'relative\\ws' }, /workspace/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM standing_grants').get()?.n, 2);
});

test('a prompt grant runs its prompt through the backend; the runner refuses a prompt for a command identity', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const { standing, runner, ws, identity, db } = setup(t);
  identity('local:claude', 'ai-agent', 'claude-code');
  db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES ('c1', 'local:claude', ?, 'write', 'allow', '2026-01-01T00:00:00Z', 'local:operator')").run(`file:${ws.replaceAll('\\', '/')}/**`);
  standing.create({ id: 'prompted', identity: 'local:claude', workspace: ws, prompt: 'say hi', maxMinutes: 5, expiresAt: '2026-12-01T00:00:00Z' });
  // This runner has no agents folder, so a backend can't start: the refusal shows the prompt reached the backend path.
  await assert.rejects(standing.run('prompted'), (e) => e instanceof StandingError && e.code === 'refused' && /agents folder/.test(e.message));
  await assert.rejects(runner.start({ identity: 'local:nightly', workspace: ws, prompt: 'x' }), /a prompt is for an identity with a backend/);
});

test('run starts one unattended session under its budget, recorded with the grant; refusals say why', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const { standing, sdk, nightly, events, grant, tick, db } = setup(t);
  nightly();
  const s = await standing.run('nightly');
  const req = sdk.calls[0].request;
  assert.equal(req.timeoutMs, 31 * 60_000, 'the SDK\'s timeout is a backstop a minute past the budget');
  assert.equal(req.command, 'cmd.exe /c echo hi');
  assert.equal(db.prepare('SELECT attended, standing_grant_id FROM sessions WHERE id = ?').get(s.id)?.standing_grant_id, 'nightly');
  assert.equal(db.prepare('SELECT attended FROM sessions WHERE id = ?').get(s.id)?.attended, 0);
  const started = events().find((e) => e.type === 'session.start' && e.session_id === s.id);
  assert.equal(started.standing_grant, 'nightly');
  assert.equal(events().filter((e) => e.type === 'standing.run').at(-1).decision.result, 'allow');
  assert.equal(standing.get('nightly').running, s.id);

  // One live run per grant.
  await assert.rejects(standing.run('nightly'), (e) => e instanceof StandingError && e.code === 'overlap');
  sdk.calls[0].end({ exitCode: 0, timedOut: false });
  assert.deepEqual(await s.done, { reason: 'exit 0', exitCode: 0 });

  // At its budget the container ends: a timeout.
  const s2 = await standing.run('nightly');
  sdk.calls[1].end({ exitCode: null, timedOut: true });
  assert.equal((await s2.done).reason, 'timeout');

  // The identity's grants change: refused until the operator approves again.
  grant('net:example.com:443', 'connect');
  assert.equal(standing.get('nightly').grantsChanged, true);
  await assert.rejects(standing.run('nightly'), (e) => e instanceof StandingError && e.code === 'changed');
  standing.update('nightly');
  assert.equal(standing.get('nightly').grantsChanged, false);

  standing.pause('nightly');
  await assert.rejects(standing.run('nightly'), (e) => e instanceof StandingError && e.code === 'paused');
  standing.resume('nightly');
  tick(30 * 24 * 60 * 60_000);
  await assert.rejects(standing.run('nightly'), (e) => e instanceof StandingError && e.code === 'expired');
  standing.update('nightly', { expiresAt: '2027-01-01T00:00:00Z', maxMinutes: 10 });
  standing.revoke('nightly');
  await assert.rejects(standing.run('nightly'), (e) => e instanceof StandingError && e.code === 'revoked');
  assert.throws(() => standing.update('nightly'), /revoked/);
  await assert.rejects(standing.run('nope'), (e) => e instanceof StandingError && e.code === 'not_found');

  const denied = events().filter((e) => e.type === 'standing.run' && e.decision.result === 'deny').map((e) => e.decision.reasons[0].split(' ')[0]);
  assert.equal(denied.length, 6, 'every refusal is a standing.run deny event');
  assert.equal(sdk.calls.length, 2, 'no refused run reached the container');
});

test('the runner\'s refusal comes back as refused; Stop All\'s pauseAll pauses every active one', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const { standing, nightly, db, ws } = setup(t);
  nightly();
  standing.create({ id: 'other', identity: 'local:nightly', workspace: ws, command: 'x', maxMinutes: 5, expiresAt: '2026-12-01T00:00:00Z' });
  standing.pause('other');
  assert.deepEqual(standing.pauseAll(), ['nightly']);
  assert.deepEqual(standing.list().map((s) => s.status), ['paused', 'paused']);
  assert.deepEqual(standing.pauseAll(), []);
  standing.resume('nightly');
  // The identity suspended: the runner says no, with its reason.
  db.prepare("UPDATE identities SET status = 'suspended' WHERE id = 'local:nightly'").run();
  await assert.rejects(standing.run('nightly'), (e) => e instanceof StandingError && e.code === 'refused' && /suspended/.test(e.message));
});

test('the runner ends a session at its budget itself, and records a timeout', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const { runner, ws, events } = setup(t);
  const s = await runner.start({ identity: 'local:nightly', workspace: ws, command: 'x', attended: false, timeoutMs: 50 });
  // The fake's kill ends it with exit 1, as the real SDK's -1: the runner knows it was the budget.
  assert.deepEqual(await s.done, { reason: 'timeout', exitCode: null });
  assert.equal(events().filter((e) => e.type === 'session.end').at(-1).outcome.error_code, 'timeout');
});

test('grantsHash ignores order and grant ids, not resources or effects', (t) => {
  const db = openDb(':memory:');
  migrate(db);
  t.after(() => db.close());
  const at = '2026-01-01T00:00:00Z';
  db.exec(`INSERT INTO identities (id, kind, display_name, containment, created_at) VALUES ('local:operator', 'operator', 'Me', 'unconfined', '${at}');
    INSERT INTO identities (id, kind, display_name, owner, containment, created_at) VALUES ('local:a', 'ai-agent', 'A', 'local:operator', 'container', '${at}');`);
  const add = (/** @type {string} */ id, /** @type {string} */ resource, effect = 'allow') => db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES (?, 'local:a', ?, 'connect', ?, ?, 'local:operator')").run(id, resource, effect, at);
  add('1', 'net:a.com:443');
  add('2', 'net:b.com:443');
  const h = grantsHash(db, 'local:a');
  db.exec("DELETE FROM grants WHERE id = '1'");
  add('3', 'net:a.com:443');
  assert.equal(grantsHash(db, 'local:a'), h);
  db.exec("UPDATE grants SET effect = 'ask' WHERE id = '2'");
  assert.notEqual(grantsHash(db, 'local:a'), h);
});

test('harness: its arguments, and an exit code for each way a run can go', () => {
  assert.deepEqual(parseArgs(['run', '--grant', 'nightly']), { grant: 'nightly' });
  assert.deepEqual(parseArgs(['run', '--grant=nightly']), { grant: 'nightly' });
  for (const bad of [[], ['run'], ['start', '--grant', 'x'], ['run', '--grant', 'x', '--extra']]) assert.equal(parseArgs(bad), null);
  assert.deepEqual(['expired', 'overlap', 'paused', 'changed', 'revoked', 'not_found', 'refused', 'ENOENT', 'unknown_method'].map(refusalExit),
    [EXIT.expired, EXIT.overlap, EXIT.paused, EXIT.denied, EXIT.denied, EXIT.denied, EXIT.denied, EXIT.unavailable, EXIT.unavailable]);
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, 'each code says one thing');
  assert.equal(sessionExit({ reason: 'exit 0', exitCode: 0 }), 0);
  assert.equal(sessionExit({ reason: 'exit 3', exitCode: 3 }), 3);
  assert.equal(sessionExit({ reason: 'exit 74', exitCode: 74 }), 1, 'a command\'s own code never reads as one of ours');
  assert.equal(sessionExit({ reason: 'exit -1', exitCode: -1 }), 1, 'a command that never started');
  assert.equal(sessionExit({ reason: 'timeout', exitCode: null }), EXIT.timeout);
  assert.equal(sessionExit({ reason: 'stopped', exitCode: null }), EXIT.stopped);
  assert.deepEqual(endFromEvent({ outcome: { status: 'ok', error_code: '0' } }), { reason: 'exit 0', exitCode: 0 });
  assert.deepEqual(endFromEvent({ outcome: { status: 'error', error_code: '2' } }), { reason: 'exit 2', exitCode: 2 });
  assert.deepEqual(endFromEvent({ outcome: { status: 'error', error_code: 'timeout' } }), { reason: 'timeout', exitCode: null });
  assert.equal(endFromEvent(undefined), null);
});
