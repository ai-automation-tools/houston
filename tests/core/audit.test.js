import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS, SCHEMA, canonical, hashEvent, openAudit, verifyDir } from '../../core/audit.js';
import { start } from '../../core/main.js';

/** @param {import('node:test').TestContext} t */
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const event = (n = 0, extra = {}) => ({
  type: 'mcp.tool_call', identity: { subject: 'local:dev-codex', containment: 'container' }, session_id: 's1', action: 'tool.call',
  resource: { type: 'Tool', id: `github/tool-${n}` }, decision: { result: 'deny', policy_version: 'p1' }, ...extra,
});

/** A log with `count` events in it, closed. */
function filled(dir, count = 4) {
  const log = openAudit(dir);
  for (let i = 0; i < count; i++) log.append(event(i));
  log.close();
}

const seg = (dir, n = 1) => path.join(dir, `audit-00000${n}.jsonl`);
const readLines = (file) => fs.readFileSync(file, 'utf8').trimEnd().split('\n');
const writeLines = (file, lines) => fs.writeFileSync(file, lines.join('\n') + '\n');

test('canonical sorts keys at every level and leaves arrays in order', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
  const e = { type: 'x', z: 1, audit: { seq: 0, prev_hash: GENESIS, hash: 'ignored' } };
  assert.equal(hashEvent(e), hashEvent({ audit: { hash: 'other', prev_hash: GENESIS, seq: 0 }, z: 1, type: 'x' }));
  assert.notEqual(hashEvent(e), hashEvent({ ...e, z: 2 }));
});

test('append chains each event to the one before, and a reopened log carries on', (t) => {
  const dir = tmp(t);
  const log = openAudit(dir, { now: () => '2026-01-01T00:00:00.000Z' });
  const a = log.append(event(0));
  const b = log.append(event(1));
  assert.equal(a.schema, SCHEMA);
  assert.equal(a.time, '2026-01-01T00:00:00.000Z');
  assert.deepEqual([a.audit.seq, a.audit.prev_hash], [0, GENESIS]);
  assert.deepEqual([b.audit.seq, b.audit.prev_hash], [1, a.audit.hash]);
  assert.notEqual(a.event_id, b.event_id);
  log.close();

  const again = openAudit(dir);
  assert.deepEqual(again.breaks, []);
  const c = again.append(event(2));
  assert.deepEqual([c.audit.seq, c.audit.prev_hash], [2, b.audit.hash]);
  assert.deepEqual(again.verify(), { breaks: [], events: 3, head: { seq: 2, hash: c.audit.hash } });
  assert.deepEqual(fs.readdirSync(dir), ['audit-000001.jsonl']);
  again.close();
});

test('append refuses a malformed event and never lets the caller set the chain fields', (t) => {
  const log = openAudit(tmp(t));
  t.after(() => log.close());
  for (const bad of [null, 'x', {}, event(0, { identity: {} }), event(0, { resource: { type: 'Tool' } }),
    event(0, { decision: { result: 'maybe', policy_version: 'p' } }), event(0, { decision: { result: 'allow' } }), event(0, { session_id: 7 })]) {
    assert.throws(() => log.append(bad), TypeError);
  }
  const e = log.append(event(0, { session_id: undefined, event_id: 'mine', time: 'never', schema: 'x', audit: { seq: 99 }, resource: { type: 'Tool', id: 't', args_preview: 'x'.repeat(900) } }));
  assert.equal(e.audit.seq, 0);
  assert.equal(e.session_id, null);
  assert.notEqual(e.event_id, 'mine');
  assert.notEqual(e.time, 'never');
  assert.equal(e.schema, SCHEMA);
  assert.equal(e.resource.args_preview.length, 500);
  assert.equal(log.verify().events, 1);
});

test('AT-14: a line edited by hand is reported at the next open, and logging goes on in a new segment', (t) => {
  const dir = tmp(t);
  filled(dir);
  const lines = readLines(seg(dir));
  lines[2] = lines[2].replace('"deny"', '"allow"');
  writeLines(seg(dir), lines);
  const tampered = fs.readFileSync(seg(dir));

  const log = openAudit(dir);
  assert.deepEqual(log.newBreaks, [{ segment: 'audit-000001.jsonl', line: 3, reason: 'the hash does not match the content' }]);
  assert.deepEqual(fs.readFileSync(seg(dir)), tampered);
  const next = log.append(event(9));
  log.close();

  // The new segment opens with the break event, chained from the last good line of the old one.
  const second = readLines(seg(dir, 2)).map((l) => JSON.parse(l));
  assert.equal(second[0].type, 'audit.break');
  assert.deepEqual(second[0].break, log.newBreaks[0]);
  assert.deepEqual([second[0].audit.seq, second[0].audit.prev_hash], [2, JSON.parse(lines[1]).audit.hash]);
  assert.equal(second[1].event_id, next.event_id);

  // A later open still lists the break, but does not record it twice or start a third segment.
  const later = openAudit(dir);
  assert.equal(later.breaks.length, 1);
  assert.deepEqual(later.newBreaks, []);
  later.close();
  assert.deepEqual(fs.readdirSync(dir), ['audit-000001.jsonl', 'audit-000002.jsonl']);
});

