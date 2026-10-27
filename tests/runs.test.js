import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNS_KEEP, RUN_OUTPUT_MAX, RUN_SCRIPT, Runs, changedFiles, cleanRuns, runIdFromUrl, runInfo, runLogUrl, runRows, runStateText } from '../src/shared/runs.js';
import { runLogPage } from '../src/shared/docs.js';
import { isAllowedNavigation, toUrl } from '../src/shared/url.js';

const P = { command: 'npm test', cwd: 'D:\\work\\app' };

test('a run succeeds or fails on its exit code alone', () => {
  const runs = new Runs();
  const a = runs.start({ ...P, terminal: 3 }, 100);
  const b = runs.start({ ...P, terminal: 4 }, 100);
  assert.deepEqual([a.run, b.run], [1, 2]);
  assert.equal(runs.get(), b);
  runs.end(3, 0, 'FAILED: everything (just text)', 400);
  runs.end(4, 2, 'all good', 500);
  assert.deepEqual([a.state, a.exitCode, a.endedAt], ['succeeded', 0, 400]);
  assert.deepEqual([b.state, b.exitCode], ['failed', 2]);
  assert.deepEqual(runInfo(a), { run: 1, terminal: 3, command: 'npm test', cwd: 'D:\\work\\app', state: 'succeeded', exitCode: 0, startedAt: 100, endedAt: 400, changed: null, durationMs: 300 });
});

test('cancel ends a running run with no exit code; a later exit changes nothing', () => {
  const runs = new Runs();
  const r = runs.start({ ...P, terminal: 7 }, 0);
  runs.cancel(7, 'partial', 50);
  runs.end(7, 1, 'late', 60);
  assert.deepEqual([r.state, r.exitCode, r.endedAt, r.output], ['cancelled', null, 50, 'partial']);
  assert.equal(runs.cancel(7, ''), undefined);
  assert.equal(runs.end(99, 0, ''), undefined, 'a terminal that never ran a command');
  assert.equal(runInfo(runs.start({ ...P, terminal: 8 }, 1000), 1600).durationMs, 600);
});

test('only the newest finished runs and the end of their output are kept', () => {
  const runs = new Runs();
  const first = runs.start({ ...P, terminal: 1 });
  for (let i = 2; i <= RUNS_KEEP + 5; i++) runs.end(i, 0, 'x'.repeat(RUN_OUTPUT_MAX + 10), runs.start({ ...P, terminal: i }).startedAt);
  assert.equal(runs.list.length, RUNS_KEEP);
  assert.equal(runs.get(1), first, 'still running, so kept');
  assert.equal(runs.get(2), undefined);
  assert.equal(runs.get()?.output?.length, RUN_OUTPUT_MAX);
});

test('the run script takes the command from the environment, never as an argument', () => {
  assert.match(RUN_SCRIPT, /\$env:ACC_RUN_COMMAND; Remove-Item Env:ACC_RUN_COMMAND/);
  assert.match(RUN_SCRIPT, /\[scriptblock\]::Create\(\$c\)/);
  assert.doesNotMatch(RUN_SCRIPT, /[\r\n]/);
});

test('runs.json comes back cleaned: bad entries dropped, a run the app quit during cancelled, ids continue', () => {
  const saved = [
    { run: 2, terminal: 5, command: 'npm test', cwd: 'D:\a', state: 'failed', exitCode: 1, startedAt: 10, endedAt: 20, output: 'x', changed: ['a.js', 7] },
    { run: 3, command: 'npm run build', cwd: 'D:\a', state: 'running', exitCode: null, startedAt: 30, endedAt: null, output: null, changed: null },
    { run: 2, command: 'dup', cwd: 'D:\a', state: 'failed', startedAt: 1 },
    { run: 'x', command: 'bad', cwd: 'D:\a', state: 'failed', startedAt: 1 },
    { run: 4, command: 'bad state', cwd: 'D:\a', state: 'exploded', startedAt: 1 },
    null,
  ];
  const runs = new Runs(saved);
  assert.deepEqual(runs.list.map((r) => [r.run, r.state, r.endedAt]), [[2, 'failed', 20], [3, 'cancelled', null]]);
  assert.deepEqual(runs.list[0].changed, ['a.js']);
  assert.equal(runInfo(runs.list[1]).durationMs, null);
  assert.equal(runs.start({ ...P, terminal: 9 }).run, 4);
  assert.deepEqual(cleanRuns('nope'), []);
  assert.equal(cleanRuns(Array.from({ length: RUNS_KEEP + 3 }, (_, i) => ({ run: i + 1, command: 'c', cwd: 'D:\a', state: 'succeeded', startedAt: 1 }))).length, RUNS_KEEP);
});

