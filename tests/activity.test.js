import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_KEEP, Activity, activityRows } from '../src/shared/activity.js';

const cmd = (/** @type {string} */ asked) => ({ kind: /** @type {const} */ ('command'), asked, target: 'D:/work/app' });

test('an ask waits, the oldest on the bar and the rest queued, and Run, Deny, a timeout and a withdrawal each end it their way', () => {
  const a = new Activity();
  const ids = ['npm test', 'git status', 'npm run build', 'ls'].map((c) => a.ask(cmd(c), 100).id);
  let rows = activityRows(a.list);
  assert.deepEqual(rows.map((r) => r.label), ['queued', 'queued', 'queued', 'waiting for approval'], 'newest first');
  assert.ok(rows.every((r) => r.open));
  assert.equal(rows[3].where, 'its own PowerShell in D:/work/app');

  a.answered(ids[0], true, false);
  a.answered(ids[1], false, false, 200);
  a.answered(ids[2], null, false, 300);
  a.answered(ids[3], null, true, 400);
  rows = activityRows(a.list);
  assert.deepEqual(rows.map((r) => [r.text, r.state, r.label]), [
    ['ls', 'withdrawn', 'withdrawn by its asker'],
    ['npm run build', 'expired', 'not answered in time'],
    ['git status', 'denied', 'denied'],
    ['npm test', 'running', 'starting'],
  ]);
  assert.equal(rows[2].endedAt, 200);
  assert.equal(a.answered(ids[1], true, false)?.state, 'denied', 'a settled ask stays settled');
  assert.equal(a.answered(99, true, false), undefined);
});

test('a command follows its managed run to the exit code, and a cancel or a start error ends it too', () => {
  const a = new Activity();
  const [ok, bad, cut, broke] = ['a', 'b', 'c', 'd'].map((c) => a.ask(cmd(c)).id);
  for (const id of [ok, bad, cut, broke]) a.answered(id, true, false);
  a.ranAs(ok, 7);
  a.ranAs(bad, 8);
  a.ranAs(cut, 9);
  assert.equal(activityRows(a.list).find((r) => r.id === ok)?.label, 'running (run 7)');
  a.runEnded(/** @type {any} */ ({ run: 7, state: 'succeeded', exitCode: 0, endedAt: 50 }));
  a.runEnded(/** @type {any} */ ({ run: 8, state: 'failed', exitCode: 3, endedAt: 60 }));
  a.runEnded(/** @type {any} */ ({ run: 9, state: 'cancelled', exitCode: null, endedAt: 70 }));
  assert.equal(a.runEnded(/** @type {any} */ ({ run: 42, state: 'failed', exitCode: 1, endedAt: 1 })), undefined, 'a run nobody asked for');
  a.settle(broke, 'failed', 'cwd is gone');
  const rows = Object.fromEntries(activityRows(a.list).map((r) => [r.id, r]));
  assert.deepEqual([rows[ok].label, rows[bad].label, rows[cut].label, rows[broke].label], ['finished (exit 0)', 'failed (exit 3)', 'cancelled', 'failed']);
  assert.equal(rows[bad].endedAt, 60);
  assert.equal(rows[broke].error, 'cwd is gone');
  assert.ok(Object.values(rows).every((r) => !r.open));
});

test('a Cronsole task names its id, ends as started in Cronsole, and only open work survives the cap', () => {
  const a = new Activity();
  const t = a.ask({ kind: 'task', asked: 'Nightly backup', target: 'backup-1' });
  assert.equal(a.settle(t.id, 'started')?.state, 'waiting', 'not before Run');
  a.answered(t.id, true, false);
  a.settle(t.id, 'started');
  const [row] = activityRows(a.list);
  assert.deepEqual([row.text, row.where, row.label, row.icon], ['Nightly backup', 'Cronsole task backup-1', 'started in Cronsole', '↗']);

  for (let i = 0; i < ACTIVITY_KEEP + 5; i++) a.answered(a.ask(cmd(`echo ${i}`)).id, false, false);
  assert.equal(a.list.length, ACTIVITY_KEEP);
  const open = a.ask(cmd('still waiting'));
  for (let i = 0; i < ACTIVITY_KEEP; i++) a.answered(a.ask(cmd(`x ${i}`)).id, false, false);
  assert.ok(a.get(open.id), 'a waiting ask is never dropped');
  assert.equal(a.get(t.id), undefined, 'the oldest finished one is');
});

test('a tab_click or tab_fill ask names the attached tab and ends done or failed', () => {
  const a = new Activity();
  const page = { kind: /** @type {const} */ ('page'), asked: 'click button "Go"', target: 'example.com' };
  const ok = a.ask(page, 1);
  const bad = a.ask(page, 2);
  for (const w of [ok, bad]) a.answered(w.id, true, false, 3);
  a.settle(ok.id, 'succeeded', null, 4);
  a.settle(bad.id, 'failed', 'Something else covers element 1 on the page', 5);
  const rows = activityRows(a.list);
  assert.deepEqual(rows.map((r) => [r.label, r.where]), [['failed', 'the attached tab at example.com'], ['done', 'the attached tab at example.com']]);
  assert.match(String(rows[0].error), /covers/);
});
