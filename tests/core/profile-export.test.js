import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { createApprovals } from '../../core/approvals.js';
import { createGateway } from '../../core/gateway.js';
import { OPERATOR, createRegistry, ensureOperator } from '../../core/identities.js';
import { createMemory } from '../../core/memory.js';
import { FORMAT, VERSION, exportProfile, restoreProfile } from '../../core/profile-export.js';
import { createProfiles } from '../../core/profiles.js';
import { createStanding } from '../../core/standing.js';
import { openVault } from '../../core/vault.js';

const WIN = process.platform === 'win32';
// Workspaces can't sit in the user profile (launch.js refuses them): a gitignored folder in the repo.
const SCRATCH = fileURLToPath(new URL('../../.test-tmp/', import.meta.url));
const SECRET_VALUE = ['ghp', 'exporttest', 'Qm4vT9xL2r'].join('_');

/** One Core's parts over a database of its own. @param {import('node:test').TestContext} t @param {string} root */
async function core(t, root) {
  const dir = fs.mkdtempSync(path.join(root, 'core-'));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); db.close(); });
  ensureOperator(db, audit);
  const registry = createRegistry({ db, audit });
  const vault = await openVault({ db, dir, audit });
  const gateway = createGateway({ db, audit, vault, registry, approvals: createApprovals({ audit }), coreDir: dir, tempRoot: path.join(dir, 'sessions'), agentsRoot: path.join(dir, 'agents'), sdk: /** @type {any} */ ({}) });
  const standing = createStanding({ db, audit, runner: /** @type {any} */ ({ list: () => [] }) });
  const profiles = createProfiles({ db, audit });
  const memory = createMemory({ db, audit, redact: vault.redact });
  const parts = { audit, profiles, registry, gateway, standing, memory, vault };
  return { db, audit, parts, ...parts, events: () => [...audit.events()] };
}

