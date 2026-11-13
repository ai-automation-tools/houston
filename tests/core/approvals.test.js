import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { ApprovalError, createApprovals } from '../../core/approvals.js';

function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-approvals-'));
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let changes = 0;
  const approvals = createApprovals({ audit, onChange: () => changes++, ...opts });
  const events = () => [...audit.events()];
  return { approvals, events, changes: () => changes };
}

const ask = (over = {}) => ({
  identity: 'local:dev', session_id: 's1', workspace: 'D:\\w', action: 'net.connect',
  resource: { type: 'Host', id: 'example.com:443' }, policy_version: 'v1', policy_ids: ['g1'], ...over,
});

test('once allows one request; the next identical one asks again', async (t) => {
  const s = setup(t);
  const first = s.approvals.ask(ask());
  const [card] = s.approvals.list();
  assert.deepEqual([card.identity, card.workspace, card.action, card.resource.id], ['local:dev', 'D:\\w', 'net.connect', 'example.com:443']);
  assert.ok(Date.parse(card.expiresAt) > Date.parse(card.createdAt));
  assert.deepEqual(s.approvals.decide(card.id, 'once'), { result: 'allow' });
  assert.deepEqual(await first, { result: 'allow', reason: 'allowed once by the operator' });
  assert.deepEqual(s.approvals.list(), []);
  void s.approvals.ask(ask());
  assert.equal(s.approvals.list().length, 1);
  s.approvals.endSession('s1');
});

test('session allows identical requests for the rest of that session only', async (t) => {
  const s = setup(t);
  const first = s.approvals.ask(ask());
  s.approvals.decide(s.approvals.list()[0].id, 'session');
  assert.equal((await first).result, 'allow');
  assert.deepEqual(await s.approvals.ask(ask()), { result: 'allow', reason: 'allowed for this session by the operator' });
  // Another host, or another session, asks again.
  void s.approvals.ask(ask({ resource: { type: 'Host', id: 'other.com:443' } }));
  void s.approvals.ask(ask({ session_id: 's2' }));
  assert.equal(s.approvals.list().length, 2);
  // A session that ends denies what it had waiting and forgets its allows.
  const waiting = s.approvals.ask(ask({ resource: { type: 'Host', id: 'third.com:443' } }));
  s.approvals.endSession('s1');
  assert.deepEqual(await waiting, { result: 'deny', reason: 'the session ended' });
  assert.deepEqual(s.approvals.list().map((a) => a.session_id), ['s2']);
  void s.approvals.ask(ask());
  assert.equal(s.approvals.list().length, 2, 'the session allow is gone with its session');
  s.approvals.endSession('s1');
  s.approvals.endSession('s2');
});

test('deny, a timeout, and refused answers', async (t) => {
  const s = setup(t, { timeoutMs: 50 });
  const denied = s.approvals.ask(ask());
  const id = s.approvals.list()[0].id;
  assert.throws(() => s.approvals.decide(id, 'yes'), (e) => e instanceof ApprovalError && e.code === 'bad_request');
  assert.throws(() => s.approvals.decide(id, 'constructor'), (e) => e.code === 'bad_request');
  s.approvals.decide(id, 'deny');
  assert.deepEqual(await denied, { result: 'deny', reason: 'denied by the operator' });
  assert.throws(() => s.approvals.decide(id, 'once'), (e) => e.code === 'not_found');
  assert.deepEqual(await s.approvals.ask(ask()), { result: 'deny', reason: 'no answer in 0 s' });
  assert.deepEqual(s.approvals.list(), []);
  assert.ok(s.changes() >= 4);
});

test('every ask and outcome is audited, with who answered', async (t) => {
  const s = setup(t, { timeoutMs: 30 });
  const a = s.approvals.ask(ask());
  s.approvals.decide(s.approvals.list()[0].id, 'once');
  await a;
  await s.approvals.ask(ask({ resource: { type: 'Host', id: 'late.com:443' } }));
  const ev = s.events().map((e) => [e.type, e.decision.result, e.decision.reasons[0], e.approval.answer ?? null, e.approval.by ?? null, e.identity.subject, e.session_id, e.resource.id]);
  assert.deepEqual(ev, [
    ['approval.requested', 'ask', 'waiting for the operator', null, null, 'local:dev', 's1', 'example.com:443'],
    ['approval.decided', 'allow', 'allowed once by the operator', 'once', 'local:operator', 'local:dev', 's1', 'example.com:443'],
    ['approval.requested', 'ask', 'waiting for the operator', null, null, 'local:dev', 's1', 'late.com:443'],
    ['approval.decided', 'deny', 'no answer in 0 s', 'timeout', 'local:core', 'local:dev', 's1', 'late.com:443'],
  ]);
  assert.equal(s.events()[0].approval.id, s.events()[1].approval.id);
  assert.deepEqual(s.events()[1].decision.policy_ids, ['g1']);
});
