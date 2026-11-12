// The audit log: append-only JSON lines, each one hashed over the line before it.
// Event shape: core/schemas/audit-event.schema.json. Imports nothing from runner or gateway.
//
// Files are segments, audit-000001.jsonl and up. A segment is checked on its own: the first
// one starts at seq 0 with an all-zero prev_hash, and every later one starts with an
// `audit.break` event, because a new segment is only ever opened after a break.
//
// What the chain shows: a line that was edited, removed, added or reordered, and a missing
// segment. What it cannot show: lines cut off the end of the newest segment. Nothing kept on
// the same disk can, since whoever can cut the file can fix a marker beside it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = 'houston.audit/v0.1';
export const GENESIS = '0'.repeat(64);
/** The subject on events the Core writes about itself. */
export const CORE_SUBJECT = 'local:core';

const SEGMENT = /^audit-(\d{6})\.jsonl$/;
const DECISIONS = ['allow', 'ask', 'deny'];
/** @param {number} n */
const segmentName = (n) => `audit-${String(n).padStart(6, '0')}.jsonl`;
/** @param {{ segment: string, line: number }} b */
const breakKey = (b) => `${b.segment}:${b.line}`;

/**
 * JSON with object keys sorted at every level, so the same event always hashes the same.
 * @param {unknown} value
 */
export function canonical(value) {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
}

/**
 * SHA-256 over prev_hash and the event's canonical JSON without `audit.hash`.
 * @param {any} event
 * @returns {string} hex
 */
export function hashEvent(event) {
  const { hash: _, ...audit } = event.audit;
  return crypto.createHash('sha256').update(audit.prev_hash + canonical({ ...event, audit })).digest('hex');
}

/**
 * @typedef {{ segment: string, line: number, reason: string }} Break  `line` is 1-based; 0 means the whole file.
 * @typedef {{ seq: number, hash: string }} Link
 */

/**
 * Parse one line and check it against the line before. Throws with the reason.
 * @param {string} text
 * @param {Link | null} last
 * @param {boolean} first whether this is the first segment
 */
function checkLine(text, last, first) {
  let e;
  try { e = JSON.parse(text); } catch { throw new Error('the line is not JSON'); }
  const a = e?.audit;
  if (!a || !Number.isInteger(a.seq) || typeof a.prev_hash !== 'string' || typeof a.hash !== 'string') throw new Error('the line has no audit block');
  if (last) {
    if (a.seq !== last.seq + 1) throw new Error(`seq ${a.seq} follows seq ${last.seq}`);
    if (a.prev_hash !== last.hash) throw new Error('prev_hash does not match the line before');
  } else if (first) {
    if (a.seq !== 0 || a.prev_hash !== GENESIS) throw new Error('the log does not start at its first event');
  } else if (e.type !== 'audit.break') {
    throw new Error('the segment does not start with its audit.break event');
  }
  if (hashEvent(e) !== a.hash) throw new Error('the hash does not match the content');
  return e;
}

/**
 * Every event in a segment, in order, stopping at the first line that fails.
 * ponytail: reads the file whole; stream it when segments rotate by size (LOG-04's cap).
 * @param {string} file
 * @param {boolean} first
 * @returns {Generator<any, { last: Link | null, bad: { line: number, reason: string } | null }>}
 */
function* walk(file, first) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length && !first) return { last: null, bad: { line: 0, reason: 'the segment is empty' } };
  /** @type {Link | null} */
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = checkLine(lines[i], last, first); } catch (err) {
      return { last, bad: { line: i + 1, reason: /** @type {Error} */ (err).message } };
    }
    last = { seq: e.audit.seq, hash: e.audit.hash };
    yield e;
  }
  return { last, bad: null };
}

/** @param {string} dir @returns {number[]} segment numbers present, ascending */
function segments(dir) {
  return fs.readdirSync(dir).flatMap((f) => { const m = SEGMENT.exec(f); return m ? [Number(m[1])] : []; }).sort((a, b) => a - b);
}

/**
 * Check every segment in `dir`.
 * @param {string} dir
 * @returns {{ breaks: Break[], recorded: Set<string>, head: Link | null, tail: { n: number, intact: boolean } | null, events: number }}
 *   `recorded` holds the breaks an `audit.break` event already names; `head` is the newest good event; `tail` the newest segment.
 */
export function verifyDir(dir) {
  const have = segments(dir);
  /** @type {Break[]} */
  const breaks = [];
  const recorded = new Set();
  let head = null;
  let tail = null;
  let events = 0;
  for (let n = 1; n <= (have.at(-1) ?? 0); n++) {
    const segment = segmentName(n);
    if (!have.includes(n)) { breaks.push({ segment, line: 0, reason: 'the segment file is missing' }); continue; }
    const it = walk(path.join(dir, segment), n === 1);
    let step = it.next();
    for (; !step.done; step = it.next()) {
      events++;
      if (step.value.type === 'audit.break' && step.value.break) recorded.add(breakKey(step.value.break));
    }
    const { last, bad } = step.value;
    if (bad) breaks.push({ segment, ...bad });
    if (last && (!head || last.seq > head.seq)) head = last;
    tail = { n, intact: !bad };
  }
  return { breaks, recorded, head, tail, events };
}

