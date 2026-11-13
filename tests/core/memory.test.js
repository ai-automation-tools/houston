import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { ensureOperator } from '../../core/identities.js';
import { MAX_PENDING, MemoryError, createMemory } from '../../core/memory.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-memory-'));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  ensureOperator(db, audit);
  return { audit, memory: createMemory({ db, audit }) };
}

const s = { id: 'sess-1', identity: 'local:dev', profile: 'default' };

test('proposals queue with their source, capped per profile; bad text and bad reviews are refused', (t) => {
  const { memory, audit } = setup(t);
  for (const text of ['', ' ', 'x'.repeat(2001), 7, 'a\0b']) assert.throws(() => memory.propose(s, { text }), MemoryError, String(text).slice(0, 20));
  for (let i = 0; i < MAX_PENDING; i++) memory.propose(s, { text: `fact ${i}` });
  assert.throws(() => memory.propose(s, { text: 'one more' }), (e) => e instanceof MemoryError && e.code === 'conflict');
  const first = memory.list({ state: 'pending' }).at(-1);
  assert.deepEqual([first.text, first.source], ['fact 0', { identity: 'local:dev', session: 'sess-1' }]);
  assert.throws(() => memory.review(first.id, 'maybe'), /approve or reject/);
  assert.throws(() => memory.review('nope', 'approve'), (e) => e instanceof MemoryError && e.code === 'not_found');
  memory.review(first.id, 'reject', 'not true');
  assert.equal(memory.list({ state: 'rejected' })[0].note, 'not true');
  memory.propose(s, { text: 'room again' });
  assert.throws(() => memory.list({ state: 'nope' }), /state is one of/);
  assert.equal([...audit.events()].filter((e) => e.type === 'memory.change').length, MAX_PENDING + 2);
});

test('recall serves approved items only, newest first, filtered by every word given', (t) => {
  const { memory } = setup(t);
  memory.add('The API uses pnpm');
  memory.add('Deploys go out on Fridays');
  memory.propose(s, { text: 'pnpm is banned' });
  assert.deepEqual(memory.recall(s, { query: 'PNPM' }).items.map((i) => i.text), ['The API uses pnpm']);
  assert.deepEqual(memory.recall(s, {}).items.map((i) => i.source), ['local:operator', 'local:operator']);
  assert.deepEqual(memory.recall(s, { query: 'pnpm fridays' }).items, []);
  memory.remove(memory.list()[0].id);
  assert.equal(memory.list().length, 2);
});
