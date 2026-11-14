import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeLines, gateProblems, parseRecord, recordLine, requiredTests } from '../abuse/gate.js';
import { anonymize, at13FromSmoke, attempt, firstLine, removeDir } from '../abuse/harness.js';

const REQ = ['AT-01', 'AT-02', 'AT-13'];
const NOW = { clean: true, ids: ['a1', 'b2'] };
const good = () => ({ full: true, tests: REQ.map((id) => ({ id, pass: true })), attempts: 9, through: 0, source: { clean: true, ids: ['a1', 'b2'] } });

test('the gate reads the required tests from the requirements table, each once', () => {
  const md = '| ID | x |\n|:---|:---|\n| AT-02 | b |\n| AT-01 | a |\n| AT-01 | again |\nSee AT-09 in prose.\n  | AT-03 | indented, not a row |';
  assert.deepEqual(requiredTests(md), ['AT-01', 'AT-02']);
  assert.deepEqual(requiredTests(''), []);
  assert.ok(requiredTests(fs.readFileSync(new URL('../docs/product/harness-requirements.md', import.meta.url), 'utf8')).length >= 16);
});

test('the gate record round-trips through a results file, and a missing or broken one is null', () => {
  const r = good();
  assert.deepEqual(parseRecord(`# Run\n\n| a | b |\n${recordLine(r)}\n`), r);
  assert.equal(parseRecord('# Run\n'), null);
  assert.equal(parseRecord('<!-- abuse-gate {not json} -->'), null);
  assert.equal(parseRecord('<!-- abuse-gate {"tests":[]} -->'), null);
  assert.equal(parseRecord('text <!-- abuse-gate {"tests":[],"source":{"ids":[]}} --> inline'), null);
});

test('the gate passes a full, clean, all-pass run on this code and refuses everything else', () => {
  assert.deepEqual(gateProblems(good(), REQ, NOW), []);
  assert.equal(gateProblems(null, REQ, NOW).length, 1);
  /** @param {(r: ReturnType<typeof good>) => void} f @param {RegExp} re @param {typeof NOW} [now] */
  const refused = (f, re, now = NOW) => { const r = good(); f(r); const p = gateProblems(r, REQ, now); assert.ok(p.some((x) => re.test(x)), p.join(' ')); };
  refused((r) => { r.full = false; }, /full run/);
  refused((r) => { r.tests = r.tests.filter((t) => t.id !== 'AT-13'); }, /Not run: AT-13/);
  refused((r) => { r.tests[1].pass = false; }, /Failed: AT-02/);
  refused((r) => { /** @type {any} */ (r.tests[0]).pass = 'true'; }, /Failed: AT-01/);
  refused((r) => { r.through = 1; }, /got through/);
  refused((r) => { r.attempts = 0; }, /No attempts/);
  refused((r) => { r.source.clean = false; }, /uncommitted changes\.$/);
  refused(() => {}, /checkout has uncommitted/, { clean: false, ids: NOW.ids });
  refused((r) => { r.source.ids = ['a1', 'zz']; }, /other code/);
  refused(() => {}, /other code/, { clean: true, ids: ['a1'] });
});

test('the fingerprint leaves Markdown out, so a docs change needs no new run', () => {
  const out = '100644 blob aa\tcore/README.md\n100644 blob bb\tcore/main.js\r\n M core/NOTES.MD\n?? "core/\\303\\251.md"\n\n M src/x.js\n';
  assert.deepEqual(codeLines(out), ['100644 blob bb\tcore/main.js', ' M src/x.js']);
  assert.deepEqual(codeLines(''), []);
});

test('AT-13 comes from the smoke summary: every read refused or opaque and the tab still on the web page', () => {
  const detail = { mcp: 'refused: Failed to fetch', mcpNoCors: 'opaque', controlFile: 'refused: x', settings: 'refused: x', transcript: 'refused: x', navigated: 'https://example.com/' };
  const summary = (/** @type {object} */ d, result = 'pass') => ({ checks: [{ name: 'a tab loads', result: 'pass' }, { name: 'AT-13: a web page ...', result, detail: JSON.stringify(d) }] });
  const ok = at13FromSmoke(summary(detail));
  assert.equal(ok.pass, true);
  assert.equal(ok.attempts.length, 6);
  assert.ok(ok.attempts.every((a) => a.result === 'blocked'));
  const read = at13FromSmoke(summary({ ...detail, settings: 'read 200: <html>' }));
  assert.equal(read.pass, false);
  assert.equal(read.attempts.filter((a) => a.result === 'got through').length, 1);
  assert.equal(at13FromSmoke(summary({ ...detail, navigated: 'acc://settings/' })).pass, false);
  assert.equal(at13FromSmoke(summary({ mcp: 'refused' })).pass, false, 'missing tries fail');
  assert.equal(at13FromSmoke(summary(detail, 'fail')).pass, false);
  for (const s of [null, {}, { checks: 'x' }, { checks: [null, { name: 'other' }] }, { checks: [{ name: 'AT-13', result: 'pass', detail: 'nope' }] }]) {
    assert.equal(at13FromSmoke(s).pass, false);
  }
});

test('removeDir deletes links, never what they point at', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-abuse-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, 'precious');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  const dir = path.join(base, 'ws', 'at02');
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.symlinkSync(target, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(target, path.join(dir, 'nested', 'link2'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(dir, 'a.out'), 'x');
  removeDir(path.join(base, 'ws'));
  assert.equal(fs.existsSync(path.join(base, 'ws')), false);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  removeDir(path.join(base, 'missing'));
});

test('attempt keeps stdout, stderr and the exit code, with the redirection inside the parentheses', () => {
  assert.deepEqual(attempt('a1', 'more < "C:\\x"'), ['(more < "C:\\x") > a1.out 2> a1.err', 'echo %errorlevel%> a1.code']);
});

test('anonymize replaces the data folder, the scratch root, the profile, the user and the machine, either slash', () => {
  const home = os.homedir();
  const h = { data: path.join(home, 'AppData', 'Local', 'houston-core-abuse'), root: path.join(os.tmpdir(), 'scratch-root'), home };
  const user = os.userInfo().username;
  const s = anonymize(h, `${h.data}\\control.json ${h.root}/ws ${home.replaceAll('\\', '/')}/.ssh ${user.toUpperCase()}`);
  assert.equal(s.includes(user), false);
  assert.equal(s.toLowerCase().includes(user.toLowerCase()), false);
  assert.match(s, /<core-data>[\\/]control\.json <root>\/ws %USERPROFILE%\/\.ssh <user>/);
  assert.equal(firstLine('\r\n  Access is denied.\r\nmore'), 'Access is denied.');
});
