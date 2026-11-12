import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreLockedError, migrate, openDb } from '../../core/db.js';
import { MIGRATIONS } from '../../core/migrations.js';
import { dataDir, start } from '../../core/main.js';

const MAIN = fileURLToPath(new URL('../../core/main.js', import.meta.url));
const NOW = '2026-01-01T00:00:00Z';

/** @param {import('node:test').TestContext} t */
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A migrated in-memory database with the operator in it. */
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO identities (id, kind, display_name, containment, created_at) VALUES ('local:me', 'operator', 'Me', 'unconfined', ?)").run(NOW);
  return db;
}

const version = (db) => db.prepare('PRAGMA user_version').get().user_version;
const tables = (db) => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

test('migrate builds schema v1 on an empty database and does nothing the second time', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db), { from: 0, to: MIGRATIONS.length });
  assert.deepEqual(tables(db), ['grants', 'identities', 'sessions']);
  assert.equal(version(db), MIGRATIONS.length);
  assert.deepEqual(migrate(db), { from: MIGRATIONS.length, to: MIGRATIONS.length });
});

test('migrate applies only the steps a database is missing', () => {
  const db = openDb(':memory:');
  migrate(db, ['CREATE TABLE a (x)']);
  assert.deepEqual(migrate(db, ['CREATE TABLE a (x)', 'CREATE TABLE b (x)']), { from: 1, to: 2 });
  assert.deepEqual(tables(db), ['a', 'b']);
});

test('a failed migration leaves the version and the schema as they were', () => {
  const db = openDb(':memory:');
  migrate(db, ['CREATE TABLE a (x)']);
  assert.throws(() => migrate(db, ['CREATE TABLE a (x)', 'CREATE TABLE b (x); CREATE TABLE a (x);']), /schema v2 failed/);
  assert.equal(version(db), 1);
  assert.deepEqual(tables(db), ['a']);
});

test('migrate refuses a database newer than the Core', () => {
  const db = openDb(':memory:');
  db.exec('PRAGMA user_version = 99');
  assert.throws(() => migrate(db), /schema v99.*update the Core/);
});

test('schema v1 refuses what the identity contract forbids', () => {
  const db = fresh();
  const add = (id, kind, owner, containment = 'container') =>
    db.prepare('INSERT INTO identities (id, kind, display_name, owner, containment, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, 'x', owner, containment, NOW);
  add('local:dev-codex', 'ai-agent', 'local:me');
  assert.throws(() => add('local:robot', 'robot', 'local:me'), /CHECK/);
  assert.throws(() => add('local:orphan', 'ai-agent', null), /CHECK/);
  assert.throws(() => add('local:stray', 'ai-agent', 'local:nobody'), /FOREIGN KEY/);
  assert.throws(() => add('dev-codex', 'ai-agent', 'local:me'), /CHECK/);
  assert.throws(() => add('local:jail', 'ai-agent', 'local:me', 'chroot'), /CHECK/);
});

test('an identity cannot be deleted, and retired is final', () => {
  const db = fresh();
  assert.throws(() => db.exec("DELETE FROM identities WHERE id = 'local:me'"), /never deleted/);
  db.exec("UPDATE identities SET status = 'retired' WHERE id = 'local:me'");
  assert.throws(() => db.exec("UPDATE identities SET status = 'active' WHERE id = 'local:me'"), /stays retired/);
});

test('a grant needs a real identity, a typed resource and a known effect', () => {
  const db = fresh();
  const grant = (id, identity, resource, effect) =>
    db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES (?, ?, ?, 'read', ?, ?, 'local:me')").run(id, identity, resource, effect, NOW);
  grant('g1', 'local:me', 'file:D:/work/app/**', 'allow');
  assert.throws(() => grant('g2', 'local:nobody', 'file:D:/work', 'allow'), /FOREIGN KEY/);
  assert.throws(() => grant('g3', 'local:me', 'D:/work', 'allow'), /CHECK/);
  assert.throws(() => grant('g4', 'local:me', 'file:D:/work', 'maybe'), /CHECK/);
  grant('g5', 'local:me', 'file:D:/work/.env', 'deny');
});

test('schema v2 keeps the grants a v1 database already had', () => {
  const db = openDb(':memory:');
  migrate(db, MIGRATIONS.slice(0, 1));
  db.exec(`INSERT INTO identities (id, kind, display_name, containment, created_at) VALUES ('local:me', 'operator', 'Me', 'unconfined', '${NOW}');
    INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES ('g1', 'local:me', 'file:D:/w/**', 'read', 'ask', '${NOW}', 'local:me');`);
  assert.deepEqual(migrate(db), { from: 1, to: MIGRATIONS.length });
  assert.equal(db.prepare('SELECT effect FROM grants').get().effect, 'ask');
});

test('dataDir: the override wins and must be absolute, then LOCALAPPDATA, then the home folder', () => {
  const abs = path.resolve('core-data');
  assert.equal(dataDir({ HOUSTON_CORE_DATA: ` ${abs} `, LOCALAPPDATA: 'L' }), abs);
  assert.throws(() => dataDir({ HOUSTON_CORE_DATA: 'core-data' }), /absolute/);
  assert.equal(dataDir({ LOCALAPPDATA: 'L' }), path.join('L', 'houston-core'));
  assert.equal(dataDir({ HOUSTON_CORE_DATA: '  ' }), path.join(os.homedir(), '.houston-core'));
});

test('start creates the folder and the database, and a second Core on it is refused until the first closes', (t) => {
  const dir = path.join(tmp(t), 'nested', 'core');
  const core = start(dir);
  assert.deepEqual(core.schema, { from: 0, to: MIGRATIONS.length });
  assert.ok(fs.existsSync(path.join(dir, 'core.db')));
  assert.throws(() => start(dir), CoreLockedError);
  core.close();
  const again = start(dir);
  assert.equal(again.schema.from, MIGRATIONS.length);
  again.close();
});

test('the entry point exits 2 while another process holds the lock, and a killed Core leaves none behind', async (t) => {
  const dir = tmp(t);
  const env = { ...process.env, HOUSTON_CORE_DATA: dir };
  const first = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => first.kill());
  const line = await new Promise((resolve) => first.stdout.once('data', (d) => resolve(String(d))));
  assert.equal(JSON.parse(line).event, 'core.start');

  const second = spawnSync(process.execPath, [MAIN], { env, encoding: 'utf8' });
  assert.equal(second.status, 2);
  assert.match(second.stderr, /already running/);

  first.kill();
  await new Promise((resolve) => first.once('exit', resolve));
  start(dir).close();
});
