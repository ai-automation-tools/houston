// Session transcripts (CORE-19, LOG-01, LOG-04): what each contained session's terminal showed,
// as plain text, with secrets replaced by a marker before anything reaches the disk. One file per
// session in <data>/transcripts, inside the data folder only the operator can read. Two caps: one
// transcript stops growing at sessionCapBytes, and transcripts plus the audit log (`reserve`) are
// kept under capBytes by deleting the oldest finished transcripts first (each one a `log.deleted`
// audit event). The audit log is never rotated here: retainLogs prunes it after these (LOG-04).

import fs from 'node:fs';
import path from 'node:path';

/** One cap for transcripts and the audit log together (harness-requirements.md, Logs). */
export const LOG_CAP = 5 * 1024 ** 3;
export const SESSION_CAP = 100 * 1024 ** 2;
// Text with no line end yet is held back, so a secret split across two chunks is redacted
// whole. Past this much, it's written anyway.
const HOLD_MAX = 16 * 1024;
const OPERATOR_TAIL = 1024 * 1024;

/** @type {[string, RegExp, (m: string, ...g: string[]) => string][]} */
const SECRETS = [
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g, () => '[REDACTED:anthropic-key]'],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, () => '[REDACTED:openai-key]'],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, () => '[REDACTED:github-token]'],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => '[REDACTED:slack-token]'],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => '[REDACTED:aws-key]'],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}/g, () => '[REDACTED:google-key]'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => '[REDACTED:jwt]'],
  ['auth-header', /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, (_m, scheme) => `${scheme} [REDACTED:credential]`],
  // NAME=value and NAME: value where the name says it's a secret; the name stays readable.
  ['named-secret', /\b([A-Za-z_][A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?))(["']?\s*[=:]\s*["']?)(?!\[REDACTED)[^\s"',;]{6,}/gi, (_m, name, sep) => `${name}${sep}[REDACTED:secret]`],
];
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * One line with every secret it holds replaced by a marker.
 * ponytail: patterns for well-known key formats and NAME=value; a secret with no telltale shape
 * gets through by shape; `exact` (the vault's redact) replaces every stored vault value too.
 * @param {string} line
 */
export function redact(line) {
  let out = line;
  for (const [, re, to] of SECRETS) out = out.replace(re, /** @type {any} */ (to));
  return out;
}

// The same one-line cell model as src/shared/output.js cleanOutput (the Core imports nothing
// from the window): the escape sequences ConPTY writes resolved into plain text.
const TOKEN = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|\r|\n|[^\x1b\r\n]+/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** @param {string} raw terminal output that ends at a line end @returns {string[]} its lines as plain text */
export function plainLines(raw) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  let cur = [];
  let col = 0;
  for (const m of raw.matchAll(TOKEN)) {
    const t = m[0];
    if (m[2] !== undefined) {
      const n = m[1].split(';').map((p) => Number(p) || 0);
      if (m[2] === 'H' || m[2] === 'f') col = Math.max(0, (n[1] || 1) - 1);
      else if (m[2] === 'G') col = Math.max(0, (n[0] || 1) - 1);
      else if (m[2] === 'C') col += n[0] || 1;
      else if (m[2] === 'D') col = Math.max(0, col - (n[0] || 1));
      else if (m[2] === 'K') {
        if (n[0] === 2) cur = [];
        else if (n[0] === 1) cur.fill(' ', 0, Math.min(col, cur.length));
        else cur.length = Math.min(cur.length, col);
      }
    } else if (t === '\r') col = 0;
    else if (t === '\n') { lines.push(cur.join('').trimEnd()); cur = []; col = 0; }
    else if (t[0] !== '\x1b') {
      for (const ch of t.replace(CONTROL, '')) {
        while (cur.length < col) cur.push(' ');
        cur[col++] = ch;
      }
    }
  }
  if (cur.length) lines.push(cur.join('').trimEnd());
  return lines;
}

/** A session id as a file name: what the runner makes (a UUID), nothing that walks out of the folder. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * @param {{
 *   dir: string,
 *   audit: { append: (e: object) => unknown },
 *   capBytes?: number,
 *   sessionCapBytes?: number,
 *   exact?: (line: string) => string,
 *   reserve?: () => number,
 * }} opts
 *   exact: the vault's redaction of its own stored values (vault.js), run after the shapes
 *   reserve: bytes the rest of the logs hold under the same cap (the audit log's)
 */