test('a removed, added, reordered or garbled line breaks the chain where it happens', (t) => {
  const cases = {
    removed: (l) => l.toSpliced(1, 1),
    reordered: (l) => [l[0], l[2], l[1], l[3]],
    'first line removed': (l) => l.slice(1),
    garbled: (l) => [l[0], 'not json', ...l.slice(1)],
    'no audit block': (l) => [l[0], '{"type":"x"}'],
    'copied line': (l) => [l[0], l[1], l[1]],
  };
  const want = { removed: [2, /seq 2 follows seq 0/], reordered: [2, /seq 2 follows seq 0/], 'first line removed': [1, /does not start at its first event/],
    garbled: [2, /not JSON/], 'no audit block': [2, /no audit block/], 'copied line': [3, /seq 1 follows seq 1/] };
  for (const [name, change] of Object.entries(cases)) {
    const dir = tmp(t);
    filled(dir);
    writeLines(seg(dir), change(readLines(seg(dir))));
    const [b] = verifyDir(dir).breaks;
    assert.equal(b.line, want[name][0], name);
    assert.match(b.reason, want[name][1], name);
  }
});

test('an injected line with a valid hash of its own still fails on prev_hash', (t) => {
  const dir = tmp(t);
  filled(dir, 2);
  const lines = readLines(seg(dir));
  const forged = { ...JSON.parse(lines[1]), audit: { seq: 1, prev_hash: 'f'.repeat(64) } };
  forged.audit.hash = hashEvent(forged);
  writeLines(seg(dir), [lines[0], JSON.stringify(forged)]);
  assert.match(verifyDir(dir).breaks[0].reason, /prev_hash/);
});

test('tampering with an old segment later is recorded once, in the current segment', (t) => {
  const dir = tmp(t);
  filled(dir);
  const lines = readLines(seg(dir));
  writeLines(seg(dir), [...lines.slice(0, 3), 'x']);
  openAudit(dir).close();
  writeLines(seg(dir), [lines[0], 'x']);

  const log = openAudit(dir);
  assert.deepEqual(log.newBreaks.map((b) => b.line), [2]);
  log.close();
  assert.deepEqual(readLines(seg(dir, 2)).map((l) => JSON.parse(l).break.line), [4, 2]);
  const again = openAudit(dir);
  assert.deepEqual(again.newBreaks, []);
  again.close();
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('a missing or emptied segment is a break', (t) => {
  const dir = tmp(t);
  filled(dir);
  writeLines(seg(dir), ['x']);
  openAudit(dir).close();
  fs.rmSync(seg(dir));
  assert.deepEqual(verifyDir(dir).breaks, [{ segment: 'audit-000001.jsonl', line: 0, reason: 'the segment file is missing' }]);
  fs.writeFileSync(seg(dir, 2), '');
  const log = openAudit(dir);
  assert.deepEqual(log.newBreaks.map((b) => [b.segment, b.reason]), [['audit-000002.jsonl', 'the segment is empty'], ['audit-000001.jsonl', 'the segment file is missing']]);
  log.close();
  assert.equal(JSON.parse(readLines(seg(dir, 3))[0]).break.segment, 'audit-000002.jsonl');
});

test('exportTo writes every good event in order and says what is missing', (t) => {
  const dir = tmp(t);
  filled(dir);
  const lines = readLines(seg(dir));
  writeLines(seg(dir), [...lines.slice(0, 3), 'x']);
  const log = openAudit(dir);
  log.append(event(9));
  const dest = path.join(tmp(t), 'export.jsonl');
  const result = log.exportTo(dest);
  log.close();
  const out = readLines(dest).map((l) => JSON.parse(l));
  assert.equal(result.events, 5);
  assert.equal(result.breaks.length, 1);
  assert.deepEqual(out.map((e) => e.audit.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(out.map((e) => e.type), ['mcp.tool_call', 'mcp.tool_call', 'mcp.tool_call', 'audit.break', 'mcp.tool_call']);
});

test('the Core writes core.start and core.stop, and reports a break it finds at start', (t) => {
  const dir = tmp(t);
  start(dir).close();
  const file = seg(path.join(dir, 'audit'));
  assert.deepEqual(readLines(file).map((l) => JSON.parse(l).type), ['core.start', 'core.stop']);
  writeLines(file, readLines(file).map((l) => l.replace('core.stop', 'core.nap')));
  const core = start(dir);
  assert.deepEqual(core.audit.newBreaks.map((b) => b.line), [2]);
  core.close();
  assert.deepEqual(readLines(seg(path.join(dir, 'audit'), 2)).map((l) => JSON.parse(l).type), ['audit.break', 'core.start', 'core.stop']);
});
