// The audit log: append-only JSON lines, each one hashed over the line before it.
// Event shape: core/schemas/audit-event.schema.json. Imports nothing from runner or gateway.
//
// Files are segments, audit-000001.jsonl and up. The first one starts at seq 0 with an all-zero
// prev_hash. A later one starts with an `audit.break` event when a break opened it, or with an
// `audit.segment` event when the one before grew past its size; that event chains on to the last
// event before it, which is checked whenever that segment is still there.
//
// Retention (LOG-04) deletes whole segments, oldest first, never the open one, each one a
// `log.deleted` event. Every such event and every `audit.segment` carries `pruned_through`, the
// highest segment number deleted on purpose so far, so missing segments up to it aren't breaks.
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
/** A segment past this many bytes is closed and the next one opened. */
export const SEGMENT_BYTES = 64 * 1024 ** 2;
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
 * @param {Link | null} prev the last event of the segment before, when it's there and intact
 */
function checkLine(text, last, first, prev) {
  let e;
  try { e = JSON.parse(text); } catch { throw new Error('the line is not JSON'); }
  const a = e?.audit;
  if (!a || !Number.isInteger(a.seq) || typeof a.prev_hash !== 'string' || typeof a.hash !== 'string') throw new Error('the line has no audit block');
  if (last) {
    if (a.seq !== last.seq + 1) throw new Error(`seq ${a.seq} follows seq ${last.seq}`);
    if (a.prev_hash !== last.hash) throw new Error('prev_hash does not match the line before');
  } else if (first) {
    if (a.seq !== 0 || a.prev_hash !== GENESIS) throw new Error('the log does not start at its first event');
  } else if (e.type === 'audit.segment') {
    if (prev && (a.seq !== prev.seq + 1 || a.prev_hash !== prev.hash)) throw new Error('the segment does not follow on from the one before');
  } else if (e.type !== 'audit.break') {
    throw new Error('the segment does not start with its audit.break or audit.segment event');
  }
  if (hashEvent(e) !== a.hash) throw new Error('the hash does not match the content');
  return e;
}

/**
 * Every event in a segment, in order, stopping at the first line that fails.
 * Reads the file whole: a segment rolls over at SEGMENT_BYTES.
 * @param {string} file
 * @param {boolean} first
 * @param {Link | null} [prev] see checkLine
 * @returns {Generator<any, { last: Link | null, bad: { line: number, reason: string } | null }>}
 */
