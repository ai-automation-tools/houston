import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { OPERATOR, RegistryError, createRegistry, ensureOperator } from '../../core/identities.js';
import { createProfiles } from '../../core/profiles.js';
import { quarantineGrantRefusal } from '../../core/quarantine.js';
import { openVault } from '../../core/vault.js';

const WIN = process.platform === 'win32';

test('quarantineGrantRefusal: files inside the work folder only, one host per net grant, no secrets', () => {
  const folder = 'D:\\q\\houston-quarantine\\try';
  assert.equal(quarantineGrantRefusal('file:D:/q/houston-quarantine/try/**', folder), null);
  assert.equal(quarantineGrantRefusal('file:D:/q/houston-quarantine/try/sub/*.json', folder), null);
  assert.equal(quarantineGrantRefusal('net:api.example.com:443', folder), null);
  assert.equal(quarantineGrantRefusal('tool:stub/echo', folder), null);
  for (const r of ['file:D:/q/houston-quarantine/**', 'file:D:/q/houston-quarantine/try-other/**', 'file:C:/**', 'file:D:/q/houston-quarantine/try/../x/**']) {
    assert.match(String(quarantineGrantRefusal(r, folder)), /inside its work folder/, r);
  }
  assert.match(String(quarantineGrantRefusal('net:*.example.com:443', folder)), /no wildcards/);
  assert.match(String(quarantineGrantRefusal('secret:token', folder)), /no secrets/);
  assert.match(String(quarantineGrantRefusal('file:D:/x/**', null)), /no quarantine work folder/);
});

test('a quarantine profile: its work folder is made, no broad-access identity, grants held to the rules, no secrets', { skip: !WIN && 'the vault is Windows only' }, async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-quar-')));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  ensureOperator(db, audit);
  const qroot = path.join(dir, 'houston-quarantine');
  const profiles = createProfiles({ db, audit, root: path.join(dir, 'houston-profiles'), quarantine: qroot });
  const q = profiles.create({ id: 'try', displayName: 'Try a server', preset: 'quarantine' });
  assert.deepEqual([q.preset, q.workFolder], ['quarantine', path.join(qroot, 'try')]);
  assert.ok(fs.existsSync(q.workFolder));
  assert.throws(() => profiles.create({ id: 'odd', displayName: 'Odd', preset: 'loose' }), /preset is one of quarantine/);

  const registry = createRegistry({ db, audit, quarantineRoot: qroot });
  assert.throws(() => registry.create({ id: 'local:wide', kind: 'ai-agent', displayName: 'Wide', containment: 'unconfined', profile: 'try' }, OPERATOR), /no broad-access/);
  registry.create({ id: 'local:tester', kind: 'ai-agent', displayName: 'Tester', profile: 'try' }, OPERATOR);
  const work = q.workFolder.replaceAll('\\', '/');
  registry.addGrant({ identity: 'local:tester', resource: `file:${work}/**`, permission: 'write' }, OPERATOR);
  registry.addGrant({ identity: 'local:tester', resource: 'file:C:/**', permission: 'read', effect: 'deny' }, OPERATOR);
  assert.throws(() => registry.addGrant({ identity: 'local:tester', resource: 'file:D:/projects/**', permission: 'read' }, OPERATOR), (e) => e instanceof RegistryError && /inside its work folder/.test(e.message));
  assert.throws(() => registry.addGrant({ identity: 'local:tester', resource: 'net:*:443', permission: 'connect' }, OPERATOR), /no wildcards/);
  // The same grant outside quarantine is fine.
  registry.create({ id: 'local:home', kind: 'ai-agent', displayName: 'Home' }, OPERATOR);
  registry.addGrant({ identity: 'local:home', resource: 'file:D:/projects/**', permission: 'read' }, OPERATOR);

  fs.mkdirSync(path.join(dir, 'core'));
  const vault = await openVault({ db, dir: path.join(dir, 'core'), audit });
  assert.throws(() => vault.set('token', 'x', OPERATOR, 'try'), /holds no secrets/);
  vault.set('token', 'x', OPERATOR);
});