test('changedFiles lists the paths whose git status the run changed', () => {
  const f = (/** @type {string} */ path, /** @type {string | null} */ unstaged, kind = 'changed') => ({ path, from: null, staged: null, unstaged, kind: /** @type {any} */ (kind) });
  const before = [f('same.js', 'M'), f('fixed.js', 'M'), f('more.js', 'M')];
  const after = [f('same.js', 'M'), f('more.js', 'D'), f('new.txt', null, 'untracked')];
  assert.deepEqual(changedFiles(before, after), ['fixed.js', 'more.js', 'new.txt']);
  assert.deepEqual(changedFiles([], []), []);
  assert.equal(changedFiles(null, after), null);
  assert.equal(changedFiles(before, null), null);
});

test('runRows lists newest first and searches command, folder, changed files and output', () => {
  const runs = new Runs();
  runs.start({ command: 'npm test', cwd: 'D:\work\api', terminal: 1 }, 1);
  runs.end(1, 1, '\x1b[31mFAIL\x1b[0m src/login.test.js\r\nok', 2);
  runs.start({ command: 'npm run build', cwd: 'D:\work\web', terminal: 2 }, 3);
  runs.end(2, 0, 'built', 4);
  runs.list[1].changed = ['dist/app.js'];
  assert.deepEqual(runRows(runs.list).map((r) => r.run), [2, 1]);
  assert.deepEqual(runRows(runs.list, '  LOGIN ').map((r) => [r.run, r.match]), [[1, 'FAIL src/login.test.js']]);
  assert.deepEqual(runRows(runs.list, 'dist/').map((r) => [r.run, r.match]), [[2, null]]);
  assert.deepEqual(runRows(runs.list, 'work\api').map((r) => r.run), [1]);
  assert.deepEqual(runRows(runs.list, 'npm run').map((r) => [r.run, r.match]), [[2, null]]);
  assert.deepEqual(runRows(runs.list, 'nothing like it'), []);
  assert.equal('output' in runRows(runs.list)[0], false);
});

test('a run log page has a fixed address, opens from the app only, and is plain text', () => {
  assert.equal(runLogUrl(12), 'acc://runlog/12');
  assert.equal(runIdFromUrl('acc://runlog/12'), 12);
  for (const bad of ['acc://runlog/', 'acc://runlog/x', 'acc://runlog/1/../2', 'acc://run/1', 'https://example.com/']) assert.equal(runIdFromUrl(bad), null, bad);
  assert.equal(isAllowedNavigation('acc://runlog/3'), true);
  assert.equal(toUrl('acc://runlog/3'), 'acc://runlog/3');
  assert.equal(isAllowedNavigation('acc://runlog/3', 'https://evil.example/'), false);
  assert.equal(isAllowedNavigation('acc://runlog/3', 'acc://runlog/2'), false);
  const html = runLogPage({ run: 3, command: '<b>npm</b>', cwd: 'D:\a', state: 'failed (exit 1)', started: 'today', took: '2 s', changed: ['<x>.js'], output: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>alert|<b>npm|<x>/);
  assert.match(html, /Changed files \(1\)/);
  assert.match(runLogPage({ run: 1, command: 'c', cwd: 'D:\a', state: 'cancelled', started: 'today', took: null, changed: null, output: '' }), /not a Git repository/);
  assert.deepEqual([runStateText({ state: 'succeeded', exitCode: 0 }), runStateText({ state: 'failed', exitCode: 3 }), runStateText({ state: 'cancelled', exitCode: null })], ['finished (exit 0)', 'failed (exit 3)', 'cancelled']);
});
