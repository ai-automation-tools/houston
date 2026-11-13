import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { OPERATOR, RegistryError, createRegistry, ensureOperator } from '../../core/identities.js';

const NOW = new Date('2026-11-12T12:00:00Z');

/** @param {import('node:test').TestContext} t */
function setup(t) {
  const db = openDb(':memory:');
  migrate(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-reg-'));
  const audit = openAudit(dir);
  t.after(() => { audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  ensureOperator(db, audit, () => NOW);
  const reg = createRegistry({ db, audit, now: () => NOW });
  const events = () => [...audit.events()];
  const agent = (id = 'local:dev-shell', extra = {}) => reg.create({ id, kind: 'ai-agent', displayName: 'Dev shell', ...extra }, OPERATOR);
  return { db, audit, reg, events, agent };
}

/** @param {string} code */
const fails = (code, re = /./) => (e) => e instanceof RegistryError && e.code === code && re.test(e.message);

test('ensureOperator makes local:operator once, active and unconfined, and the database takes no second operator', (t) => {
  const s = setup(t);
  assert.equal(ensureOperator(s.db, s.audit), OPERATOR);
  const op = s.reg.get(OPERATOR);
  assert.deepEqual([op.kind, op.status, op.containment, op.owner], ['operator', 'active', 'unconfined', null]);
  assert.deepEqual(s.events().map((e) => [e.type, e.resource.id, e.lifecycle.to]), [['identity.lifecycle', OPERATOR, 'active']]);
  assert.throws(() => s.db.prepare("INSERT INTO identities (id, kind, display_name, containment, created_at) VALUES ('local:other', 'operator', 'Other', 'unconfined', 'x')").run(), /UNIQUE/);
});

test('create makes a draft owned by the caller, audited, in the schema\'s shape', (t) => {
  const s = setup(t);
  const id = s.agent('local:dev-shell', { purpose: 'Try the harness', backend: 'codex', tags: ['h1'], expiresAt: '2027-01-01T00:00:00Z' });
  assert.deepEqual(id, {
    id: 'local:dev-shell', kind: 'ai-agent', displayName: 'Dev shell', owner: OPERATOR, parent: null, purpose: 'Try the harness', backend: 'codex',
    status: 'draft', containment: 'container', createdAt: NOW.toISOString(), lastUsedAt: null, expiresAt: '2027-01-01T00:00:00.000Z', retiredAt: null,
    reviewedAt: null, reviewBy: null, tags: ['h1'], grants: [],
  });
  const e = s.events().at(-1);
  assert.deepEqual([e.type, e.action, e.identity.subject, e.resource, e.lifecycle], ['identity.lifecycle', 'identity.create', OPERATOR, { type: 'Identity', id: 'local:dev-shell' }, { from: null, to: 'draft' }]);
  assert.match(e.decision.policy_version, /^[0-9a-f]{16}$/);
  assert.deepEqual(s.reg.list().map((i) => i.id), ['local:dev-shell', OPERATOR]);
  assert.deepEqual(s.reg.list({ status: 'draft' }).map((i) => i.id), ['local:dev-shell']);
  assert.throws(() => s.reg.list({ status: 'gone' }), fails('bad_request'));
});

test('create refuses what the identity contract forbids', (t) => {
  const s = setup(t);
  const base = { id: 'local:x', kind: 'ai-agent', displayName: 'X' };
  for (const [spec, re] of [
    [{ ...base, id: 'dev' }, /id is/], [{ ...base, id: 'local:Dev' }, /id is/], [{ ...base, id: 'local:a b' }, /id is/],
    [{ ...base, kind: 'operator' }, /one operator/], [{ ...base, kind: 'robot' }, /kind/],
    [{ ...base, displayName: '' }, /displayName/], [{ ...base, displayName: 'x'.repeat(81) }, /displayName/],
    [{ ...base, owner: 'local:nobody' }, /owner/], [{ ...base, kind: 'sub-agent' }, /parent/], [{ ...base, parent: 'local:nobody' }, /parent/],
    [{ ...base, containment: 'vm' }, /containment/], [{ ...base, expiresAt: '2020-01-01' }, /past/], [{ ...base, expiresAt: 'soon' }, /date/],
    [{ ...base, tags: 'a' }, /tags/], [{ ...base, purpose: 'x'.repeat(301) }, /purpose/],
    [{ ...base, backend: 'gemini' }, /backend is one of claude-code, codex/], [{ ...base, backend: 'constructor' }, /backend/],
  ]) assert.throws(() => s.reg.create(spec, OPERATOR), fails('bad_request', re), JSON.stringify(spec));
  s.agent('local:x');
  assert.throws(() => s.agent('local:x'), fails('conflict', /exists/));
});

test('the lifecycle: draft, active, suspended and back, then retired for good', (t) => {
  const s = setup(t);
  s.agent();
  const to = (status, reason) => s.reg.setStatus('local:dev-shell', status, OPERATOR, reason).status;
  assert.throws(() => to('suspended'), fails('conflict', /draft; it can become active or retired/));
  assert.equal(to('active'), 'active');
  assert.equal(to('suspended', 'looked odd'), 'suspended');
  assert.equal(to('active'), 'active');
  const retired = s.reg.setStatus('local:dev-shell', 'retired', OPERATOR);
  assert.deepEqual([retired.status, retired.retiredAt], ['retired', NOW.toISOString()]);
  for (const s2 of ['active', 'suspended', 'retired']) assert.throws(() => to(s2), fails('conflict', /can become nothing else/));
  assert.throws(() => s.agent(), fails('conflict', /ids are never reused/));
  assert.throws(() => s.reg.setStatus(OPERATOR, 'suspended', OPERATOR), fails('bad_request', /operator/));
  assert.throws(() => s.reg.setStatus('local:nobody', 'active', OPERATOR), fails('not_found'));
  assert.deepEqual(s.events().filter((e) => e.resource.id === 'local:dev-shell').map((e) => [e.action, e.lifecycle.from, e.lifecycle.to, e.lifecycle.reason]), [
    ['identity.create', null, 'draft', undefined], ['identity.activate', 'draft', 'active', undefined], ['identity.suspend', 'active', 'suspended', 'looked odd'],
    ['identity.activate', 'suspended', 'active', undefined], ['identity.retire', 'active', 'retired', undefined],
  ]);
  // A retired owner can't own anything new.
  assert.throws(() => s.agent('local:y', { owner: 'local:dev-shell' }), fails('bad_request', /retired/));
});

test('grants: added and removed with checks on type, permission, effect and pattern, each audited with the new policy version', (t) => {
  const s = setup(t);
  s.agent();
  const before = s.events().at(-1).decision.policy_version;
  const g = s.reg.addGrant({ identity: 'local:dev-shell', resource: 'file:D:/work/app/**', permission: 'write' }, OPERATOR);
  assert.deepEqual({ ...g, id: undefined }, { id: undefined, identity: 'local:dev-shell', resource: 'file:D:/work/app/**', permission: 'write', effect: 'allow', expiresAt: null });
  const added = s.events().at(-1);
  assert.deepEqual([added.type, added.action, added.resource, added.grant.resource], ['grant.change', 'grant.add', { type: 'Grant', id: g.id }, 'file:D:/work/app/**']);
  assert.notEqual(added.decision.policy_version, before);
  assert.deepEqual(s.reg.get('local:dev-shell').grants.map((x) => [x.resource, x.permission, x.effect, x.grantedBy]), [['file:D:/work/app/**', 'write', 'allow', OPERATOR]]);
  s.reg.addGrant({ identity: 'local:dev-shell', resource: 'net:registry.npmjs.org:443', permission: 'connect', effect: 'ask' }, OPERATOR);
  s.reg.addGrant({ identity: 'local:dev-shell', resource: 'file:D:/work/app/.env', permission: 'read', effect: 'deny' }, OPERATOR);

  const add = (spec) => () => s.reg.addGrant({ identity: 'local:dev-shell', permission: 'read', resource: 'file:D:/w/**', ...spec }, OPERATOR);
  for (const [spec, re] of [
    [{ resource: 'disk:D:/w' }, /resource is/], [{ resource: 'D:/w' }, /resource is/], [{ permission: 'connect' }, /read or write or list/],
    [{ resource: 'net:example.com', permission: 'connect' }, /host:port/], [{ resource: 'file:work/**' }, /resource:/],
    [{ effect: 'maybe' }, /effect/], [{ expiresAt: '2001-01-01' }, /past/],
  ]) assert.throws(add(spec), fails('bad_request', re), JSON.stringify(spec));
  assert.throws(() => s.reg.addGrant({ identity: OPERATOR, resource: 'file:D:/w/**', permission: 'read' }, OPERATOR), fails('bad_request', /operator/));
  assert.throws(() => s.reg.addGrant({ identity: 'local:nobody', resource: 'file:D:/w/**', permission: 'read' }, OPERATOR), fails('not_found'));

  assert.deepEqual(s.reg.removeGrant(g.id, OPERATOR).resource, 'file:D:/work/app/**');
  assert.equal(s.events().at(-1).action, 'grant.remove');
  assert.equal(s.reg.get('local:dev-shell').grants.length, 2);
  assert.throws(() => s.reg.removeGrant(g.id, OPERATOR), fails('not_found'));

  s.reg.setStatus('local:dev-shell', 'retired', OPERATOR);
  assert.throws(add({}), fails('conflict', /retired/));
});

test('review marks an identity reviewed and due again in 90 days, or the days given; audited', (t) => {
  const s = setup(t);
  s.agent();
  const r = s.reg.review('local:dev-shell', undefined, OPERATOR);
  assert.deepEqual([r.reviewedAt, r.reviewBy], [NOW.toISOString(), '2027-02-10T12:00:00.000Z']);
  assert.equal(s.reg.review('local:dev-shell', 7, OPERATOR).reviewBy, '2026-11-19T12:00:00.000Z');
  const e = s.events().at(-1);
  assert.deepEqual([e.type, e.action, e.lifecycle, e.review.reviewBy], ['identity.lifecycle', 'identity.review', { from: 'draft', to: 'draft' }, '2026-11-19T12:00:00.000Z']);
  for (const d of [0, 367, 1.5, 'x']) assert.throws(() => s.reg.review('local:dev-shell', d, OPERATOR), fails('bad_request', /days/));
  assert.throws(() => s.reg.review(OPERATOR, undefined, OPERATOR), fails('bad_request'));
  s.reg.setStatus('local:dev-shell', 'retired', OPERATOR);
  assert.throws(() => s.reg.review('local:dev-shell', undefined, OPERATOR), fails('conflict'));
});

test('reach groups live grants by type and effect, leaves out expired ones, and names what a container cannot apply', (t) => {
  const s = setup(t);
  s.agent('local:dev-shell', { backend: 'codex' });
  const add = (resource, permission, extra = {}) => s.reg.addGrant({ identity: 'local:dev-shell', resource, permission, ...extra }, OPERATOR);
  add('file:D:/work/**', 'write');
  add('file:D:/docs/*.md', 'read');
  add('net:chatgpt.com:443', 'connect');
  add('net:api.openai.com:443', 'connect', { effect: 'ask' });
  add('tool:github.*', 'call');
  const old = add('net:old.example:443', 'connect', { expiresAt: '2026-11-13T00:00:00Z' });
  s.db.prepare("UPDATE grants SET expires_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(old.id);
  const r = s.reg.reach('local:dev-shell');
  assert.deepEqual(r.types.file.allow, [{ resource: 'D:/docs/*.md', permission: 'read' }, { resource: 'D:/work/**', permission: 'write' }]);
  assert.deepEqual(r.types.net, { allow: [{ resource: 'chatgpt.com:443', permission: 'connect' }], ask: [{ resource: 'api.openai.com:443', permission: 'connect' }], deny: [] });
  assert.deepEqual(r.types.tool.allow, [{ resource: 'github.*', permission: 'call' }]);
  assert.equal(r.expired, 1);
  assert.deepEqual(r.notApplied.map((n) => n.resource), ['file:D:/docs/*.md']);
  assert.deepEqual([r.enforced, r.backend.name, r.backend.missingHosts], [true, 'codex', ['auth.openai.com:443', 'api.openai.com:443']]);
  assert.deepEqual(r.standing, []);
  assert.throws(() => s.reg.reach('local:nobody'), fails('not_found'));
});
