import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { ensureOperator } from '../../core/identities.js';
import { VaultError, openVault } from '../../core/vault.js';

/** @param {import('node:test').TestContext} t */
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-vault-'));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(dir, 'audit'));
  ensureOperator(db, audit);
  t.after(() => { audit.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, audit };
}

const VALUE = ['ghp', 'vaulttest', 'Q8w2Zr7KpL0x'].join('_');

test('the vault stores a value sealed, lists names only, and never writes the value anywhere else', async (t) => {
  const { dir, db, audit } = setup(t);
  const vault = await openVault({ db, dir, audit });
  const row = vault.set('github-token', VALUE);
  assert.deepEqual(Object.keys(row).sort(), ['created_at', 'last_used_at', 'name', 'updated_at']);
  assert.deepEqual(vault.list().map((s) => s.name), ['github-token']);
  // Sealed in the database: the bytes don't hold the value.
  const blob = Buffer.from(/** @type {any} */ (db.prepare('SELECT blob FROM secrets').get()).blob);
  assert.ok(!blob.includes(Buffer.from(VALUE)));
  // The audit log names the secret and never holds its value.
  const log = fs.readdirSync(path.join(dir, 'audit')).map((f) => fs.readFileSync(path.join(dir, 'audit', f), 'utf8')).join('');
  assert.match(log, /"secret\.change"/);
  assert.ok(!log.includes(VALUE));
  assert.equal(fs.statSync(path.join(dir, 'vault.key')).size, 32);

  assert.equal(vault.reveal('github-token'), VALUE);
  assert.ok(vault.list()[0].last_used_at);
  // Replacing keeps one row.
  vault.set('github-token', `${VALUE}2`);
  assert.equal(vault.reveal('github-token'), `${VALUE}2`);
  assert.equal(vault.list().length, 1);
});

test('a reopened vault reads its values with the same key; another data folder, other entropy, does not (S5)', async (t) => {
  const { dir, db, audit } = setup(t);
  (await openVault({ db, dir, audit })).set('k', VALUE);
  assert.equal((await openVault({ db, dir, audit })).reveal('k'), VALUE);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-vault-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const v2 = await openVault({ db, dir: other, audit });
  assert.throws(() => v2.reveal('k'), (e) => e instanceof VaultError && e.code === 'sealed');
});

test('the vault refuses bad names and values, and deletes', async (t) => {
  const { dir, db, audit } = setup(t);
  const vault = await openVault({ db, dir, audit });
  for (const name of ['', 'Upper', 'has space', 'a/b', 'x'.repeat(64), 42]) assert.throws(() => vault.set(name, VALUE), (e) => e instanceof VaultError && e.code === 'bad_request');
  for (const value of ['', 'two\nlines', 7, 'x'.repeat(16 * 1024 + 1)]) assert.throws(() => vault.set('ok', value), (e) => e instanceof VaultError && e.code === 'bad_request');
  assert.throws(() => vault.reveal('nope'), (e) => e instanceof VaultError && e.code === 'not_found');
  vault.set('gone', VALUE);
  assert.deepEqual(vault.remove('gone'), { name: 'gone', deleted: true });
  assert.throws(() => vault.remove('gone'), (e) => e instanceof VaultError && e.code === 'not_found');
});

test('redact replaces every stored value, longest first, and leaves short ones', async (t) => {
  const { dir, db, audit } = setup(t);
  const vault = await openVault({ db, dir, audit });
  vault.set('long', `${VALUE}-extended`);
  vault.set('short', VALUE);
  vault.set('pin', '1234');
  assert.equal(vault.redact(`a ${VALUE}-extended b ${VALUE} c 1234`), 'a [REDACTED:secret:long] b [REDACTED:secret:short] c 1234');
  // A change is seen at once.
  vault.remove('short');
  assert.equal(vault.redact(VALUE), VALUE);
});
