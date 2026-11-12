// The runner: turns one identity's grants into a container, starts it on a pseudo-terminal,
// and ends it by closing the container. Every start, refusal and end is an audit event.
//
// A session runs on a frozen copy of its grants: the egress proxy decides against the
// grants as they were at start, under the policy version recorded in session.start.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEgressProxy } from './egress.js';
import { LaunchError, launchRequest } from './launch.js';
import { PathError, canonicalPath, pathKey, resolvePath } from './paths.js';
import { decide, globalDenies, policyVersion } from './policy.js';

export class RunnerError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RunnerError';
  }
}

/** @param {string} p canonical @returns {string} */
const win = (p) => p.replaceAll('/', '\\');

/**
 * @typedef {import('./policy.js').Grant} Grant
 * @typedef {{ readwrite: string[], readonly: string[], denied: string[], net: Grant[], skipped: { id: string, reason: string }[] }} Compiled
 */

/**
 * Compile file grants to container folders. A container can only grant or deny whole files
 * and folders, so:
 *
 * - `allow` + `write` -> read-write (a container can't separate write from read);
 *   `allow` + `read` -> read-only.
 * - `dir/**` compiles to `dir`, an exact path to itself. Any other wildcard can't be
 *   compiled: an allow is skipped (less access), a deny refuses the launch.
 * - `ask` is skipped: nobody can answer inside a container, so it is not granted.
 * - `list` is skipped: the launch defaults' enumerate already covers names.
 * - `net:` allow grants are kept for the egress proxy. Tool, command, secret and session
 *   grants are the gateway's, not the container's.
 *
 * @param {Grant[]} grants
 * @param {Date} [now]
 * @returns {Compiled}
 * @throws {RunnerError} when a deny can't be compiled, because the container would not enforce it
 */
export function compileGrants(grants, now = new Date()) {
  /** @type {Compiled} */
  const out = { readwrite: [], readonly: [], denied: [], net: [], skipped: [] };
  for (const g of grants) {
    const expired = g.expires_at != null && !(Date.parse(g.expires_at) > now.getTime());
    if (g.effect !== 'deny' && expired) { out.skipped.push({ id: g.id, reason: 'expired' }); continue; }
    if (g.effect === 'deny' && g.expires_at != null && Date.parse(g.expires_at) <= now.getTime()) continue;
    if (g.resource.startsWith('net:')) { if (g.effect === 'allow') out.net.push(g); continue; }
    if (!g.resource.startsWith('file:')) continue;

    const pattern = g.resource.slice(5).replace(/[\\/]\*\*$/, '');
    let folder;
    try {
      if (pattern.includes('*')) throw new PathError('only dir/** or an exact path compiles to a container');
      folder = canonicalPath(pattern);
    } catch (e) {
      const why = /** @type {Error} */ (e).message;
      if (g.effect === 'deny') throw new RunnerError(`deny grant ${g.id} (${g.resource}) can't be enforced by the container: ${why}`);
      out.skipped.push({ id: g.id, reason: why });
      continue;
    }
    if (g.effect === 'deny') out.denied.push(folder);
    else if (g.effect === 'ask') out.skipped.push({ id: g.id, reason: 'ask is not granted inside a container' });
    else if (g.permission === 'write') out.readwrite.push(folder);
    else if (g.permission === 'read') out.readonly.push(folder);
    else out.skipped.push({ id: g.id, reason: `${g.permission} grants are not compiled` });
  }
  return out;
}

/**
 * @typedef {object} RunnerOptions
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {ReturnType<typeof import('./audit.js').openAudit>} audit
 * @property {string} coreDir the Core's data folder, denied to every session
 * @property {string} tempRoot where session temp folders go; outside the user profile
 * @property {string} [home]
 * @property {{ spawnWithPty: Function }} [sdk] defaults to @microsoft/mxc-sdk/v1
 * @property {() => Date} [now]
 *
 * @typedef {object} StartSpec
 * @property {string} identity  e.g. 'local:dev-codex'
 * @property {string} workspace  the identity must hold an allow write grant on it
 * @property {string} command
 * @property {boolean} [attended]
 * @property {{ readonly?: string[], pathDirs?: string[], env?: Record<string, string> }} [program]  what the backend needs (H2: from its manifest)
 * @property {{ rows: number, columns: number }} [size]
 */