function* walk(file, first, prev = null) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length && !first) return { last: null, bad: { line: 0, reason: 'the segment is empty' } };
  /** @type {Link | null} */
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = checkLine(lines[i], last, first, prev); } catch (err) {
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
 * @returns {{ breaks: Break[], recorded: Set<string>, head: Link | null, tail: { n: number, intact: boolean } | null, events: number, pruned: number }}
 *   `recorded` holds the breaks an `audit.break` event already names; `head` is the newest good event; `tail` the newest
 *   segment; `pruned` the highest segment number retention deleted (0 for none).
 */
export function verifyDir(dir) {
  const have = segments(dir);
  /** @type {(Break & { n: number })[]} */
  const found = [];
  const recorded = new Set();
  let head = null;
  let tail = null;
  let events = 0;
  let pruned = 0;
  /** @type {Link | null} */
  let prev = null;
  for (const n of have) {
    const segment = segmentName(n);
    const it = walk(path.join(dir, segment), n === 1, have.includes(n - 1) ? prev : null);
    let step = it.next();
    for (; !step.done; step = it.next()) {
      events++;
      const e = step.value;
      if (e.type === 'audit.break' && e.break) recorded.add(breakKey(e.break));
      if (Number.isInteger(e.pruned_through)) pruned = Math.max(pruned, e.pruned_through);
    }
    const { last, bad } = step.value;
    if (bad) found.push({ n, segment, ...bad });
    if (last && (!head || last.seq > head.seq)) head = last;
    prev = bad ? null : last;
    tail = { n, intact: !bad };
  }
  // A missing segment is a break unless retention says it deleted it.
  for (let n = pruned + 1; n < (have.at(-1) ?? 0); n++) if (!have.includes(n)) found.push({ n, segment: segmentName(n), line: 0, reason: 'the segment file is missing' });
  const breaks = found.sort((a, b) => a.n - b.n || a.line - b.line).map(({ n: _, ...b }) => b);
  return { breaks, recorded, head, tail, events, pruned };
}

/** The time of a segment's newest event, or '' when it can't be read. @param {string} file */
function newestTime(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd();
    return String(JSON.parse(text.slice(text.lastIndexOf('\n') + 1)).time ?? '');
  } catch { return ''; }
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
 * @param {{ now?: () => string, segmentBytes?: number }} [opts]
 */
export function openAudit(dir, { now = () => new Date().toISOString(), segmentBytes = SEGMENT_BYTES } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const found = verifyDir(dir);
  const fresh = found.breaks.filter((b) => !found.recorded.has(breakKey(b)));
  const startNew = found.tail ? !found.tail.intact : false;
  let n = found.tail ? found.tail.n + (startNew ? 1 : 0) : 1;
  let last = found.head;
  let pruned = found.pruned;
  let fd = fs.openSync(path.join(dir, segmentName(n)), 'a');
  let size = fs.fstatSync(fd).size;

  /** @param {any} event */
  function put(event) {
    const full = { ...event, schema: SCHEMA, event_id: crypto.randomUUID(), time: now(), audit: { seq: last ? last.seq + 1 : 0, prev_hash: last ? last.hash : GENESIS } };
    full.audit.hash = hashEvent(full);
    const line = JSON.stringify(full) + '\n';
    // ponytail: one fsync per event; batch them if the gateway's call rate ever makes this the bottleneck.
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
    size += Buffer.byteLength(line);
    last = { seq: full.audit.seq, hash: full.audit.hash };
    return full;
  }

  /**
   * An event the Core writes about itself (core.start, audit.break).
   * @param {string} type
   * @param {object} [extra]
   */
  const systemEvent = (type, extra) => ({
    type, identity: { subject: CORE_SUBJECT }, session_id: null, action: type,
    resource: { type: 'Core', id: 'core' }, decision: { result: 'allow', policy_version: 'none' }, ...extra,
  });

  /** Append, first moving to a new segment when this one is full. @param {any} event */
  function write(event) {
    if (size >= segmentBytes) {
      fs.closeSync(fd);
      n++;
      fd = fs.openSync(path.join(dir, segmentName(n)), 'a');
      size = 0;
      put(systemEvent('audit.segment', { resource: { type: 'AuditSegment', id: segmentName(n) }, pruned_through: pruned }));
    }
    return put(event);
  }
  /** @param {string} type @param {object} [extra] */
  const system = (type, extra) => write(systemEvent(type, extra));
  const bytes = () => segments(dir).reduce((sum, s) => sum + (fs.statSync(path.join(dir, segmentName(s)), { throwIfNoEntry: false })?.size ?? 0), 0);

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
    /** Bytes in every segment. */
    bytes,
    /**
     * Delete whole segments, oldest first, never the open one: while the log is over `bytes`, and
     * only those whose newest event is older than `before`. The file goes first, then a
     * `log.deleted` event naming it, so a crash in between shows as a break, not as nothing.
     * @param {{ bytes?: number, before?: string, by?: string, reason?: string }} p by: who asked (local:core for the cap)
     * @returns {string[]} the segments deleted
     */
    prune({ bytes: keep, before, by = CORE_SUBJECT, reason = 'retention' } = {}) {
      /** @type {string[]} */
      const gone = [];
      let total = bytes();
      for (const s of segments(dir).filter((x) => x < n)) {
        const file = path.join(dir, segmentName(s));
        if (keep !== undefined && total <= keep) break;
        if (before !== undefined) { const t = newestTime(file); if (!t || t >= before) break; }
        const size = fs.statSync(file).size;
        fs.rmSync(file);
        total -= size;
        pruned = Math.max(pruned, s);
        gone.push(segmentName(s));
        write({
          type: 'log.deleted', action: 'audit.prune', identity: { subject: by }, session_id: null, resource: { type: 'AuditSegment', id: segmentName(s) },
          decision: { result: 'allow', policy_version: 'none', reasons: [reason] }, pruned_through: pruned,
        });
      }
      return gone;
    },
    /** Every good event, oldest first. A broken segment gives its events up to the break. */
    *events() {
      for (const s of segments(dir)) yield* walk(path.join(dir, segmentName(s)), s === 1);
    },
    /**
     * Write every good event to one JSON-lines file, from `since` on when it's given.
     * @param {string} dest
     * @param {{ since?: string }} [opts] an ISO time
     * @returns {{ events: number, breaks: Break[], pruned: number }} the breaks and pruned segments tell the reader what the export is missing
     */
    exportTo(dest, { since } = {}) {
      const out = fs.openSync(dest, 'w');
      let count = 0;
      try {
        for (const e of this.events()) {
          if (since && !(e.time >= since)) continue;
          fs.writeSync(out, JSON.stringify(e) + '\n');
          count++;
        }
      } finally { fs.closeSync(out); }
      const { breaks, pruned } = verifyDir(dir);
      return { events: count, breaks, pruned };
    },
    close: () => fs.closeSync(fd),
  };
}
