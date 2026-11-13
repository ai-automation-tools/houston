// The runner: turns one identity's grants into a container, starts it on a pseudo-terminal,
// and ends it by closing the container. Every start, refusal and end is an audit event.
//
// A session runs on a frozen copy of its grants: the egress proxy decides against the
// grants as they were at start, under the policy version recorded in session.start.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackendError, gatewayArgs, listBackends, resolveBackend } from './backends.js';
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
 * The container name a session runs under: its id's 32 hex digits, the SDK's own format.
 * A restarted Core finds a dead Core's containers by it.
 * @param {string} sessionId
 */
export const containerName = (sessionId) => sessionId.replaceAll('-', '');

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
 * @property {string} [agentsRoot] where each identity's CLI home goes (backends.js); required to start a backend identity
 * @property {string} [home]
 * @property {import('./backends.js').Where} [where] the operator's folders, to find backend programs; defaults from the environment
 * @property {(p: string) => boolean} [isFile] for tests
 * @property {ReturnType<typeof import('./approvals.js').createApprovals>} [approvals] where an `ask` waits; without it, `ask` is deny
 * @property {{ forSession: ReturnType<typeof import('./gateway.js').createGateway>['forSession'] }} [gateway] the MCP gateway; every session then gets one on its proxy port
 * @property {{ spawnWithPty: Function }} [sdk] defaults to @microsoft/mxc-sdk/v1
 * @property {() => Date} [now]
 *
 * @typedef {object} StartSpec
 * @property {string} identity  e.g. 'local:dev-codex'
 * @property {string} workspace  the identity must hold an allow write grant on it
 * @property {string} [command] required unless the identity has a backend, whose manifest sets it
 * @property {boolean} [attended]
 * @property {{ readonly?: string[], pathDirs?: string[], env?: Record<string, string> }} [program]  toolchain folders and environment; a backend's manifest adds its own
 * @property {{ rows: number, columns: number }} [size]
 * @property {number} [timeoutMs]  the container is ended after this long (a standing grant's budget); a day by default
 * @property {string} [standingGrant]  the standing grant it runs under (standing.js), recorded on the session
 */

/** The containment rung this runner starts sessions on; the fallback rung is H7. */
export const CONTAINMENT = 'container';

/** @param {RunnerOptions} opts */
export function createRunner({
  db, audit, coreDir, tempRoot, agentsRoot, home = os.homedir(), sdk, now = () => new Date(), isFile, approvals, gateway,
  where = { home, appData: process.env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'), PATH: process.env.PATH ?? '' },
}) {
  const globals = globalDenies({ home, coreDir });
  /** @type {Map<string, Session>} */
  const live = new Map();
  const root = canonicalPath(tempRoot);

  /**
   * @typedef {{ id: string, identity: string, workspace: string, startedAt: string, standingGrant: string | null, input: import('node:stream').Writable, output: import('node:stream').Readable, resize: (size: { rows: number, columns: number }) => void, stop: () => Promise<{ reason: string }>, done: Promise<{ reason: string, exitCode: number | null }> }} Session
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
  async function start({ identity, workspace, command, attended = true, program = {}, size, timeoutMs = 24 * 60 * 60_000, standingGrant }) {
    if (typeof identity !== 'string' || !identity) throw new RunnerError('identity is an id like local:dev-codex');
    const id = crypto.randomUUID();
    const version = policyVersion(db, globals);
    const refuse = (/** @type {string} */ reason) => {
      event('session.start', String(identity), id, { result: 'deny', policy_version: version, reasons: [reason] });
      return new RunnerError(reason);
    };

    const who = /** @type {any} */ (db.prepare('SELECT status, containment, expires_at, backend FROM identities WHERE id = ?').get(identity));
    if (!who) throw refuse('unknown identity');
    if (who.status !== 'active') throw refuse(`the identity is ${who.status}`);
    if (who.expires_at != null && !(Date.parse(who.expires_at) > now().getTime())) throw refuse('the identity has expired');
    if (who.containment !== 'container') throw refuse(`the identity runs ${who.containment}; this runner starts containers only`);

    // A backend identity runs its manifest's command, with its CLI home; anything else names its command.
    let backend = null;
    if (who.backend != null) {
      if (command !== undefined) throw refuse(`the ${who.backend} backend's manifest sets the command`);
      if (!agentsRoot) throw refuse('this runner has no agents folder for backend homes');
      try { backend = resolveBackend(who.backend, { identity, agentsRoot, where, isFile }); } catch (e) {
        if (e instanceof BackendError) throw refuse(e.message);
        throw e;
      }
      command = backend.command;
    } else if (typeof command !== 'string' || !command) throw refuse('a command is required for an identity with no backend');

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

    // Hosts an `ask` grant names: the session gets a proxy for them too when someone can answer.
    const askHosts = approvals ? grants.filter((g) => g.resource.startsWith('net:') && g.effect === 'ask').map((g) => g.resource.slice(4)) : [];
    const temp = canonicalPath(path.join(win(root), id, 'tmp'));
    /** @type {Awaited<ReturnType<typeof startEgressProxy>> | null} */
    let proxy = null;
    // The session's view of the MCP gateway, served on its proxy port; its token dies with it.
    const gw = gateway?.forSession({ id, identity, workspace: ws, attended, policy });
    const cleanup = async () => {
      await gw?.close();
      if (proxy) await proxy.close();
      // Only ever this session's own folder under tempRoot.
      const mine = path.join(win(root), id);
      if (pathKey(mine).startsWith(`${pathKey(root)}/`)) fs.rmSync(mine, { recursive: true, force: true });
    };

    /** @type {any} */
    let req;
    try {
      fs.mkdirSync(win(temp), { recursive: true });
      // Kept between sessions: the CLI's sign-in, settings and history for this identity.
      if (backend) fs.mkdirSync(backend.home, { recursive: true });
      if (compiled.net.length || askHosts.length || gw) {
        proxy = await startEgressProxy({
          fallback: gw?.handle,
          // An `ask` waits in the approval inbox, holding the request, until the operator answers or it times out.
          check: async ({ host, port }) => {
            const d = decide(request('net.connect', 'Host', `${host}:${port}`), { ...policy, now: now() });
            if (d.decision !== 'ask' || !approvals) return d;
            const o = await approvals.ask({
              identity, session_id: id, workspace: win(ws), action: 'net.connect', resource: { type: 'Host', id: `${host}:${port}` },
              policy_version: version, policy_ids: d.determining_policies,
            });
            return { ...d, decision: o.result, reasons: [o.reason], approval: true };
          },
          onEvent: (e) => audit.append({
            type: 'egress.connect', action: 'net.connect', identity: { subject: identity, containment: 'container' }, session_id: id,
            resource: { type: 'Host', id: `${e.host}:${e.port}` },
            decision: { result: e.decision, policy_version: version, policy_ids: e.policy?.determining_policies ?? [], reasons: [e.reason] },
            egress: { scheme: e.scheme, method: e.method ?? null, address: e.address ?? null },
          }),
        });
      }
      const mcp = gw && proxy ? { HOUSTON_MCP_URL: `http://127.0.0.1:${proxy.port}/mcp`, HOUSTON_MCP_TOKEN: gw.token } : {};
      if (backend && mcp.HOUSTON_MCP_URL) {
        const extra = gatewayArgs(/** @type {string} */ (who.backend), mcp.HOUSTON_MCP_URL, win(temp));
        if (extra) command = `${command} ${extra}`;
      }
      req = {
        ...launchRequest({
          command, workspace: ws, temp, home, globals,
          readwrite: [...compiled.readwrite, ...(backend?.readwrite ?? [])],
          readonly: [...compiled.readonly, ...(backend?.readonly ?? []), ...(program.readonly ?? [])], denied: compiled.denied,
          pathDirs: [...(backend?.pathDirs ?? []), ...(program.pathDirs ?? [])],
          // The manifest's variables win: a caller can't point the CLI at another home, or the session at another gateway.
          env: { ...program.env, ...backend?.env, ...mcp }, // The runner ends it at its budget (below); the SDK's own timeout, a minute later, is the backstop.
          proxyPort: proxy?.port, timeoutMs: timeoutMs + 60_000,
        }),
        containerName: containerName(id),
      };
    } catch (e) {
      await cleanup();
      throw refuse(e instanceof LaunchError || e instanceof PathError ? e.message : `launch failed: ${/** @type {Error} */ (e).message}`);
    }

    const startedAt = now().toISOString();
    const launch = {
      command, container: req.containerName,
      readwrite: req.filesystem.readwritePaths, readonly: req.filesystem.readonlyPaths, denied: req.filesystem.deniedPaths,
      network: proxy ? { proxy: true, hosts: compiled.net.map((g) => g.resource.slice(4)), ...(askHosts.length ? { ask: askHosts } : {}), ...(gw ? { gateway: true } : {}) } : { proxy: false },
      skipped: compiled.skipped,
      // Hosts the manifest needs that no allow grant covers: the session will be refused them.
      ...(backend ? { backend: { name: who.backend, home: backend.home, missingHosts: backend.hosts.filter((h) => decide(request('net.connect', 'Host', h), policy).decision !== 'allow') } } : {}),
    };
    db.prepare('INSERT INTO sessions (id, identity_id, workspace, containment, attended, policy_version, started_at, standing_grant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, identity, ws, 'container', attended ? 1 : 0, version, startedAt, standingGrant ?? null);
    db.prepare('UPDATE identities SET last_used_at = ? WHERE id = ?').run(startedAt, identity);
    event('session.start', identity, id, { result: 'allow', policy_version: version, policy_ids: onWs.determining_policies, reasons: ['started'] }, { launch, ...(standingGrant ? { standing_grant: standingGrant } : {}) });

    /** @param {string} reason @param {number | null} exitCode */
    const finish = async (reason, exitCode) => {
      db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(now().toISOString(), reason, id);
      event('session.end', identity, id, { result: 'allow', policy_version: version }, { outcome: { status: exitCode === 0 ? 'ok' : 'error', error_code: exitCode == null ? reason : String(exitCode) } });
      live.delete(id);
      approvals?.endSession(id);
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
    // Its budget: the SDK reports a PTY session's own timeout as exit -1 (H4 check, 2026-11-13), so the runner keeps time.
    let overBudget = false;
    const budget = setTimeout(() => { overBudget = true; try { term.kill(); } catch { /* already exited */ } }, timeoutMs);
    const done = term.wait().then(
      (/** @type {{ exitCode: number, timedOut: boolean }} */ r) => {
        const timedOut = overBudget || r.timedOut;
        return finish(timedOut ? 'timeout' : stopping ? 'stopped' : `exit ${r.exitCode}`, timedOut || stopping ? null : r.exitCode);
      },
      (/** @type {Error} */ e) => finish(`lost: ${e.message}`, null),
    ).finally(() => { clearTimeout(budget); try { term.dispose(); } catch { /* already gone */ } });

    /** @type {Session} */
    const session = {
      id, identity, workspace: ws, startedAt, standingGrant: standingGrant ?? null, input, output, done,
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
    list: () => [...live.values()].map(({ id, identity, workspace, startedAt, standingGrant }) => ({ id, identity, workspace, startedAt, standingGrant })),
    stopAll: () => Promise.all([...live.values()].map((s) => s.stop())),
    /** The backend manifests, and whether each program is installed on this machine. */
    backends: () => listBackends(where, isFile),
  };
}

/**
 * The SDK's brokers running on this machine. On Windows a PTY session's container is run by
 * one `wxc-exec.exe`, started with the request base64-encoded on its command line; ending
 * that process ends the container (H1 check, 2026-11-12).
 *
 * @returns {{ pid: number, containerId: string | null }[]}
 * @throws {Error} when the process list can't be read
 */
export function listBrokers() {
  if (process.platform !== 'win32') return [];
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const query = "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='wxc-exec.exe'\" | ForEach-Object { @{ pid = $_.ProcessId; cmd = $_.CommandLine } })";
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.error || r.status !== 0) throw new Error(`listing wxc-exec.exe failed: ${r.error?.message ?? r.stderr.trim()}`);
  return /** @type {{ pid: number, cmd: string | null }[]} */ (JSON.parse(r.stdout)).map(({ pid, cmd }) => {
    const b64 = /--config-base64\s+([A-Za-z0-9+/=]+)/.exec(cmd ?? '')?.[1];
    let containerId = null;
    try { if (b64) containerId = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).containerId ?? null; } catch { /* not ours to read */ }
    return { pid, containerId };
  });
}

/**
 * Sessions still open in the database belong to a Core that died (AT-16). A dead Core's
 * containers can outlive it: one that exits right after a spawn leaves the broker and the
 * contained process running. So each one still running is ended, found by its container
 * name, and then the session is marked interrupted. The session.end event says which.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof import('./audit.js').openAudit>} audit
 * @param {{ now?: () => Date, brokers?: typeof listBrokers, kill?: (pid: number) => void }} [opts]
 * @returns {string[]} the ids marked
 */
export function markInterrupted(db, audit, { now = () => new Date(), brokers = listBrokers, kill = (pid) => process.kill(pid) } = {}) {
  const open = /** @type {any[]} */ (db.prepare('SELECT id, identity_id, policy_version FROM sessions WHERE ended_at IS NULL').all());
  if (!open.length) return [];
  /** @type {ReturnType<typeof listBrokers> | null} */
  let running = null;
  let listError = '';
  try { running = brokers(); } catch (e) { listError = /** @type {Error} */ (e).message; }

  for (const s of open) {
    let reason;
    if (!running) reason = `could not check for its container: ${listError}`;
    else {
      const mine = running.filter((b) => b.containerId === containerName(s.id));
      const failed = [];
      for (const b of mine) {
        try { kill(b.pid); } catch (e) { if (/** @type {any} */ (e).code !== 'ESRCH') failed.push(`pid ${b.pid}: ${/** @type {Error} */ (e).message}`); }
      }
      reason = !mine.length ? 'no container was running' : failed.length ? `could not end its container (${failed.join('; ')})` : 'ended its container';
    }
    db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'interrupted' WHERE id = ?").run(now().toISOString(), s.id);
    audit.append({
      type: 'session.end', action: 'session.end', identity: { subject: s.identity_id, containment: 'container' }, session_id: s.id,
      resource: { type: 'Session', id: s.id }, decision: { result: 'allow', policy_version: s.policy_version, reasons: [reason] },
      outcome: { status: 'error', error_code: 'interrupted' },
    });
  }
  return open.map((s) => s.id);
}
