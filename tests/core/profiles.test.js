import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { ProfileError, createProfiles, profilesRoot } from '../../core/profiles.js';
import { globalDenies } from '../../core/policy.js';

test('profiles: default always there, new ones made with a folder and an audit event, ids never reused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-prof-'));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = path.join(dir, 'profiles');
  const p = createProfiles({ db, audit, root, now: () => new Date('2026-11-13T12:00:00Z') });
  assert.deepEqual(p.list().map((x) => x.id), ['default']);
  assert.ok(fs.existsSync(path.join(root, 'default')));
  const lab = p.create({ id: 'lab', displayName: 'Lab' });
  assert.deepEqual(lab, { id: 'lab', displayName: 'Lab', createdAt: '2026-11-13T12:00:00.000Z', folder: path.join(root, 'lab') });
  assert.ok(fs.existsSync(lab.folder));
  assert.deepEqual(p.list().map((x) => x.id), ['default', 'lab']);
  const e = [...audit.events()].at(-1);
  assert.deepEqual([e.type, e.action, e.resource], ['profile.change', 'profile.create', { type: 'Profile', id: 'lab' }]);
  const fails = (/** @type {string} */ code) => (/** @type {unknown} */ x) => x instanceof ProfileError && x.code === code;
  assert.throws(() => p.create({ id: 'lab', displayName: 'Again' }), fails('conflict'));
  for (const id of ['', 'Lab', 'a b', '../x', 'x'.repeat(41)]) assert.throws(() => p.create({ id, displayName: 'X' }), fails('bad_request'), id);
  assert.throws(() => p.create({ id: 'ok', displayName: '' }), fails('bad_request'));
  assert.throws(() => p.get('nope'), fails('not_found'));
  assert.throws(() => db.prepare("INSERT INTO profiles VALUES ('Bad Id', 'x', 'now')").run(), /CHECK/);
});

test('every profile\'s folder is a global deny, beside the data folder; the CLI homes are not', () => {
  const local = path.join(os.tmpdir(), 'local');
  assert.equal(profilesRoot(path.join(local, 'houston-core')), path.join(local, 'houston-profiles'));
  const coreDir = 'C:\\Users\\dev\\AppData\\Local\\houston-core';
  const g = Object.fromEntries(globalDenies({ home: 'C:\\Users\\dev', coreDir }).map((x) => [x.id, x.resource]));
  assert.equal(g['global:profiles'], 'file:C:/Users/dev/AppData/Local/houston-profiles/**');
  assert.equal(g['global:agent-homes'], undefined, 'not the CLI homes: each session opens its own there');
});
