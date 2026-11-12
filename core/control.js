// The Control API: how the operator's client (Houston, from H2) drives the Core. A named pipe,
// not a port (ADR-004), with one JSON object per line each way:
//   request  { "id": 1, "token": "...", "method": "session.list", "params": {} }
//   answer   { "id": 1, "result": ... }  or  { "id": 1, "error": { "code": "...", "message": "..." } }
//
// Who can call it. Node can't set a pipe's DACL, so the pipe keeps Windows' default: full
// control for the operator, SYSTEM and administrators, read-only for everyone else, and read-only
// can't send a request. A contained process can't open a host pipe at all (spike S3). On top of
// that, the pipe's name is random for each start and every request carries a token. Both are in
// control.json in the Core's data folder, which is in the operator's profile and denied to every
// session. A request with a bad token is audited as control.denied and its connection closed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RunnerError } from './runner.js';

export const METHODS = ['session.start', 'session.stop', 'session.list', 'stop.all', 'audit.query'];
const MAX_LINE = 1024 * 1024;

export class ControlError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

/** @param {unknown} v @param {string} name @returns {string} */
const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new ControlError('bad_request', `${name} is a non-empty string`);
  return v;
};
/** @param {unknown} v @param {string} name @returns {string[] | undefined} */
const strings = (v, name) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new ControlError('bad_request', `${name} is a list of strings`);
  return v;
};

/**
 * The last `limit` audit events that match, oldest first.
 * ponytail: reads the whole log per query; index it when the Logs screen (H2) makes this slow.
 * @param {ReturnType<typeof import('./audit.js').openAudit>} audit
 * @param {{ type?: string, session_id?: string, identity?: string, result?: string, since?: string, limit?: number }} p
 */
export function queryAudit(audit, p) {
  const limit = p.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ControlError('bad_request', 'limit is a whole number from 1 to 1000');
  for (const k of /** @type {const} */ (['type', 'session_id', 'identity', 'result'])) if (p[k] !== undefined) str(p[k], k);
  let since = null;
  if (p.since !== undefined) {
    const t = Date.parse(str(p.since, 'since'));
    if (Number.isNaN(t)) throw new ControlError('bad_request', 'since is a date and time');
    since = new Date(t).toISOString();
  }
  const events = [];
  let matched = 0;
  for (const e of audit.events()) {
    if ((p.type && e.type !== p.type) || (p.session_id && e.session_id !== p.session_id)
      || (p.identity && e.identity?.subject !== p.identity) || (p.result && e.decision?.result !== p.result)
      || (since && !(e.time >= since))) continue;
    matched++;
    events.push(e);
    if (events.length > limit) events.shift();
  }
  return { events, truncated: matched > limit };
}

/** @param {string} dir @param {string} name */
const address = (dir, name) => (process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(dir, `${name}.sock`));

/**
 * Start the Control API and write control.json (pipe name and token) into the data folder.
 *
 * @param {{ dir: string, runner: ReturnType<typeof import('./runner.js').createRunner>, audit: ReturnType<typeof import('./audit.js').openAudit> }} opts
 * @returns {Promise<{ pipe: string, file: string, close: () => Promise<void> }>}
 */
