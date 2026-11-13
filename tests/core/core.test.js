import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreLockedError, migrate, openDb } from '../../core/db.js';
import { MIGRATIONS } from '../../core/migrations.js';
import { callControl } from '../../core/control.js';
import { dataDir, sessionTemp, start } from '../../core/main.js';

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
  assert.deepEqual(tables(db), ['grants', 'identities', 'mcp_servers', 'memories', 'profiles', 'secrets', 'sessions', 'skills', 'standing_grants']);
  assert.equal(version(db), MIGRATIONS.length);
  assert.deepEqual(migrate(db), { from: MIGRATIONS.length, to: MIGRATIONS.length });
});

test('v10 keeps every grant while the table is rebuilt to take skill: and memory: resources', () => {
  const db = openDb(':memory:');
  migrate(db, MIGRATIONS.slice(0, 9));
  const at = '2026-11-13T00:00:00Z';
  db.prepare("INSERT INTO identities (id, kind, display_name, status, containment, created_at, owner) VALUES ('local:a', 'ai-agent', 'A', 'active', 'container', ?, 'local:a')").run(at);
  const add = db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES (?, 'local:a', ?, ?, 'allow', ?, 'local:operator')");
  add.run('g1', 'file:D:/w/**', 'write', at);
  assert.throws(() => add.run('g2', 'skill:x', 'use', at), /CHECK constraint/);
  assert.deepEqual(migrate(db), { from: 9, to: MIGRATIONS.length });
  add.run('g2', 'skill:x', 'use', at);
  add.run('g3', 'memory:default', 'read', at);
  assert.deepEqual(db.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id), ['g1', 'g2', 'g3']);
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

test('schema v5 gives a v4 server the container transport and refuses an unknown one', () => {
  const db = openDb(':memory:');
  migrate(db, MIGRATIONS.slice(0, 4));
  db.exec(`INSERT INTO identities (id, kind, display_name, containment, created_at) VALUES ('local:me', 'operator', 'Me', 'unconfined', '${NOW}');
    INSERT INTO identities (id, kind, display_name, owner, containment, created_at) VALUES ('local:mcp/a', 'mcp-server', 'A', 'local:me', 'container', '${NOW}');
    INSERT INTO mcp_servers (name, identity_id, command, state, added_at, updated_at) VALUES ('a', 'local:mcp/a', 'node a.js', 'pinned', '${NOW}', '${NOW}');`);
  migrate(db);
  assert.equal(db.prepare('SELECT transport FROM mcp_servers').get().transport, 'container');
  assert.throws(() => db.exec("UPDATE mcp_servers SET transport = 'pipe'"), /CHECK/);
});

test('dataDir: the override wins and must be absolute, then LOCALAPPDATA, then the home folder', () => {
  const abs = path.resolve('core-data');
  assert.equal(dataDir({ HOUSTON_CORE_DATA: ` ${abs} `, LOCALAPPDATA: 'L' }), abs);
  assert.throws(() => dataDir({ HOUSTON_CORE_DATA: 'core-data' }), /absolute/);
  assert.equal(dataDir({ LOCALAPPDATA: 'L' }), path.join('L', 'houston-core'));
  assert.equal(dataDir({ HOUSTON_CORE_DATA: '  ' }), path.join(os.homedir(), '.houston-core'));
});

test('with --exit-with-parent the Core stops cleanly once the process that started it is gone', async (t) => {
  const dir = tmp(t);
  const logged = () => (fs.existsSync(path.join(dir, 'core.log')) ? fs.readFileSync(path.join(dir, 'core.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const until = async (/** @type {() => boolean} */ ok, /** @type {string} */ what) => {
    for (let i = 0; i < 80 && !ok(); i++) await new Promise((r) => setTimeout(r, 250));
    assert.ok(ok(), what);
  };
  // A stand-in for conhost: it starts the Core and is then killed, as ending the task does.
  // detached: Node otherwise puts its children in a job that kills them with it, which conhost doesn't.
  const starter = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, [${JSON.stringify(MAIN)}, '--exit-with-parent'], { stdio: 'ignore', detached: true }); setInterval(() => {}, 1e9);`],
    { env: { ...process.env, HOUSTON_CORE_DATA: dir }, stdio: 'ignore' });
  t.after(() => starter.kill());
  await until(() => logged().some((l) => l.event === 'core.start'), 'the Core started');
  const pid = logged().find((l) => l.event === 'core.start').pid;
  starter.kill();
  await until(() => logged().some((l) => l.event === 'core.stop'), 'the Core stopped after its parent ended');
  assert.equal(logged().at(-1).why, 'its parent process ended');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the Core process exited');
});

test('sessionTemp: the override wins and must be absolute, then ProgramData', () => {
  const abs = path.resolve('session-temp');
  assert.equal(sessionTemp({ HOUSTON_SESSION_TEMP: ` ${abs} `, ProgramData: 'P' }), abs);
  assert.throws(() => sessionTemp({ HOUSTON_SESSION_TEMP: 'rel' }), /absolute/);
  assert.equal(sessionTemp({ ProgramData: 'P' }), path.join('P', 'houston-core', 'sessions'));
});

test('start makes the data folder the operator\'s alone', (t) => {
  const dir = path.join(tmp(t), 'core');
  start(dir).close();
  if (process.platform !== 'win32') return assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const acl = spawnSync('icacls', [dir], { encoding: 'utf8' }).stdout.replace(dir, '');
  // No inherited entries; only the operator and SYSTEM, plus Administrators when the folder was
  // made elevated (CI is), which are outside the threat model anyway (ADR-004).
  assert.doesNotMatch(acl, /\(I\)/);
  const who = acl.split('\n').map((l) => /^\s*(.+?):\(/.exec(l)?.[1]).filter(Boolean);
  assert.ok(who.includes('NT AUTHORITY\\SYSTEM'));
  assert.ok(who.some((w) => w.toLowerCase().endsWith(`\\${os.userInfo().username.toLowerCase()}`)), who.join(', '));
  for (const w of who) assert.match(w, new RegExp(`^(NT AUTHORITY\\\\SYSTEM|BUILTIN\\\\Administrators|.+\\\\${os.userInfo().username})$`, 'i'));
});

test('start creates the folder and the database, and a second Core on it is refused until the first closes', (t) => {
  const dir = path.join(tmp(t), 'nested', 'core');
  const core = start(dir);
  assert.deepEqual(core.schema, { from: 0, to: MIGRATIONS.length });
  assert.ok(fs.existsSync(path.join(dir, 'core.db')));
  assert.deepEqual(core.db.prepare('SELECT id, kind, status FROM identities').all().map((r) => ({ ...r })), [{ id: 'local:operator', kind: 'operator', status: 'active' }]);
  assert.throws(() => start(dir), CoreLockedError);
  core.close();
  const again = start(dir);
  assert.equal(again.schema.from, MIGRATIONS.length);
  again.close();
});

test('the entry point exits 2 while another process holds the lock, and a killed Core leaves none behind', async (t) => {
  const dir = tmp(t);
  const env = { ...process.env, HOUSTON_CORE_DATA: dir };
  const first = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => first.kill());
  let err = '';
  first.stderr.on('data', (d) => { err += d; });
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no core.start in 20 s; stderr: ${err}`)), 20_000);
    first.stdout.once('data', (d) => { clearTimeout(timer); resolve(String(d)); });
    first.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the Core exited ${code}: ${err}`)); });
  });
  assert.equal(JSON.parse(line).event, 'core.start');
  // On Windows it serves the Control API, named in control.json.
  if (process.platform === 'win32') {
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')).pipe, JSON.parse(line).pipe);
    assert.deepEqual(await callControl(dir, 'session.list', {}, { timeoutMs: 5000 }), []);
  } else assert.equal(JSON.parse(line).pipe, null);

  const second = spawnSync(process.execPath, [MAIN], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(second.status, 2, `second Core: ${second.error?.message ?? ''} ${second.stdout} ${second.stderr}`);
  // A Core started hidden has no console: its start and the second one's refusal are in core.log.
  const log = fs.readFileSync(path.join(dir, 'core.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => [l.event, l.alreadyRunning]), [['core.start', undefined], ['core.error', true]]);
  assert.match(second.stderr, /already running/);

  first.kill();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the Core did not exit in 20 s; stderr: ${err}`)), 20_000);
    first.once('exit', () => { clearTimeout(timer); resolve(undefined); });
  });
  start(dir).close();
});
