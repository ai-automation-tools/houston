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
import { StringDecoder } from 'node:string_decoder';
import { ApprovalError } from './approvals.js';
import { GatewayError } from './gateway.js';
import { OPERATOR, RegistryError } from './identities.js';
import { CONTAINMENT, RunnerError } from './runner.js';
import { VaultError } from './vault.js';

export const METHODS = [
  'core.status', 'session.start', 'session.stop', 'session.list', 'stop.all', 'audit.query',
  'identity.list', 'identity.get', 'identity.create', 'identity.activate', 'identity.suspend', 'identity.retire',
  'grant.add', 'grant.remove', 'backend.list', 'session.attach', 'approval.list', 'approval.decide', 'transcript.get',
  'mcp.list', 'mcp.get', 'mcp.add', 'mcp.install', 'mcp.pin', 'mcp.disable', 'secret.list', 'secret.set', 'secret.delete',
];
const MAX_LINE = 1024 * 1024;
/** How much of a session's recent output an attach replays first. */
const TAIL = 256 * 1024;

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
 * Every caller holds the operator's token, so every call acts as the operator.
 *
 * @param {{ dir: string, runner: ReturnType<typeof import('./runner.js').createRunner>, registry: ReturnType<typeof import('./identities.js').createRegistry>, audit: ReturnType<typeof import('./audit.js').openAudit>, schema?: number, approvals?: ReturnType<typeof import('./approvals.js').createApprovals>, transcripts?: ReturnType<typeof import('./transcripts.js').createTranscripts>, gateway?: ReturnType<typeof import('./gateway.js').createGateway>, vault?: Awaited<ReturnType<typeof import('./vault.js').openVault>> }} opts
 *   schema: the database's schema version, for core.status
 * @returns {Promise<{ pipe: string, file: string, close: () => Promise<void> }>}
 */
