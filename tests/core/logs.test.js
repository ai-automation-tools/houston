import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { exportLogs, retainLogs } from '../../core/logs.js';
import { createTranscripts } from '../../core/transcripts.js';

function setup(t, capBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-logs-'));
  const audit = openAudit(path.join(dir, 'audit'), { segmentBytes: 1500 });
  t.after(() => { audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const tdir = path.join(dir, 'transcripts');
  const transcripts = createTranscripts({ dir: tdir, audit, capBytes, reserve: () => audit.bytes() });
  return { dir, tdir, audit, transcripts };
}

const event = (n) => ({
  type: 'mcp.tool_call', identity: { subject: 'local:dev' }, session_id: 's1', action: 'tool.call',
  resource: { type: 'Tool', id: `t-${n}` }, decision: { result: 'allow', policy_version: 'p1' },
});

test('retainLogs: transcripts go first, and the audit log is pruned only when they are not enough', (t) => {
  const s = setup(t, 6000);
  for (let i = 0; i < 6; i++) s.audit.append(event(i));
  for (const id of ['a', 'b']) fs.writeFileSync(path.join(s.tdir, `${id}.txt`), 'x'.repeat(1000));
  // Under the cap: nothing goes.
  assert.deepEqual(retainLogs(s), []);
  assert.equal(fs.readdirSync(s.tdir).length, 2);
  // Audit grows past what the cap leaves: transcripts go, then the oldest audit segments.
  for (let i = 0; i < 40; i++) s.audit.append(event(i));
  const grown = s.audit.bytes();
  const pruned = retainLogs(s);
  assert.deepEqual(fs.readdirSync(s.tdir), []);
  assert.ok(pruned.length > 0 && pruned[0] === 'audit-000001.jsonl', pruned.join());
  // Its own log.deleted events fill these tiny test segments too; at 64 MB they don't count.
  assert.ok(s.audit.bytes() < grown);
  assert.deepEqual(s.audit.verify().breaks, []);
});

test('exportLogs writes the audit log, the transcripts and a manifest into a new exports folder', (t) => {
  const s = setup(t, 1e9);
  for (let i = 0; i < 3; i++) s.audit.append(event(i));
  fs.writeFileSync(path.join(s.tdir, 'a.txt'), 'hello\n');
  const r = exportLogs(s, { now: new Date('2026-11-27T10:00:00.000Z') });
  assert.equal(r.folder, path.join(s.dir, 'exports', 'logs-2026-11-27T10-00-00-000Z'));
  assert.deepEqual([r.events, r.transcripts, r.breaks, r.prunedThrough, r.since], [3, 1, [], 0, null]);
  assert.equal(fs.readFileSync(path.join(r.folder, 'audit.jsonl'), 'utf8').trimEnd().split('\n').length, 3);
  assert.equal(fs.readFileSync(path.join(r.folder, 'transcripts', 'a.txt'), 'utf8'), 'hello\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.folder, 'manifest.json'), 'utf8')).events, 3);
});
