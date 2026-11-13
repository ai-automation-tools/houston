import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { DelegationError, createDelegation, intersect } from '../../core/delegate.js';
import { OPERATOR, createRegistry, ensureOperator } from '../../core/identities.js';

const NOW = new Date('2026-11-13T12:00:00Z');
const g = (resource, permission, effect = 'allow', expires_at = null) => ({ id: `${resource}|${permission}|${effect}`, resource, permission, effect, expires_at });
const PARENT = [
  g('file:D:/work/**', 'write'), g('file:D:/work/secrets/**', 'read', 'deny'), g('file:D:/docs/one.md', 'read'),
  g('net:api.openai.com:443', 'connect'), g('net:example.com:443', 'connect', 'ask'), g('tool:github/*', 'call'),
  g('net:old.example:443', 'connect', 'allow', '2026-01-01T00:00:00Z'),
];
const policy = { globals: [{ id: 'global:ssh', resource: 'file:C:/Users/dev/.ssh/**' }], policyVersion: 'v', now: NOW, identity: 'local:dev' };
const ask = (/** @type {[string, string][]} */ list) => intersect(PARENT, list.map(([resource, permission]) => ({ resource, permission })), policy);

test('intersect keeps only what the parent\'s live allow grants cover, never more (AT-10\'s rule)', () => {
  const r = ask([
    ['file:D:/work/app/**', 'write'], // a folder inside the parent's: kept
    ['file:D:/work/app/**', 'read'], // write covers read: kept
    ['file:D:/**', 'write'], // wider than the parent's: dropped
    ['file:D:/work/**', 'write'], // identical: kept
    ['file:D:/docs/one.md', 'read'], // one file the parent may read: kept
    ['file:D:/docs/*.md', 'read'], // a wildcard the parent doesn't hold: dropped
    ['net:api.openai.com:443', 'connect'], // kept
    ['net:example.com:443', 'connect'], // the parent would be asked: dropped
    ['net:pastebin.com:443', 'connect'], // the parent may not: dropped
    ['net:old.example:443', 'connect'], // the parent's grant expired: dropped
    ['tool:github/list_issues', 'call'], // one tool under the parent's wildcard: kept
    ['tool:*/*', 'call'], // wider: dropped
    ['file:C:/Users/dev/.ssh/**', 'read'], // a global deny: dropped
    ['file:D:/work/x/**', 'call'], // not a permission files take: dropped
  ]);
  assert.deepEqual(r.granted.map((x) => `${x.resource} ${x.permission}`), [
    'file:D:/work/app/** write', 'file:D:/work/app/** read', 'file:D:/work/** write', 'file:D:/docs/one.md read', 'net:api.openai.com:443 connect', 'tool:github/list_issues call',
  ]);
  assert.equal(r.dropped.length, 8);
  assert.match(r.dropped.find((x) => x.resource === 'net:example.com:443').reason, /unattended/);
  assert.deepEqual(r.denies, [{ resource: 'file:D:/work/secrets/**', permission: 'read' }], 'every deny the parent has');
});

test('intersect with nothing asked gives the parent\'s live allow grants, without its asks or expired ones', () => {
  const r = intersect(PARENT, undefined, policy);
  assert.deepEqual(r.granted.map((x) => x.resource), ['file:D:/work/**', 'file:D:/docs/one.md', 'net:api.openai.com:443', 'tool:github/*']);
});

/** A registry and a runner that records what it was asked to start. */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-deleg-'));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  ensureOperator(db, audit, () => NOW);
  const registry = createRegistry({ db, audit, now: () => NOW });
  registry.create({ id: 'local:dev', kind: 'ai-agent', displayName: 'Dev', expiresAt: '2026-11-13T12:10:00Z' }, OPERATOR);
  registry.setStatus('local:dev', 'active', OPERATOR);
  /** @type {any[]} */
  const started = [];
  let end = () => {};
  /** @type {Promise<unknown>} */
  let done = Promise.resolve();
  const runner = {
    start: async (/** @type {any} */ spec) => {
      started.push(spec);
      if (spec.workspace === 'D:/nowhere') throw new Error('the identity has no write grant on the workspace');
      done = new Promise((r) => { end = () => r({ reason: 'exit 0', exitCode: 0 }); });
      return { id: `child-${started.length}`, done };
    },
    get: () => undefined,
  };
  const tapped = [];
  const d = createDelegation({ db, registry, runner, tap: (s) => tapped.push(s.id), transcripts: { read: (id) => ({ text: `transcript of ${id}` }) }, now: () => NOW });
  const parent = { id: 'parent-1', identity: 'local:dev', workspace: 'D:/work', policy: { grants: PARENT, globals: policy.globals, policyVersion: 'v' } };
  return { db, registry, d, started, tapped, parent, end: () => end(), ended: () => done };
}