/** @param {import('node:test').TestContext} t */
function scratch(t) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(SCRATCH, 'export-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a profile goes out with no secret value in it and comes back as drafts, a discovered server and a paused grant', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const root = scratch(t);
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const a = await core(t, root);
  a.profiles.create({ id: 'lab', displayName: 'Lab' });
  a.registry.create({ id: 'local:lab-dev', kind: 'ai-agent', displayName: 'Lab dev', profile: 'lab', tags: ['nightly'] }, OPERATOR);
  a.registry.setStatus('local:lab-dev', 'active', OPERATOR);
  a.registry.addGrant({ identity: 'local:lab-dev', resource: `file:${ws.replaceAll('\\', '/')}/**`, permission: 'write' }, OPERATOR);
  a.registry.addGrant({ identity: 'local:lab-dev', resource: 'net:api.example.com:443', permission: 'connect', effect: 'ask' }, OPERATOR);
  const soon = a.registry.addGrant({ identity: 'local:lab-dev', resource: 'net:old.example.com:443', permission: 'connect', expiresAt: new Date(Date.now() + 60_000).toISOString() }, OPERATOR);
  a.registry.create({ id: 'local:lab-bot', kind: 'service-account', displayName: 'Lab bot', owner: 'local:lab-dev', profile: 'lab' }, OPERATOR);
  a.registry.create({ id: 'local:lab-gone', kind: 'ai-agent', displayName: 'Gone', profile: 'lab' }, OPERATOR);
  a.registry.setStatus('local:lab-gone', 'retired', OPERATOR);
  a.registry.create({ id: 'local:elsewhere', kind: 'ai-agent', displayName: 'Default one' }, OPERATOR);
  a.vault.set('gh-token', SECRET_VALUE, OPERATOR, 'lab');
  a.gateway.add({ name: 'stub', command: `"${process.execPath}" stub.js --key ${SECRET_VALUE}`, env: { TOKEN: 'secret:gh-token', MODE: 'quiet' }, profile: 'lab' });
  // A credential pasted into env as text instead of the vault: it leaves redacted, and the server can't come back as it was.
  a.gateway.add({ name: 'pasted', command: 'srv.exe', env: { PASTED: SECRET_VALUE }, profile: 'lab' });
  a.registry.addGrant({ identity: 'local:mcp/stub', resource: 'secret:gh-token', permission: 'use' }, OPERATOR);
  a.standing.create({ id: 'nightly', identity: 'local:lab-dev', workspace: ws, command: 'cmd.exe /d /c echo hi', maxMinutes: 10, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  a.memory.add('The lab builds with npm.', 'lab');

  // An hour on, the short grant has expired and stays behind.
  const doc = exportProfile(a.parts, 'lab', new Date(Date.parse(/** @type {string} */ (soon.expiresAt)) + 1));
  const text = JSON.stringify(doc);
  assert.ok(!text.includes(SECRET_VALUE), 'no secret value in the export');
  assert.equal(doc.format, FORMAT);
  assert.deepEqual(doc.profile, { id: 'lab', displayName: 'Lab', preset: null });
  assert.deepEqual(doc.identities.map((i) => i.id), ['local:lab-bot', 'local:lab-dev']);
  assert.deepEqual(doc.identities[1].grants.map((g) => g.resource).sort(), ['net:api.example.com:443', `file:${ws.replaceAll('\\', '/')}/**`].sort());
  const out = Object.fromEntries(doc.servers.map((s) => [s.name, s]));
  assert.equal(out.stub.env.TOKEN, 'secret:gh-token');
  assert.match(out.stub.command, /--key \[REDACTED/);
  assert.deepEqual(out.stub.grants.map((g) => g.resource), ['secret:gh-token']);
  assert.match(out.pasted.env.PASTED, /REDACTED/);
  assert.deepEqual(doc.standing.map((s) => [s.id, s.status]), [['nightly', 'active']]);
  assert.deepEqual(doc.memory, ['The lab builds with npm.']);
  assert.deepEqual(doc.secrets, ['gh-token']);
  assert.ok(a.events().some((e) => e.type === 'profile.change' && e.action === 'profile.export' && e.resource.id === 'lab'));

  // Into another Core, through the same calls the operator makes.
  const b = await core(t, root);
  const r = restoreProfile(b.parts, JSON.parse(text));
  assert.deepEqual(r.skipped.map((x) => x.what), ['server pasted']);
  assert.deepEqual(r.servers, ['stub']);
  assert.equal(r.created, true);
  assert.deepEqual(r.identities.sort(), ['local:lab-bot', 'local:lab-dev']);
  assert.deepEqual(r.secrets, ['gh-token']);
  const dev = b.registry.get('local:lab-dev');
  assert.equal(dev.status, 'draft', 'the operator activates it again');
  assert.equal(dev.profile, 'lab');
  assert.deepEqual(dev.tags, ['nightly']);
  assert.deepEqual(dev.grants.map((g) => [g.resource, g.permission, g.effect]).sort(), [['net:api.example.com:443', 'connect', 'ask'], [`file:${ws.replaceAll('\\', '/')}/**`, 'write', 'allow']].sort());
  assert.equal(b.registry.get('local:lab-bot').owner, 'local:lab-dev');
  const stub = b.gateway.get('stub');
  assert.equal(stub.state, 'discovered', 'install and pin it again');
  assert.equal(stub.env.TOKEN, 'secret:gh-token');
  assert.deepEqual(b.registry.get('local:mcp/stub').grants.map((g) => g.resource), ['secret:gh-token']);
  assert.deepEqual(b.vault.list('lab'), [], 'no secret comes back');
  assert.equal(b.standing.get('nightly').status, 'paused');
  assert.deepEqual(b.memory.list({ profile: 'lab', state: 'approved' }).map((m) => m.text), ['The lab builds with npm.']);
  assert.ok(b.events().some((e) => e.action === 'profile.restore'));
  assert.ok(b.events().some((e) => e.action === 'grant.add'), 'each grant is audited like any other');

  // A second restore finds its ids taken and writes nothing.
  const before = b.events().length;
  assert.throws(() => restoreProfile(b.parts, JSON.parse(text)), (e) => e.code === 'conflict' && /local:lab-dev/.test(e.message) && /server stub/.test(e.message) && /standing grant nightly/.test(e.message));
  assert.equal(b.events().length, before);
});

test('restore refuses a bad document or a preset that differs, and skips what the checks refuse', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const root = scratch(t);
  const b = await core(t, root);
  for (const bad of [null, [], {}, { format: FORMAT, version: 2, profile: { id: 'x' } }, { format: FORMAT, version: VERSION }, { format: FORMAT, version: VERSION, profile: { id: 'x', displayName: 'X' }, identities: 'no' }]) {
    assert.throws(() => restoreProfile(b.parts, bad), (e) => e.code === 'bad_request');
  }
  b.profiles.create({ id: 'jail', displayName: 'Jail', preset: 'quarantine' });
  const doc = (/** @type {any} */ extra) => ({ format: FORMAT, version: VERSION, profile: { id: 'jail', displayName: 'Jail', preset: null }, ...extra });
  assert.throws(() => restoreProfile(b.parts, doc({})), (e) => e.code === 'conflict' && /preset/.test(e.message));

  // A hand-edited one: the quarantine refuses an unconfined identity and an http server, and an
  // operator or mcp-server identity isn't something an export carries.
  const r = restoreProfile(b.parts, doc({
    profile: { id: 'jail', displayName: 'Jail', preset: 'quarantine' },
    identities: [
      { id: 'local:wide', kind: 'ai-agent', displayName: 'Wide', containment: 'unconfined' },
      { id: 'local:boss', kind: 'operator', displayName: 'Boss' },
      { id: 'local:mcp/sneak', kind: 'mcp-server', displayName: 'Sneak' },
      { id: 'local:ok', kind: 'ai-agent', displayName: 'Ok', grants: [{ resource: 'net:*.example.com:443', permission: 'connect', effect: 'allow' }] },
      { id: 'local:orphan', kind: 'service-account', displayName: 'Orphan', owner: 'local:loop' },
      { id: 'local:loop', kind: 'service-account', displayName: 'Loop', owner: 'local:orphan' },
    ],
    servers: [{ name: 'web', transport: 'http', url: 'http://127.0.0.1:9/mcp' }],
    memory: ['remembered', 42],
  }));
  assert.equal(r.created, false);
  assert.deepEqual(r.identities, ['local:ok']);
  assert.deepEqual(r.servers, []);
  assert.equal(r.memory, 1);
  const why = Object.fromEntries(r.skipped.map((s) => [s.what, s.reason]));
  assert.match(why['identity local:wide'], /quarantine/);
  assert.match(why['identity local:boss'], /carries/);
  assert.match(why['identity local:mcp/sneak'], /carries/);
  assert.match(why['identity local:orphan'], /could not come first/);
  assert.match(why['server web'], /quarantine/);
  assert.ok(/wildcards/.test(why['grant net:*.example.com:443 for local:ok']), 'a quarantine profile refuses a wildcard host');
  assert.ok(why['a memory item']);
  assert.throws(() => b.registry.get('local:boss'));
});

test('export names a profile that exists', { skip: !WIN && 'the Core is Windows only' }, async (t) => {
  const b = await core(t, scratch(t));
  assert.throws(() => exportProfile(b.parts, 'nope'), (e) => e.code === 'not_found');
  assert.throws(() => exportProfile(b.parts, 42), (e) => e.code === 'not_found');
  assert.equal(exportProfile(b.parts, 'default').identities.length, 0, 'the operator is in every profile and never exported');
});
