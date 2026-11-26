import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { createTranscripts, plainLines, redact } from '../../core/transcripts.js';

function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-transcripts-'));
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const tdir = path.join(dir, 'transcripts');
  const transcripts = createTranscripts({ dir: tdir, audit, ...opts });
  return { transcripts, tdir, audit, events: () => [...audit.events()] };
}

const session = (id) => ({ id, identity: 'local:dev', workspace: 'D:/w', startedAt: '2026-11-12T00:00:00.000Z' });

test('redact replaces well-known key shapes and NAME=value secrets with a marker', () => {
  const cases = [
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'key [REDACTED:anthropic-key]'],
    ['sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', '[REDACTED:openai-key]'],
    [`push with ghp_${'a'.repeat(36)} now`, 'push with [REDACTED:github-token] now'],
    [`github_pat_${'A1_'.repeat(20)}`, '[REDACTED:github-token]'],
    ['xoxb-1234567890-abcdef', '[REDACTED:slack-token]'],
    ['AKIAABCDEFGHIJKLMNOP', '[REDACTED:aws-key]'],
    [`AIza${'x'.repeat(35)}`, '[REDACTED:google-key]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[REDACTED:jwt]'],
    ['Authorization: Bearer abcdefghijklmnop1234', 'Authorization: Bearer [REDACTED:credential]'],
    ['DB_PASSWORD=hunter22 next', 'DB_PASSWORD=[REDACTED:secret] next'],
    ['"api_key": "abcdef123456"', '"api_key": "[REDACTED:secret]"'],
    // A known shape keeps its kind, not the generic one.
    ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'ANTHROPIC_API_KEY=[REDACTED:anthropic-key]'],
  ];
  for (const [input, want] of cases) assert.equal(redact(input), want, input);
  // Ordinary text is left alone.
  for (const s of ['npm install left-pad', 'TOKEN=abc', 'see the key below', 'C:\\Users\\me\\keys\\README.md']) assert.equal(redact(s), s);
});

test('plainLines resolves the escape sequences a terminal writes into text', () => {
  assert.deepEqual(plainLines('\x1b[32mgreen\x1b[0m text\r\n\x1b]0;title\x07next\n'), ['green text', 'next']);
  // A redraw: back to column 1, erase, retype.
  assert.deepEqual(plainLines('abc\r\x1b[Kxyz\n'), ['xyz']);
});

test('a transcript is redacted before write, even a secret split across chunks or a key block across lines', (t) => {
  const s = setup(t);
  const w = s.transcripts.open(session('s1'));
  w.write('echo sk-ant-api03-abcdefg');
  w.write('hijklmnopqrstuvwxyz0123\r\n');
  w.write('-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAA\r\n');
  w.write('AAAABG5vbmUAAAAEbm9uZQ\r\n-----END OPENSSH PRIVATE KEY-----\r\nafter\r\n');
  w.write('no line end yet');
  w.close('stopped');
  const text = fs.readFileSync(path.join(s.tdir, 's1.txt'), 'utf8');
  assert.equal(text, [
    '# session s1 · local:dev · D:/w · started 2026-11-12T00:00:00.000Z',
    'echo [REDACTED:anthropic-key]', '[REDACTED:private-key]', 'after', 'no line end yet', '# ended: stopped', '',
  ].join('\n'));
  assert.ok(!/sk-ant|b3Blbn|AAAABG/.test(text));
  assert.equal(s.transcripts.read('s1').text, text);
});

test('one transcript stops at its cap and says so; the session itself is not touched', (t) => {
  const s = setup(t, { sessionCapBytes: 200 });
  const w = s.transcripts.open(session('s1'));
  for (let i = 0; i < 20; i++) w.write(`line ${i} ${'x'.repeat(20)}\n`);
  w.close('stopped');
  const text = fs.readFileSync(path.join(s.tdir, 's1.txt'), 'utf8');
  assert.match(text, /\[transcript stopped at its 200 byte cap; the session ran on\]\n$/);
  assert.ok(Buffer.byteLength(text) < 300);
});