/** @param {RunnerOptions} opts */
export function createRunner({ db, audit, coreDir, tempRoot, home = os.homedir(), sdk, now = () => new Date() }) {
  const globals = globalDenies({ home, coreDir });
  /** @type {Map<string, Session>} */
  const live = new Map();
  const root = canonicalPath(tempRoot);

  /**
   * @typedef {{ id: string, identity: string, workspace: string, startedAt: string, input: import('node:stream').Writable, output: import('node:stream').Readable, resize: (size: { rows: number, columns: number }) => void, stop: () => Promise<{ reason: string }>, done: Promise<{ reason: string, exitCode: number | null }> }} Session
   */

  /** @param {string} type @param {string} identity @param {string} sessionId @param {object} decision @param {object} [extra] */
  const event = (type, identity, sessionId, decision, extra = {}) => audit.append({
    type, action: type, identity: { subject: identity, containment: 'container' }, session_id: sessionId,
    resource: { type: 'Session', id: sessionId }, decision, ...extra,
  });

  /**
   * Start a contained session.
   * @param {StartSpec} spec
   * @returns {Promise<Session>}
   * @throws {RunnerError} with a session.start deny event written first
   */
  async function start({ identity, workspace, command, attended = true, program = {}, size }) {
    if (typeof identity !== 'string' || !identity) throw new RunnerError('identity is an id like local:dev-codex');
    const id = crypto.randomUUID();
    const version = policyVersion(db, globals);
    const refuse = (/** @type {string} */ reason) => {
      event('session.start', String(identity), id, { result: 'deny', policy_version: version, reasons: [reason] });
      return new RunnerError(reason);
    };

    const who = /** @type {any} */ (db.prepare('SELECT status, containment, expires_at FROM identities WHERE id = ?').get(identity));
    if (!who) throw refuse('unknown identity');
    if (who.status !== 'active') throw refuse(`the identity is ${who.status}`);
    if (who.expires_at != null && !(Date.parse(who.expires_at) > now().getTime())) throw refuse('the identity has expired');
    if (who.containment !== 'container') throw refuse(`the identity runs ${who.containment}; this runner starts containers only`);

    const grants = /** @type {Grant[]} */ (db.prepare('SELECT id, resource, permission, effect, expires_at FROM grants WHERE identity_id = ?').all(identity));
    let ws;
    try { ws = resolvePath(workspace); } catch (e) { throw refuse(`workspace: ${/** @type {Error} */ (e).message}`); }
    const policy = { grants, globals, policyVersion: version, now: now() };
    const request = (/** @type {string} */ action, /** @type {string} */ type, /** @type {string} */ rid) =>
      ({ principal: { type: 'Identity', id: identity }, action, resource: { type, id: rid }, context: { session_id: id, attended } });
    const onWs = decide(request('file.write', 'File', ws), policy);
    if (onWs.decision !== 'allow') throw refuse(`the identity has no write grant on the workspace (${onWs.reasons.join('; ')})`);

    let compiled;
    try { compiled = compileGrants(grants, now()); } catch (e) { throw refuse(/** @type {Error} */ (e).message); }

    const temp = canonicalPath(path.join(win(root), id, 'tmp'));
    /** @type {Awaited<ReturnType<typeof startEgressProxy>> | null} */
    let proxy = null;
    const cleanup = async () => {
      if (proxy) await proxy.close();
      // Only ever this session's own folder under tempRoot.
      const mine = path.join(win(root), id);
      if (pathKey(mine).startsWith(`${pathKey(root)}/`)) fs.rmSync(mine, { recursive: true, force: true });
    };

    /** @type {any} */
    let req;
    try {
      fs.mkdirSync(win(temp), { recursive: true });
      if (compiled.net.length) {
        proxy = await startEgressProxy({
          check: ({ host, port }) => decide(request('net.connect', 'Host', `${host}:${port}`), { ...policy, now: now() }),
          onEvent: (e) => audit.append({
            type: 'egress.connect', action: 'net.connect', identity: { subject: identity, containment: 'container' }, session_id: id,
            resource: { type: 'Host', id: `${e.host}:${e.port}` },
            decision: { result: e.decision, policy_version: version, policy_ids: e.policy?.determining_policies ?? [], reasons: [e.reason] },
            egress: { scheme: e.scheme, method: e.method ?? null, address: e.address ?? null },
          }),
        });
      }
      req = launchRequest({
        command, workspace: ws, temp, home, globals,
        readwrite: compiled.readwrite, readonly: [...compiled.readonly, ...(program.readonly ?? [])], denied: compiled.denied,
        pathDirs: program.pathDirs, env: program.env, proxyPort: proxy?.port, timeoutMs: 24 * 60 * 60_000,
      });
    } catch (e) {
      await cleanup();
      throw refuse(e instanceof LaunchError || e instanceof PathError ? e.message : `launch failed: ${/** @type {Error} */ (e).message}`);
    }

    const startedAt = now().toISOString();
    const launch = {
      command,
      readwrite: req.filesystem.readwritePaths, readonly: req.filesystem.readonlyPaths, denied: req.filesystem.deniedPaths,
      network: proxy ? { proxy: true, hosts: compiled.net.map((g) => g.resource.slice(4)) } : { proxy: false },
      skipped: compiled.skipped,
    };
    db.prepare('INSERT INTO sessions (id, identity_id, workspace, containment, attended, policy_version, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, identity, ws, 'container', attended ? 1 : 0, version, startedAt);
    event('session.start', identity, id, { result: 'allow', policy_version: version, policy_ids: onWs.determining_policies, reasons: ['started'] }, { launch });

    /** @param {string} reason @param {number | null} exitCode */
    const finish = async (reason, exitCode) => {
      db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(now().toISOString(), reason, id);
      event('session.end', identity, id, { result: 'allow', policy_version: version }, { outcome: { status: exitCode === 0 ? 'ok' : 'error', error_code: exitCode == null ? reason : String(exitCode) } });
      live.delete(id);
      await cleanup();
      return { reason, exitCode };
    };

    let term;
    try {
      const mxc = sdk ?? await import('@microsoft/mxc-sdk/v1');
      term = await mxc.spawnWithPty(req, size ? { size } : undefined);
    } catch (e) {
      await finish(`failed to start: ${/** @type {Error} */ (e).message}`, null);
      throw new RunnerError(`the container did not start: ${/** @type {Error} */ (e).message}`);
    }

    // The SDK hands out the terminal's streams only until wait() starts draining them.
    const input = term.input;
    const output = term.output;
    let stopping = false;
    const done = term.wait().then(
      (/** @type {{ exitCode: number, timedOut: boolean }} */ r) => finish(stopping ? 'stopped' : r.timedOut ? 'timeout' : `exit ${r.exitCode}`, stopping ? null : r.exitCode),
      (/** @type {Error} */ e) => finish(`lost: ${e.message}`, null),
    ).finally(() => { try { term.dispose(); } catch { /* already gone */ } });

    /** @type {Session} */
    const session = {
      id, identity, workspace: ws, startedAt, input, output, done,
      resize: (size) => term.resize(size),
      // Closing the container ends every process in it.
      stop: async () => { stopping = true; try { term.kill(); } catch { /* already exited */ } return done; },
    };
    live.set(id, session);
    return session;
  }

  return {
    start,
    /** @param {string} id */
    get: (id) => live.get(id),
    list: () => [...live.values()].map(({ id, identity, workspace, startedAt }) => ({ id, identity, workspace, startedAt })),
    stopAll: () => Promise.all([...live.values()].map((s) => s.stop())),
  };
}

/**
 * Sessions still open in the database belong to a Core that died (AT-16): mark them
 * interrupted. This closes the records only. Their containers do NOT end with the Core: the
 * SDK's broker (wxc-exec.exe) and the contained process outlive a killed Core (H1 runner
 * check, 2026-11-12). Ending them is a roadmap item.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof import('./audit.js').openAudit>} audit
 * @param {() => Date} [now]
 * @returns {string[]} the ids marked
 */
export function markInterrupted(db, audit, now = () => new Date()) {
  const open = /** @type {any[]} */ (db.prepare('SELECT id, identity_id, policy_version FROM sessions WHERE ended_at IS NULL').all());
  for (const s of open) {
    db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'interrupted' WHERE id = ?").run(now().toISOString(), s.id);
    audit.append({
      type: 'session.end', action: 'session.end', identity: { subject: s.identity_id, containment: 'container' }, session_id: s.id,
      resource: { type: 'Session', id: s.id }, decision: { result: 'allow', policy_version: s.policy_version }, outcome: { status: 'error', error_code: 'interrupted' },
    });
  }
  return open.map((s) => s.id);
}