test('delegate makes a sub-agent under the parent with the intersection, starts it unattended, and retires it at its end', async (t) => {
  const s = setup(t);
  const out = await s.d.delegate(s.parent, { task: 'cmd.exe /d /c dir', grants: [{ resource: 'file:D:/work/**', permission: 'write' }, { resource: 'net:pastebin.com:443', permission: 'connect' }], minutes: 60 });
  assert.equal(out.identity, 'local:dev/sub-1');
  assert.deepEqual(out.granted, [{ resource: 'file:D:/work/**', permission: 'write' }]);
  assert.deepEqual(out.dropped.map((x) => x.resource), ['net:pastebin.com:443']);
  assert.equal(out.expiresAt, '2026-11-13T12:10:00.000Z', 'no later than the parent identity\'s expiry');
  const child = s.registry.get('local:dev/sub-1');
  assert.deepEqual([child.kind, child.parent, child.owner, child.status, child.profile], ['sub-agent', 'local:dev', 'local:dev', 'active', 'default']);
  assert.deepEqual(child.grants.map((x) => `${x.resource} ${x.permission} ${x.effect}`).sort(), ['file:D:/work/** write allow', 'file:D:/work/secrets/** read deny']);
  assert.deepEqual([s.started[0].attended, s.started[0].parentSession, s.started[0].command, s.started[0].timeoutMs], [false, 'parent-1', 'cmd.exe /d /c dir', 3_600_000]);
  assert.deepEqual(s.tapped, ['child-1'], 'its output is read and kept like any session\'s');
  s.end();
  await s.ended();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.registry.get('local:dev/sub-1').status, 'retired');
  assert.equal((await s.d.delegate(s.parent, { task: 'x' })).identity, 'local:dev/sub-2', 'ids are never reused');
});

test('delegate refuses bad arguments, and a child that cannot start leaves a retired identity', async (t) => {
  const s = setup(t);
  for (const args of [{}, { task: '' }, { task: 'two\nlines' }, { task: 'x', minutes: 0 }, { task: 'x', grants: 'all' }, { task: 'x', grants: [{ resource: 1 }] }]) {
    await assert.rejects(s.d.delegate(s.parent, args), DelegationError, JSON.stringify(args));
  }
  await assert.rejects(s.d.delegate(s.parent, { task: 'x', workspace: 'D:/nowhere' }), /did not start: the identity has no write grant/);
  assert.equal(s.registry.get('local:dev/sub-1').status, 'retired');
});

test('delegate_status answers for the session\'s own sub-agents only', async (t) => {
  const s = setup(t);
  const at = NOW.toISOString();
  const row = s.db.prepare('INSERT INTO sessions (id, identity_id, workspace, containment, attended, policy_version, started_at, parent_session_id, ended_at, end_reason) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)');
  row.run('parent-1', 'local:dev', 'D:/work', 'container', 'v', at, null, null, null);
  row.run('kid', 'local:dev', 'D:/work', 'container', 'v', at, 'parent-1', at, 'exit 0');
  row.run('grandkid', 'local:dev', 'D:/work', 'container', 'v', at, 'kid', null, null);
  row.run('stranger', 'local:dev', 'D:/work', 'container', 'v', at, null, null, null);
  assert.deepEqual(s.d.status(s.parent, { session: 'kid' }), { session: 'kid', identity: 'local:dev', state: 'ended', end: 'exit 0', transcript: 'transcript of kid' });
  assert.equal(s.d.status(s.parent, { session: 'grandkid' }).state, 'running');
  for (const session of ['stranger', 'parent-1', 'nope']) assert.throws(() => s.d.status(s.parent, { session }), /no sub-agent of this session/);
});