test('over the folder cap, the oldest finished transcripts go first, each audited; a running one stays', (t) => {
  const s = setup(t, { capBytes: 1000 });
  const running = s.transcripts.open(session('live'));
  for (const [i, id] of ['old', 'mid', 'new'].entries()) {
    fs.writeFileSync(path.join(s.tdir, `${id}.txt`), 'y'.repeat(400));
    const at = new Date(Date.now() - (10 - i) * 60_000);
    fs.utimesSync(path.join(s.tdir, `${id}.txt`), at, at);
  }
  const live = path.join(s.tdir, 'live.txt');
  fs.utimesSync(live, new Date(0), new Date(0));
  s.transcripts.rotate();
  assert.deepEqual(fs.readdirSync(s.tdir).sort(), ['live.txt', 'mid.txt', 'new.txt']);
  const deleted = s.events().filter((e) => e.type === 'log.deleted');
  assert.deepEqual(deleted.map((e) => [e.resource.type, e.resource.id, e.identity.subject]), [['Transcript', 'old', 'local:core']]);
  running.close();
});

test('read gives the newest part from a whole line, and nothing for an unknown or unsafe id', (t) => {
  const s = setup(t);
  assert.equal(s.transcripts.read('nope'), null);
  assert.equal(s.transcripts.read('../audit/x'), null);
  assert.throws(() => s.transcripts.open(session('../x')), /letters, digits and dashes/);
  fs.writeFileSync(path.join(s.tdir, 'big.txt'), `first\n${'z'.repeat(1024 * 1024)}\nlast\n`);
  const r = s.transcripts.read('big');
  assert.equal(r.truncated, true);
  assert.equal(r.text, 'last\n');
});

test('past their age, finished transcripts are deleted at start and at each rotate, each audited; a running one stays', (t) => {
  const s = setup(t, { maxAgeDays: 30 });
  const running = s.transcripts.open(session('live'));
  const day = 24 * 60 * 60 * 1000;
  for (const [id, age] of [['stale', 31], ['fresh', 29]]) {
    fs.writeFileSync(path.join(s.tdir, `${id}.txt`), 'x');
    const at = new Date(Date.now() - age * day);
    fs.utimesSync(path.join(s.tdir, `${id}.txt`), at, at);
  }
  fs.utimesSync(path.join(s.tdir, 'live.txt'), new Date(0), new Date(0));
  s.transcripts.rotate();
  assert.deepEqual(fs.readdirSync(s.tdir).sort(), ['fresh.txt', 'live.txt']);
  const deleted = s.events().filter((e) => e.type === 'log.deleted');
  assert.deepEqual(deleted.map((e) => [e.action, e.resource.id, e.decision.reasons[0]]), [['transcript.expire', 'stale', 'older than 30 days']]);
  running.close();
  assert.equal(s.transcripts.maxAgeDays, 30);
  assert.equal(setup(t).transcripts.maxAgeDays, 90);
});

test('remove deletes a finished transcript as the operator, never a running one or a path', (t) => {
  const s = setup(t);
  const running = s.transcripts.open(session('live'));
  s.transcripts.open(session('done')).close('exit 0');
  assert.equal(s.transcripts.remove('live', 'local:operator'), 'running');
  assert.equal(s.transcripts.remove('nope', 'local:operator'), 'missing');
  assert.equal(s.transcripts.remove('../audit/audit-000001', 'local:operator'), 'missing');
  assert.equal(s.transcripts.remove('done', 'local:operator'), 'deleted');
  assert.equal(s.transcripts.read('done'), null);
  assert.ok(fs.existsSync(path.join(s.tdir, 'live.txt')));
  const deleted = s.events().filter((e) => e.type === 'log.deleted');
  assert.deepEqual(deleted.map((e) => [e.action, e.identity.subject, e.resource.id]), [['transcript.delete', 'local:operator', 'done']]);
  running.close();
});
