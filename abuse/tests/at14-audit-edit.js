// AT-14: one audit line is edited by hand, then the Core restarts. Pass: the Core reports the
// break on start, an audit.break event names the segment and line, and logging goes on.
import fs from 'node:fs';
import path from 'node:path';

export const id = 'AT-14';
export const title = 'One audit line is edited by hand, then the Core restarts';

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  await h.killCore();
  const dir = path.join(h.data, 'audit');
  const segment = fs.readdirSync(dir).filter((f) => /^audit-\d+\.jsonl$/.test(f)).sort().at(-1) ?? '';
  const file = path.join(dir, segment);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // The last session.start the log allowed: rewrite it as a deny, as someone covering tracks might.
  const n = lines.findLastIndex((l) => l.includes('"type":"session.start"') && l.includes('"result":"allow"'));
  lines[n] = lines[n].replace('"result":"allow"', '"result":"deny"');
  fs.writeFileSync(file, lines.join('\n'));

  const core = await h.startCore();
  const reported = core.stderr().includes('audit chain break') || core.started.auditBreaks > 0;
  const breaks = (await h.call('audit.query', { type: 'audit.break' })).events;
  const named = breaks.find((e) => e.break?.segment === segment && e.break?.line === n + 1);
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [
    { name: `edit line ${n + 1} of ${segment} (allow -> deny), then restart`, result: reported && named ? 'blocked' : 'got through', evidence: named ? `audit.break: ${named.break.segment} line ${named.break.line}: ${named.break.reason}` : `not reported (${breaks.length} audit.break events)` },
  ];
  return { id, title, attempts, notes: [`The Core reported the break on start: ${reported}. Logging went on: the audit.break event is itself a new entry, in a new segment.`], pass: reported && !!named };
}