export async function startControl({ dir, runner, audit }) {
  const pipe = address(dir, `houston-core-${crypto.randomBytes(16).toString('hex')}`);
  const token = Buffer.from(crypto.randomBytes(32).toString('base64url'));
  /** @type {Set<net.Socket>} */
  const sockets = new Set();

  /** @type {Record<string, (p: any) => unknown>} */
  const handlers = {
    'session.start': async (p) => {
      const program = p.program ?? {};
      if (typeof program !== 'object' || Array.isArray(program)) throw new ControlError('bad_request', 'program is an object');
      if (p.attended !== undefined && typeof p.attended !== 'boolean') throw new ControlError('bad_request', 'attended is true or false');
      const s = await runner.start({
        identity: str(p.identity, 'identity'), workspace: str(p.workspace, 'workspace'), command: str(p.command, 'command'),
        attended: p.attended, size: p.size,
        program: { readonly: strings(program.readonly, 'program.readonly'), pathDirs: strings(program.pathDirs, 'program.pathDirs'), env: program.env },
      });
      // Nothing reads the terminal over the pipe until H2, so drain it or the session stalls on a full buffer.
      s.output.resume();
      return { id: s.id, identity: s.identity, workspace: s.workspace, startedAt: s.startedAt };
    },
    'session.stop': async (p) => {
      const s = runner.get(str(p.id, 'id'));
      if (!s) throw new ControlError('not_found', 'no running session has that id');
      return s.stop();
    },
    'session.list': () => runner.list(),
    'stop.all': async () => ({ stopped: (await runner.stopAll()).length }),
    'audit.query': (p) => queryAudit(audit, p),
  };

  /** @param {net.Socket} sock @param {object} msg */
  const send = (sock, msg) => { if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`); };

  /** @param {net.Socket} sock @param {string} line */
  async function handle(sock, line) {
    let req;
    try { req = JSON.parse(line); } catch { /* answered below */ }
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      send(sock, { id: null, error: { code: 'bad_request', message: 'each line is one JSON object' } });
      return sock.end();
    }
    const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
    const given = typeof req.token === 'string' ? Buffer.from(req.token) : null;
    if (!given || given.length !== token.length || !crypto.timingSafeEqual(given, token)) {
      audit.append({
        type: 'control.denied', action: 'control.call', identity: { subject: 'unknown' }, session_id: null,
        resource: { type: 'ControlMethod', id: String(req.method || '?').slice(0, 100) },
        decision: { result: 'deny', policy_version: 'none', reasons: [given ? 'wrong token' : 'no token'] },
      });
      send(sock, { id, error: { code: 'unauthorized', message: 'bad or missing token' } });
      return sock.end();
    }
    const fn = typeof req.method === 'string' && Object.hasOwn(handlers, req.method) ? handlers[req.method] : null;
    if (!fn) return send(sock, { id, error: { code: 'unknown_method', message: `methods: ${METHODS.join(', ')}` } });
    const params = req.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) return send(sock, { id, error: { code: 'bad_request', message: 'params is an object' } });
    try {
      send(sock, { id, result: await fn(params) });
    } catch (e) {
      const err = /** @type {Error & { code?: string }} */ (e);
      const code = e instanceof ControlError ? err.code : e instanceof RunnerError ? 'refused' : 'internal';
      send(sock, { id, error: { code, message: err.message } });
    }
  }

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => { /* the client went away */ });
    sock.setEncoding('utf8');
    let buf = '';
    const tooBig = () => {
      buf = '';
      send(sock, { id: null, error: { code: 'bad_request', message: 'a request is at most 1 MB' } });
      sock.end();
    };
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0 && !sock.writableEnded) {
        if (i > MAX_LINE) return tooBig();
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void handle(sock, line);
      }
      if (buf.length > MAX_LINE) tooBig();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => { server.off('error', reject); resolve(undefined); });
  });
  const file = path.join(dir, 'control.json');
  fs.writeFileSync(file, `${JSON.stringify({ pipe, token: token.toString(), pid: process.pid })}\n`, { mode: 0o600 });

  return {
    pipe,
    file,
    close: async () => {
      fs.rmSync(file, { force: true });
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

/**
 * Call the Core's Control API once: read control.json from the data folder, send one request,
 * wait for its answer.
 *
 * @param {string} dir the Core's data folder
 * @param {string} method
 * @param {object} [params]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any>} the result
 * @throws {Error & { code?: string }} the Core's error, with its code
 */
export function callControl(dir, method, params = {}, { timeoutMs = 30_000 } = {}) {
  const { pipe, token } = JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, token, method, params })}\n`));
    sock.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      const res = JSON.parse(buf.slice(0, i));
      if (res.error) reject(Object.assign(new Error(res.error.message), { code: res.error.code }));
      else resolve(res.result);
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
