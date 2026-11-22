// Schema upgrades (H7): from every earlier version to the latest, with the data each version
// could hold, and the copy the Core makes before an upgrade.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, openDb } from '../../core/db.js';
import { MIGRATIONS } from '../../core/migrations.js';
import { start } from '../../core/main.js';

const T = '2026-01-01T00:00:00Z';
const LATER = '2027-01-01T00:00:00Z';

/**
 * SEEDS[k] runs right after migration k (which makes schema v`k + 1`): a row of each thing that
 * step made possible, as a Core of that version would have written it.
 */
const SEEDS = [
  // v1: identities, grants, sessions.
  `INSERT INTO identities (id, kind, display_name, containment, created_at) VALUES ('local:me', 'operator', 'Me', 'unconfined', '${T}');
   INSERT INTO identities (id, kind, display_name, owner, status, containment, created_at, tags) VALUES ('local:a', 'ai-agent', 'A', 'local:me', 'active', 'container', '${T}', '["x"]');
   INSERT INTO grants VALUES ('g1', 'local:a', 'file:D:/work/**', 'write', 'allow', '${T}', 'local:me', NULL, NULL);
   INSERT INTO grants VALUES ('g2', 'local:a', 'net:example.com:443', 'connect', 'ask', '${T}', 'local:me', '${LATER}', '${T}');
   INSERT INTO sessions (id, identity_id, workspace, containment, attended, policy_version, started_at, ended_at, end_reason)
     VALUES ('s1', 'local:a', 'D:/work', 'container', 1, 'p1', '${T}', '${T}', 'exit 0');`,
  // v2: a deny grant.
  `INSERT INTO grants VALUES ('g3', 'local:a', 'file:D:/work/.env', 'read', 'deny', '${T}', 'local:me', NULL, NULL);`,
  // v3: one operator per database (an index only).
  'SELECT 1;',
  // v4: a secret and a pinned container server.
  `INSERT INTO identities (id, kind, display_name, owner, status, containment, created_at) VALUES ('local:mcp/fs', 'mcp-server', 'fs', 'local:me', 'active', 'container', '${T}');
   INSERT INTO secrets (name, blob, created_at, updated_at) VALUES ('gh-token', x'0102ff', '${T}', '${T}');
   INSERT INTO mcp_servers (name, identity_id, command, env, state, tools, tools_hash, pinned_hash, added_at, updated_at)
     VALUES ('fs', 'local:mcp/fs', 'node fs.js', '{"TOKEN":"secret:gh-token"}', 'pinned', '[]', 'h1', 'h1', '${T}', '${T}');`,
  // v5: an http server.
  `INSERT INTO identities (id, kind, display_name, owner, status, containment, created_at) VALUES ('local:mcp/web', 'mcp-server', 'web', 'local:me', 'active', 'unconfined', '${T}');
   INSERT INTO mcp_servers (name, identity_id, command, state, added_at, updated_at, transport) VALUES ('web', 'local:mcp/web', 'http://127.0.0.1:9/mcp', 'installed', '${T}', '${T}', 'http');`,
  // v6: a standing grant and a session run under it.
  `INSERT INTO standing_grants (id, identity_id, workspace, command, grants_hash, max_minutes, expires_at, status, created_at, updated_at)
     VALUES ('nightly', 'local:a', 'D:/work', 'npm test', 'gh', 20, '${LATER}', 'active', '${T}', '${T}');
   INSERT INTO sessions (id, identity_id, workspace, containment, attended, policy_version, started_at, standing_grant_id)
     VALUES ('s2', 'local:a', 'D:/work', 'container', 0, 'p1', '${T}', 'nightly');`,
  // v7: a standing grant that runs a prompt.
  `INSERT INTO standing_grants (id, identity_id, workspace, command, grants_hash, max_minutes, expires_at, status, created_at, updated_at, prompt)
     VALUES ('summary', 'local:a', 'D:/work', '', 'gh', 10, '${LATER}', 'paused', '${T}', '${T}', 'Summarise the day');`,
  // v8: review dates.
  `UPDATE identities SET reviewed_at = '${T}', review_by = '${LATER}' WHERE id = 'local:a';`,
  // v9: a second profile, with an identity and a secret in it.
  `INSERT INTO profiles (id, display_name, created_at) VALUES ('work', 'Work', '${T}');
   INSERT INTO identities (id, kind, display_name, owner, containment, created_at, profile_id) VALUES ('local:b', 'ai-agent', 'B', 'local:me', 'container', '${T}', 'work');
   INSERT INTO secrets (name, blob, created_at, updated_at, profile_id) VALUES ('work-key', x'00', '${T}', '${T}', 'work');`,
  // v10: an installed skill and the grants that use it and profile memory.
  `INSERT INTO skills VALUES ('default', 'review', 'promptbook', 'hash', 2, 100, '${T}', 'local:me');
   INSERT INTO grants VALUES ('g4', 'local:a', 'skill:review', 'use', 'allow', '${T}', 'local:me', NULL, NULL);
   INSERT INTO grants VALUES ('g5', 'local:a', 'memory:default', 'read', 'allow', '${T}', 'local:me', NULL, NULL);`,
  // v11: a reviewed memory.
  `INSERT INTO memories VALUES ('m1', 'default', 'Prefers pnpm', 'approved', 'local:a', 's1', '${T}', '${T}', 'local:me', NULL);`,
  // v12: a broad-access identity with standing grants switched on.
  `INSERT INTO identities (id, kind, display_name, owner, status, containment, created_at, standing_allowed) VALUES ('local:c', 'ai-agent', 'C', 'local:me', 'active', 'unconfined', '${T}', 1);`,
  // v13: a quarantine profile.
  `INSERT INTO profiles (id, display_name, created_at, preset) VALUES ('lab', 'Lab', '${T}', 'quarantine');`,
];