export function createTranscripts({ dir, audit, capBytes = LOG_CAP, sessionCapBytes = SESSION_CAP, exact = (l) => l, reserve = () => 0 }) {
  fs.mkdirSync(dir, { recursive: true });
  /** Sessions being written now: never rotated out. @type {Set<string>} */
  const open = new Set();
  const file = (/** @type {string} */ id) => path.join(dir, `${id}.txt`);
  /** Every transcript, oldest first. */
  const list = () => fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).flatMap((f) => {
    const st = fs.statSync(path.join(dir, f), { throwIfNoEntry: false });
    return st ? [{ id: f.slice(0, -4), size: st.size, mtime: st.mtimeMs }] : [];
  }).sort((a, b) => a.mtime - b.mtime);

  /** @param {string} id @param {string} action @param {string} by @param {string} reason */
  function remove(id, action, by, reason) {
    fs.rmSync(file(id), { force: true });
    audit.append({
      type: 'log.deleted', action, identity: { subject: by }, session_id: id,
      resource: { type: 'Transcript', id }, decision: { result: 'allow', policy_version: 'none', reasons: [reason] },
    });
  }

  /** Delete the oldest finished transcripts until they and the rest of the logs are under the cap. */
  function rotate() {
    const files = list();
    const limit = capBytes - reserve();
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= limit) break;
      if (open.has(f.id)) continue;
      remove(f.id, 'transcript.rotate', 'local:core', `logs over their ${capBytes} byte cap; oldest transcripts first`);
      total -= f.size;
    }
  }
  rotate();

  return {
    capBytes,
    sessionCapBytes,
    rotate,
    /** Bytes in every transcript. */
    bytes: () => list().reduce((n, f) => n + f.size, 0),

    /**
     * The operator deletes finished transcripts: one by session id, or every one last written before
     * a time. A running session's transcript stays. Each is a `log.deleted` event.
     * @param {{ id?: string, before?: string, by: string }} p
     * @returns {string[]} the session ids whose transcripts went
     */
    delete({ id, before, by }) {
      if (id !== undefined && !ID.test(id)) return [];
      const t = before === undefined ? null : Date.parse(before);
      const gone = list().filter((f) => !open.has(f.id) && (id === undefined || f.id === id) && (t === null || f.mtime < t)).map((f) => f.id);
      for (const g of gone) remove(g, 'transcript.delete', by, 'deleted by the operator');
      return gone;
    },

    /**
     * Copy transcripts into `dest` (a new folder): every one, or those written since a time.
     * @param {string} dest @param {{ since?: string }} [opts]
     * @returns {number} how many
     */
    copyTo(dest, { since } = {}) {
      const t = since === undefined ? null : Date.parse(since);
      const pick = list().filter((f) => t === null || f.mtime >= t);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of pick) fs.copyFileSync(file(f.id), path.join(dest, `${f.id}.txt`));
      return pick.length;
    },

    /**
     * Start a session's transcript. write() takes raw terminal text; close() writes what's held.
     * @param {{ id: string, identity: string, workspace: string, startedAt: string }} s
     */
    open(s) {
      if (!ID.test(s.id)) throw new Error('a session id is letters, digits and dashes');
      open.add(s.id);
      rotate();
      const fd = fs.openSync(file(s.id), 'a');
      let bytes = 0;
      let held = '';
      let pem = false;
      let full = false;
      let closed = false;
      /** @param {string[]} lines */
      const put = (lines) => {
        if (full) return;
        const out = [];
        for (const line of lines) {
          // A private key block is one marker, however many lines and chunks it spans.
          if (pem) { if (PEM_END.test(line)) pem = false; continue; }
          if (PEM_BEGIN.test(line)) { out.push(exact(redact(line.replace(/-----BEGIN[\s\S]*/, ''))) + '[REDACTED:private-key]'); pem = !PEM_END.test(line); continue; }
          out.push(exact(redact(line)));
        }
        if (!out.length) return;
        let text = out.join('\n') + '\n';
        if (bytes + Buffer.byteLength(text) > sessionCapBytes) {
          text = `[transcript stopped at its ${sessionCapBytes} byte cap; the session ran on]\n`;
          full = true;
        }
        fs.writeSync(fd, text);
        bytes += Buffer.byteLength(text);
      };
      put([`# session ${s.id} · ${s.identity} · ${s.workspace} · started ${s.startedAt}`]);
      return {
        /** @param {string} data */
        write(data) {
          if (closed) return;
          held += data;
          const end = held.lastIndexOf('\n');
          if (end >= 0) { put(plainLines(held.slice(0, end + 1))); held = held.slice(end + 1); }
          if (held.length > HOLD_MAX) { put(plainLines(held)); held = ''; }
        },
        /** @param {string} [why] how the session ended, as the last line */
        close(why) {
          if (closed) return;
          closed = true;
          if (held) put(plainLines(held));
          held = '';
          if (why) put([`# ended: ${why}`]);
          fs.closeSync(fd);
          open.delete(s.id);
        },
      };
    },

    /**
     * The newest part of a transcript, for the operator's window. Null when there is none.
     * @param {string} id @returns {{ id: string, text: string, bytes: number, truncated: boolean } | null}
     */
    read(id) {
      if (!ID.test(id)) return null;
      let fd;
      try { fd = fs.openSync(file(id), 'r'); } catch { return null; }
      try {
        const bytes = fs.fstatSync(fd).size;
        const len = Math.min(bytes, OPERATOR_TAIL);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, bytes - len);
        let text = buf.toString('utf8');
        // Cut mid-file: start at a whole line.
        if (len < bytes) text = text.slice(text.indexOf('\n') + 1);
        return { id, text, bytes, truncated: len < bytes };
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}
