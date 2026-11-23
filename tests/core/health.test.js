import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { MAX_LOG_LINES, coreHealth, folderBytes, tailLines } from '../../core/health.js';

/** @param {any} t */
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('folderBytes sums files at every depth, and a missing folder is 0', (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'x'), '12345');
  fs.writeFileSync(path.join(dir, 'a', 'b', 'y'), '123');
  assert.equal(folderBytes(dir), 8);
  assert.equal(folderBytes(path.join(dir, 'nope')), 0);
});

test('tailLines: the newest lines, no fragment from a cut read, nothing for a missing file', (t) => {
  const dir = scratch(t);
  const f = path.join(dir, 'log');
  fs.writeFileSync(f, 'one\r\ntwo\nthree\n');
  assert.deepEqual(tailLines(f, 2), ['two', 'three']);
  assert.deepEqual(tailLines(f, 10), ['one', 'two', 'three']);
  assert.deepEqual(tailLines(f, 0), []);
  assert.deepEqual(tailLines(path.join(dir, 'nope'), 5), []);
  // Over the 256 KB read: the first, cut line is dropped.
  fs.writeFileSync(f, `${'x'.repeat(300 * 1024)}\nlast\n`);
  assert.deepEqual(tailLines(f, 5), ['last']);
});

test('coreHealth: the chain checked now, the folder sizes, and core.log redacted and capped', (t) => {
  const dir = scratch(t);
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => audit.close());
  audit.system('core.start');
  fs.mkdirSync(path.join(dir, 'transcripts'));
  fs.writeFileSync(path.join(dir, 'transcripts', 's1.txt'), 'abc');
  fs.writeFileSync(path.join(dir, 'core.log'), Array.from({ length: 300 }, (_, i) => `line ${i} made-up-secret-value`).join('\n'));
  const redact = (/** @type {string} */ s) => s.replaceAll('made-up-secret-value', '[REDACTED:secret:x]');

  const h = coreHealth({ dir, audit, redact }, { log: 5 });
  assert.deepEqual(h.audit, { events: 1, breaks: 0, firstBreak: null });
  assert.equal(h.storage.transcripts, 3);
  assert.equal(h.storage.backups, 0);
  assert.ok(h.storage.audit > 0);
  assert.equal(h.storage.total, folderBytes(dir));
  assert.deepEqual(h.log, ['line 295 [REDACTED:secret:x]', 'line 296 [REDACTED:secret:x]', 'line 297 [REDACTED:secret:x]', 'line 298 [REDACTED:secret:x]', 'line 299 [REDACTED:secret:x]']);
  assert.deepEqual(coreHealth({ dir, audit }).log, []);
  assert.equal(coreHealth({ dir, audit }, { log: 10_000 }).log.length, MAX_LOG_LINES);
  for (const bad of [-1, '5', 2.5, null]) assert.deepEqual(coreHealth({ dir, audit }, { log: bad }).log, []);

  // An edited line is a break, counted and named.
  const seg = path.join(dir, 'audit', 'audit-000001.jsonl');
  fs.writeFileSync(seg, fs.readFileSync(seg, 'utf8').replace('core.start', 'core.stopp'));
  const broken = coreHealth({ dir, audit });
  assert.equal(broken.audit.breaks, 1);
  assert.equal(broken.audit.firstBreak?.segment, 'audit-000001.jsonl');
});