/**
 * Fill in and check what a caller hands to `append`. Throws a TypeError on a bad event.
 * @param {any} e
 */
function shaped(e) {
  const str = (v) => typeof v === 'string' && v.length > 0;
  if (!e || typeof e !== 'object') throw new TypeError('an audit event is an object');
  if (!str(e.type) || !str(e.action)) throw new TypeError('an audit event needs a type and an action');
  if (!str(e.identity?.subject)) throw new TypeError('an audit event needs identity.subject');
  if (!str(e.resource?.type) || !str(e.resource?.id)) throw new TypeError('an audit event needs resource.type and resource.id');
  if (!DECISIONS.includes(e.decision?.result) || !str(e.decision?.policy_version)) throw new TypeError('an audit event needs decision.result (allow, ask or deny) and decision.policy_version');
  if (e.session_id != null && !str(e.session_id)) throw new TypeError('session_id is a string or null');
  const resource = typeof e.resource.args_preview === 'string' ? { ...e.resource, args_preview: e.resource.args_preview.slice(0, 500) } : e.resource;
  return { ...e, resource, session_id: e.session_id ?? null };
}

/**
 * Open the log in `dir`: check every segment, record any break not yet recorded, and get
 * ready to append. A break in the newest segment starts a new one; the broken file is
 * left exactly as it was found.
 *
 * Only one process may have a log open. The Core's database lock sees to that.
 *
 * @param {string} dir
 * @param {{ now?: () => string }} [opts]
 */
export function openAudit(dir, { now = () => new Date().toISOString() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const found = verifyDir(dir);
  const fresh = found.breaks.filter((b) => !found.recorded.has(breakKey(b)));
  const startNew = found.tail ? !found.tail.intact : false;
  const n = found.tail ? found.tail.n + (startNew ? 1 : 0) : 1;
  let last = found.head;
  const fd = fs.openSync(path.join(dir, segmentName(n)), 'a');

  /** @param {any} event */
  function write(event) {
    const full = { ...event, schema: SCHEMA, event_id: crypto.randomUUID(), time: now(), audit: { seq: last ? last.seq + 1 : 0, prev_hash: last ? last.hash : GENESIS } };
    full.audit.hash = hashEvent(full);
    // ponytail: one fsync per event; batch them if the gateway's call rate ever makes this the bottleneck.
    fs.writeSync(fd, JSON.stringify(full) + '\n');
    fs.fsyncSync(fd);
    last = { seq: full.audit.seq, hash: full.audit.hash };
    return full;
  }

  /**
   * An event the Core writes about itself (core.start, audit.break).
   * @param {string} type
   * @param {object} [extra]
   */
  const system = (type, extra) => write({
    type, identity: { subject: CORE_SUBJECT }, session_id: null, action: type,
    resource: { type: 'Core', id: 'core' }, decision: { result: 'allow', policy_version: 'none' }, ...extra,
  });

  // A new segment must open with the break that caused it, so that one goes first.
  if (startNew) fresh.sort((a, b) => Number(b.segment === segmentName(n - 1)) - Number(a.segment === segmentName(n - 1)));
  for (const b of fresh) system('audit.break', { resource: { type: 'AuditSegment', id: b.segment }, break: b });

  return {
    dir,
    /** Every break found at open, old and new. */
    breaks: found.breaks,
    /** The breaks first seen at this open. Each now has an `audit.break` event. */
    newBreaks: fresh,
    /**
     * Append one event. The log sets `schema`, `event_id`, `time` and `audit`.
     * @param {object} event the rest of an audit event; see the schema
     */
    append: (event) => write(shaped(event)),
    system,
    /** Check the files again, as they are on disk now. */
    verify: () => { const { breaks, events, head } = verifyDir(dir); return { breaks, events, head }; },
    /** Every good event, oldest first. A broken segment gives its events up to the break. */
    *events() {
      for (const s of segments(dir)) yield* walk(path.join(dir, segmentName(s)), s === 1);
    },
    /**
     * Write every good event to one JSON-lines file.
     * @param {string} dest
     * @returns {{ events: number, breaks: Break[] }} the breaks tell the reader what the export is missing
     */
    exportTo(dest) {
      const out = fs.openSync(dest, 'w');
      let count = 0;
      try { for (const e of this.events()) { fs.writeSync(out, JSON.stringify(e) + '\n'); count++; } } finally { fs.closeSync(out); }
      return { events: count, breaks: verifyDir(dir).breaks };
    },
    close: () => fs.closeSync(fd),
  };
}