export async function startControl({ dir, runner, registry, audit, schema = 0, approvals, transcripts, gateway, vault }) {
  const startedAt = new Date().toISOString();
  const pipe = address(dir, `houston-core-${crypto.randomBytes(16).toString('hex')}`);
  const token = Buffer.from(crypto.randomBytes(32).toString('base64url'));
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  /**
   * Each running session's terminal: its recent output, and the connections attached to it.
   * @type {Map<string, { tail: string, subs: Set<net.Socket> }>}
   */
  const terms = new Map();
  /** @type {WeakMap<net.Socket, string>} the session an attached connection streams */
  const attachedTo = new WeakMap();

  /**
   * Keep a session's output: the newest TAIL characters for the next attach, and every chunk to
   * the connections attached now. Read whether or not anyone is attached, so the session never
   * stalls on a full buffer. When it ends, each attached connection gets `{ end }` and is closed.
   * @param {{ id: string, identity: string, workspace: string, startedAt: string, output: import('node:stream').Readable, done: Promise<{ reason: string, exitCode: number | null }> }} s
   */
  function tap(s) {
    const t = { tail: '', subs: new Set() };
    terms.set(s.id, t);
    const decoder = new StringDecoder('utf8');
    // Its transcript, redacted before write (transcripts.js). A disk error stops the transcript, not the session.
    /** @type {ReturnType<NonNullable<typeof transcripts>['open']> | undefined} */
    let script;
    const safely = (/** @type {() => void} */ fn) => {
      try { fn(); } catch (e) { script = undefined; console.error(`transcript ${s.id} stopped: ${/** @type {Error} */ (e).message}`); }
    };
    safely(() => { script = transcripts?.open(s); });
    s.output.on('data', (chunk) => {
      const data = decoder.write(chunk);
      if (!data) return;
      t.tail = (t.tail + data).slice(-TAIL);
      for (const sub of t.subs) send(sub, { data });
      if (script) safely(() => script?.write(data));
    });
    void s.done.then((end) => {
      if (script) safely(() => script?.close(end.reason));
      terms.delete(s.id);
      for (const sub of t.subs) { send(sub, { end }); sub.end(); }
    });
  }

  /**
   * One line from an attached connection: `{ input }` is typed into the terminal, `{ resize }`
   * resizes it. Anything else closes the connection; the session runs on.
   * @param {net.Socket} sock @param {string} id @param {string} line
   */
  function stream(sock, id, line) {
    let m;
    try { m = JSON.parse(line); } catch { /* closed below */ }
    const s = runner.get(id);
    if (!s) return sock.end();
    if (typeof m?.input === 'string' && m.input.length <= 64 * 1024) return void s.input.write(m.input);
    const r = m?.resize;
    if (r && Number.isInteger(r.rows) && Number.isInteger(r.columns)) {
      return void s.resize({ rows: Math.min(200, Math.max(5, r.rows)), columns: Math.min(500, Math.max(20, r.columns)) });
    }
    send(sock, { error: { code: 'bad_request', message: 'an attached connection sends { input } or { resize: { rows, columns } }' } });
    sock.end();
  }

  /** @type {Record<string, (p: any) => unknown>} */
  const handlers = {
    // What the window's Connections row shows. The runner starts containers only until the fallback rung (H7).
    // limits: the defaults the window's Settings page shows (null when this Core has no inbox or transcripts).
    'core.status': () => ({
      pid: process.pid, startedAt, schema, containment: CONTAINMENT, sessions: runner.list().length,
      limits: { approvalSeconds: approvals ? approvals.timeoutMs / 1000 : null, transcriptBytes: transcripts?.capBytes ?? null, sessionTranscriptBytes: transcripts?.sessionCapBytes ?? null },
    }),
    'session.start': async (p) => {
      const program = p.program ?? {};
      if (typeof program !== 'object' || Array.isArray(program)) throw new ControlError('bad_request', 'program is an object');
      if (p.attended !== undefined && typeof p.attended !== 'boolean') throw new ControlError('bad_request', 'attended is true or false');
      const s = await runner.start({
        // No command for an identity with a backend: its manifest sets it.
        identity: str(p.identity, 'identity'), workspace: str(p.workspace, 'workspace'), command: p.command === undefined ? undefined : str(p.command, 'command'),
        attended: p.attended, size: p.size,
        program: { readonly: strings(program.readonly, 'program.readonly'), pathDirs: strings(program.pathDirs, 'program.pathDirs'), env: program.env },
      });
      tap(s);
      return { id: s.id, identity: s.identity, workspace: s.workspace, startedAt: s.startedAt };
    },
    'backend.list': () => runner.backends(),
    // The approval inbox: what waits for the operator, and their answer (approvals.js).
    'approval.list': () => approvals?.list() ?? [],
    // A session's transcript, running or ended: its newest MB, already redacted.
    'transcript.get': (p) => {
      const r = transcripts?.read(str(p.id, 'id'));
      if (!r) throw new ControlError('not_found', 'no transcript has that session id');
      return r;
    },
    'approval.decide': (p) => {
      if (!approvals) throw new ControlError('not_found', 'this Core has no approval inbox');
      return approvals.decide(str(p.id, 'id'), p.answer);
    },
    'session.stop': async (p) => {
      const s = runner.get(str(p.id, 'id'));
      if (!s) throw new ControlError('not_found', 'no running session has that id');
      return s.stop();
    },
    'session.list': () => runner.list(),
    // Stop All (SEC-10): one event saying the operator pressed it, then each session's own session.end.
    'stop.all': async () => {
      const running = runner.list().length;
      audit.append({
        type: 'stop.all', action: 'stop.all', identity: { subject: OPERATOR }, session_id: null, resource: { type: 'Core', id: 'sessions' },
        decision: { result: 'allow', policy_version: 'none', reasons: [`${running} running`] },
      });
      return { stopped: (await runner.stopAll()).length };
    },
    'audit.query': (p) => queryAudit(audit, p),

    'identity.list': (p) => registry.list({ status: p.status }),
    'identity.get': (p) => registry.get(str(p.id, 'id')),
    'identity.create': (p) => registry.create(p, OPERATOR),
    'identity.activate': (p) => registry.setStatus(str(p.id, 'id'), 'active', OPERATOR, p.reason),
    // Suspending or retiring also stops the identity's running sessions.
    // ponytail: a session.start already past the runner's status check still starts; stop it with session.stop.
    'identity.suspend': (p) => deactivate(str(p.id, 'id'), 'suspended', p.reason),
    'identity.retire': (p) => deactivate(str(p.id, 'id'), 'retired', p.reason),
    'grant.add': (p) => registry.addGrant(p, OPERATOR),
    'grant.remove': (p) => registry.removeGrant(str(p.id, 'id'), OPERATOR),

    // The MCP gateway's servers (gateway.js): add shows the command, install runs it once to read
    // its tools, pin accepts that list by its hash.
    'mcp.list': () => need(gateway, 'gateway').list(),
    'mcp.get': (p) => need(gateway, 'gateway').get(p.name),
    'mcp.add': (p) => need(gateway, 'gateway').add(p),
    'mcp.install': (p) => need(gateway, 'gateway').install(p.name),
    'mcp.pin': (p) => need(gateway, 'gateway').pin(p.name, p.hash),
    'mcp.disable': (p) => need(gateway, 'gateway').disable(p.name),
    // The vault (vault.js): names and dates out, values only in. There is no secret.get.
    'secret.list': () => need(vault, 'vault').list(),
    'secret.set': (p) => need(vault, 'vault').set(p.name, p.value),
    'secret.delete': (p) => need(vault, 'vault').remove(p.name),
  };

  /** @template T @param {T | undefined} part @param {string} what @returns {T} */
  function need(part, what) {
    if (!part) throw new ControlError('not_found', `this Core has no ${what}`);
    return part;
  }

  /** @param {string} id @param {'suspended' | 'retired'} to @param {string} [reason] */
  async function deactivate(id, to, reason) {
    const identity = registry.setStatus(id, to, OPERATOR, reason);
    const mine = runner.list().filter((s) => s.identity === id);
    await Promise.all(mine.map((s) => runner.get(s.id)?.stop()));
    return { identity, stopped: mine.length };
  }

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
    // Synchronous on purpose: lines after this one in the same chunk are already stream lines.
    if (req.method === 'session.attach') {
      const sid = req.params?.id;
      const t = typeof sid === 'string' ? terms.get(sid) : undefined;
      if (!t) return send(sock, { id, error: { code: 'not_found', message: 'no running session has that id' } });
      attachedTo.set(sock, sid);
      t.subs.add(sock);
      sock.on('close', () => t.subs.delete(sock));
      send(sock, { id, result: { attached: sid } });
      if (t.tail) send(sock, { data: t.tail });
      return;
    }
    const fn = typeof req.method === 'string' && Object.hasOwn(handlers, req.method) ? handlers[req.method] : null;
    if (!fn) return send(sock, { id, error: { code: 'unknown_method', message: `methods: ${METHODS.join(', ')}` } });
    const params = req.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) return send(sock, { id, error: { code: 'bad_request', message: 'params is an object' } });
    try {
      send(sock, { id, result: await fn(params) });
    } catch (e) {
      const err = /** @type {Error & { code?: string }} */ (e);
      const code = e instanceof ControlError || e instanceof RegistryError || e instanceof ApprovalError || e instanceof GatewayError || e instanceof VaultError ? err.code : e instanceof RunnerError ? 'refused' : 'internal';
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
        const sid = attachedTo.get(sock);
        if (sid) stream(sock, sid, line);
        else if (line.trim()) void handle(sock, line);
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

export { callControl } from './client.js';
