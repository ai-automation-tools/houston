import test from 'node:test';
import assert from 'node:assert/strict';
import { LOG_LIMIT, logFilter, logRow, sessionChoices } from '../src/shared/logs.js';

test('logFilter passes only an identity, a session and a decision, and maps session to session_id', () => {
  assert.deepEqual(logFilter({ identity: 'local:a', session: 's1', result: 'deny' }), { identity: 'local:a', session_id: 's1', result: 'deny', limit: LOG_LIMIT });
  assert.deepEqual(logFilter({ identity: '', session: '', result: '' }), { limit: LOG_LIMIT });
  assert.deepEqual(logFilter(undefined), { limit: LOG_LIMIT });
  assert.deepEqual(logFilter({ type: 'session.start', since: 'x', limit: 5 }), { limit: LOG_LIMIT });
  assert.throws(() => logFilter({ result: 'maybe' }), /allow, ask or deny/);
  assert.throws(() => logFilter({ identity: 7 }), /identity is an id/);
  assert.throws(() => logFilter({ session: 'x'.repeat(101) }), /session is an id/);
});

test('logRow names what happened to what, with who, and the reasons in its title', () => {
  const r = logRow({
    type: 'egress.connect', time: '2026-11-12T10:00:00Z', identity: { subject: 'local:a' }, session_id: 's1',
    resource: { type: 'NetHost', id: 'example.org:443' }, decision: { result: 'deny', reasons: ['no grant'] },
  });
  assert.equal(r.result, 'deny');
  assert.equal(r.icon, '✕');
  assert.equal(r.name, 'egress.connect example.org:443');
  assert.match(r.sub, /^local:a · /);
  assert.match(r.title, /egress\.connect: deny \(no grant\)/);
  assert.match(r.title, /session s1/);
  // A resource that is the session itself isn't repeated; an approval says its answer.
  assert.equal(logRow({ type: 'session.end', session_id: 's1', resource: { id: 's1' }, decision: { result: 'allow' } }).name, 'session.end');
  assert.equal(logRow({ type: 'approval.decided', resource: { id: 'h:443' }, decision: { result: 'allow' }, approval: { answer: 'once' } }).name, 'approval.decided h:443 (once)');
  assert.equal(logRow({ type: 'approval.requested', decision: { result: 'ask' } }).icon, '?');
  assert.equal(logRow({ type: 'x', time: 'nonsense' }).sub, '? · ?');
});

test('sessionChoices lists started sessions newest first', () => {
  const c = sessionChoices([
    { session_id: 's1', identity: { subject: 'local:a' }, time: '2026-11-12T10:00:00Z' },
    { session_id: null, time: '2026-11-12T10:01:00Z' },
    { session_id: 's2', identity: { subject: 'local:b' }, time: '2026-11-12T10:02:00Z' },
  ]);
  assert.deepEqual(c.map((x) => x.id), ['s2', 's1']);
  assert.match(c[0].label, /^local:b · /);
});