/** @param {DatabaseSync} db @param {number} version */
function climb(db, version) {
  for (let v = 0; v < version; v++) {
    migrate(db, MIGRATIONS.slice(0, v + 1));
    db.exec(SEEDS[v]);
  }
  return db;
}

/** A database at schema v`version`, holding a row of each kind every step up to it made. */
const at = (/** @type {number} */ version) => climb(openDb(':memory:'), version);

const tables = (/** @type {DatabaseSync} */ db) => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((r) => String(r.name));
const columns = (/** @type {DatabaseSync} */ db, /** @type {string} */ t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => String(c.name));
/** Each row's values for `cols`, as sorted text. */
const rows = (/** @type {DatabaseSync} */ db, /** @type {string} */ t, /** @type {string[]} */ cols) =>
  db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${t}`).all().map((r) => JSON.stringify(cols.map((c) => (r[c] instanceof Uint8Array ? Buffer.from(r[c]).toString('hex') : r[c])))).sort();
const schemaSql = (/** @type {DatabaseSync} */ db) => db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all().map((r) => `${r.type} ${r.name}: ${r.sql}`);
/** @param {DatabaseSync} db */
const snapshot = (db) => Object.fromEntries(tables(db).map((t) => { const cols = columns(db, t); return [t, { cols, rows: rows(db, t, cols) }]; }));

/** A scratch folder, removed after the test once `closing` has run (after hooks run in the order they're added). */
function tmp(/** @type {import('node:test').TestContext} */ t, /** @type {() => void} */ closing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-migrate-'));
  t.after(() => { closing(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('every migration has a seed here, so the upgrade test covers what it adds', () => {
  assert.equal(SEEDS.length, MIGRATIONS.length, 'a new migration needs a SEEDS entry with a row of each thing it makes possible');
});

test('a database at every earlier schema upgrades to the latest with all its rows, and then takes what the latest Core writes', () => {
  const latest = schemaSql(at(MIGRATIONS.length));
  for (let v = 1; v < MIGRATIONS.length; v++) {
    const db = at(v);
    const before = snapshot(db);
    assert.deepEqual(migrate(db), { from: v, to: MIGRATIONS.length }, `from v${v}`);
    for (const [t, { cols, rows: had }] of Object.entries(before)) assert.deepEqual(rows(db, t, cols), had, `v${v} to the latest: ${t}`);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], `v${v}: foreign keys`);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok', `v${v}: integrity`);
    assert.deepEqual(schemaSql(db), latest, `v${v}: the upgraded schema is the one a new database gets`);
    for (const s of SEEDS.slice(v)) db.exec(s);
    db.close();
  }
});

test('columns an upgrade adds take their defaults on old rows', () => {
  const db = at(1);
  migrate(db);
  assert.deepEqual({ ...db.prepare("SELECT profile_id, standing_allowed, reviewed_at FROM identities WHERE id = 'local:a'").get() }, { profile_id: 'default', standing_allowed: 0, reviewed_at: null });
  assert.equal(db.prepare("SELECT standing_grant_id FROM sessions WHERE id = 's1'").get()?.standing_grant_id, null);
  const old = at(4);
  migrate(old);
  assert.equal(old.prepare("SELECT transport FROM mcp_servers WHERE name = 'fs'").get()?.transport, 'container');
  assert.equal(old.prepare("SELECT profile_id FROM secrets WHERE name = 'gh-token'").get()?.profile_id, 'default');
});

test('before an upgrade, the database is copied as it was; the copy opens at the old schema with every row', (t) => {
  /** @type {DatabaseSync[]} */
  const open = [];
  const dir = tmp(t, () => open.forEach((d) => d.isOpen && d.close()));
  const db = climb(openDb(path.join(dir, 'core.db')), 5);
  open.push(db);
  const before = snapshot(db);
  /** @type {number[]} */
  const asked = [];
  const file = path.join(dir, 'core-v5.db');
  const r = migrate(db, undefined, { backup: (v) => { asked.push(v); return file; } });
  assert.deepEqual(r, { from: 5, to: MIGRATIONS.length, backup: file });
  assert.deepEqual(asked, [5]);
  const copy = new DatabaseSync(file, { readOnly: true });
  open.push(copy);
  assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 5);
  assert.deepEqual(snapshot(copy), before);
});

test('no copy for a new database or one already up to date', () => {
  let called = 0;
  const backup = () => { called++; return 'unused.db'; };
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db, undefined, { backup }), { from: 0, to: MIGRATIONS.length });
  assert.deepEqual(migrate(db, undefined, { backup }), { from: MIGRATIONS.length, to: MIGRATIONS.length });
  assert.equal(called, 0);
});

test('a copy that fails stops the upgrade before any step runs', (t) => {
  /** @type {DatabaseSync | undefined} */
  let db;
  const dir = tmp(t, () => db?.close());
  db = climb(openDb(path.join(dir, 'core.db')), 3);
  assert.throws(() => migrate(db, undefined, { backup: () => path.join(dir, 'no-such-folder', 'copy.db') }), /backup before migrating from schema v3 failed, so nothing was migrated/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
  // A copy that already exists is refused too, rather than overwritten.
  fs.writeFileSync(path.join(dir, 'taken.db'), 'x');
  assert.throws(() => migrate(db, undefined, { backup: () => path.join(dir, 'taken.db') }), /backup before migrating/);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
});

test('the Core keeps its copy in backups\\ in its data folder and says so in its core.start event', (t) => {
  /** @type {ReturnType<typeof start> | undefined} */
  let core;
  const dir = tmp(t, () => core?.close());
  climb(new DatabaseSync(path.join(dir, 'core.db')), 2).close();
  core = start(dir);
  assert.equal(core.schema.from, 2);
  const copies = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^core-v2-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.db$/);
  assert.equal(core.schema.backup, path.join(fs.realpathSync.native(dir), 'backups', copies[0]));
  const ev = [...core.audit.events()].find((e) => e.type === 'core.start');
  assert.deepEqual(ev.migration, core.schema);
});
