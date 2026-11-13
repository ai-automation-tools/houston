// The Agents tab's main-process side: identities and running sessions from the Core, and a
// contained session shown as a terminal tab. Houston only asks: the Core checks the identity,
// its grants and the workspace, and refuses with a reason the tab shows (ADR-004).
//
// The renderer names an identity or a session id and nothing else. The folder is the active
// workspace's, the command is the identity's backend manifest or the fixed SHELL_COMMAND, and
// PATH gets the operator's toolchain folders (toolchainPath), which grants nothing.

import os from 'node:os';
import { attachSession, dataDir } from '../../core/client.js';
import { SHELL_COMMAND, agentRows } from '../shared/agents.js';
import { backendRows, memoryDecision, memoryId, memoryRows, runtimeRows, secretRows, serverName, serverRows, standingId, standingRows, toolsHashArg } from '../shared/integrations.js';
import { toolchainPath } from '../shared/toolchain.js';
import { docPage, escapeHtml } from '../shared/docs.js';
import { identitiesBody } from '../shared/identities.js';
import { logFilter, sessionChoices, transcriptBody, transcriptIdFromUrl } from '../shared/logs.js';
import { core } from './core.js';
import { activeProfile } from './profile.js';

/** Why a call to the Core failed, in words for the tab. @param {unknown} e */
function why(e) {
  const err = /** @type {Error & { code?: string }} */ (e);
  return err.code === 'ENOENT' ? 'The Houston Core is not running. Start it: see docs/guide/core-at-logon.md.' : err.message;
}

/**
 * The acc://transcript/<session> page: the Core's transcript of that session, already redacted.
 * @param {string} url
 */
export async function transcriptPage(url) {
  const id = transcriptIdFromUrl(url);
  if (!id) throw new Error('This address doesn\'t name a session.');
  let t;
  try {
    t = await core.call('transcript.get', { id });
  } catch (e) {
    throw new Error(/** @type {any} */ (e).code === 'not_found' ? 'The Core has no transcript for this session. Transcripts start with the Core that writes them, and the oldest are deleted past the size cap.' : why(e));
  }
  return docPage({ title: `Transcript ${id.slice(0, 8)}`, trail: `Agents › Transcripts › ${id}`, body: transcriptBody(t, escapeHtml) });
}

/** The acc://identities/ page, the Identity Center (H5): every identity, what its grants open, its sessions. */
export async function identitiesPage() {
  if (process.platform !== 'win32') throw new Error('Identities live in the Core, which runs on Windows only.');
  let identities, sessions, starts;
  try {
    [identities, sessions, starts] = await Promise.all([core.call('identity.list', { profile: activeProfile() }), core.call('session.list'), core.call('audit.query', { type: 'session.start', limit: 500 })]);
  } catch (e) { throw new Error(why(e)); }
  /** @type {Record<string, any>} */
  const reach = {};
  await Promise.all(identities.filter((/** @type {any} */ i) => i.kind !== 'operator').map(async (/** @type {any} */ i) => {
    // A Core from before H5 has no identity.reach.
    reach[i.id] = await core.call('identity.reach', { id: i.id }).catch((e) => ({ error: e.code === 'unknown_method' ? 'it runs older code than the app; end and run the Houston Core task' : why(e) }));
  }));
  const mine = new Set(identities.map((/** @type {any} */ i) => i.id));
  const body = identitiesBody({ identities, reach, sessions: sessions.filter((/** @type {any} */ s) => mine.has(s.identity)), starts: starts.events.slice().reverse(), now: Date.now() }, escapeHtml);
  return docPage({ title: 'Identity Center', trail: 'Houston › Identity Center', body });
}

/** The lifecycle actions the Agents tab offers, and the Control API method each one is. */
const LIFECYCLE = { activate: 'identity.activate', suspend: 'identity.suspend', retire: 'identity.retire', review: 'identity.review' };

/**
 * The Core's part of the Settings page: its data folder, the limits it runs with, and how many
 * identities, grants, waiting cards and sessions it has. Null off Windows.
 * @returns {Promise<import('../shared/scopes.js').Snapshot['core']>}
 */
export async function coreSettings() {
  if (process.platform !== 'win32') return null;
  try {
    const profile = activeProfile();
    const [status, identities, approvals] = await Promise.all([core.call('core.status', {}, 3000), core.call('identity.list', { profile }), core.call('approval.list')]);
    if (!status.limits) return { error: 'it runs older code than the app; end and run the Houston Core task' };
    const grants = identities.flatMap((/** @type {any} */ i) => i.grants ?? []);
    // A Core from before the gateway (H3) has neither method: shown as needing a newer Core.
    const [servers, secrets] = await Promise.all([core.call('mcp.list', { profile }).catch(() => null), core.call('secret.list', { profile }).catch(() => null)]);
    return {
      dir: dataDir(), sessions: status.sessions, identities: identities.length, grants: grants.length,
      askGrants: grants.filter((/** @type {any} */ g) => g.effect === 'ask').length, approvals: approvals.length, limits: status.limits,
      mcp: servers && {
        servers: servers.length, pinned: servers.filter((/** @type {any} */ m) => m.state === 'pinned').length,
        review: servers.filter((/** @type {any} */ m) => m.state === 'needs_review').length,
      },
      secrets: secrets && secrets.length,
    };
  } catch (e) {
    return { error: why(e) };
  }
}

/**
 * The Integrations tab's main-process side (H3): the Core's MCP servers, vault secret names and
 * agent backends, and the three things the operator does to a server from the window. The
 * renderer names a server, and to pin, the hash of the list it showed; the Core refuses a pin
 * whose hash isn't the list as last read.
 */
export const integrations = {
  async info() {
    if (process.platform !== 'win32') return { error: 'The gateway runs in the Core, which runs on Windows only.' };
    try {
      const profile = activeProfile();
      const [servers, secrets, backends] = await Promise.all([core.call('mcp.list', { profile }), core.call('secret.list', { profile }), core.call('backend.list')]);
      // A Core from before H4 has no standing grants: null, and the tab says so.
      const standing = await core.call('standing.list', { profile }).catch(() => null);
      // And none from before H6's memory.
      const memory = await core.call('memory.list', { profile }).catch(() => null);
      const runtimes = await core.call('runtime.list', {}, 15_000).catch(() => null);
      return { servers: serverRows(servers), secrets: secretRows(secrets), backends: backendRows(backends), standing: standing && standingRows(standing, Date.now()), memory: memory && memoryRows(memory), runtimes: runtimes && runtimeRows(runtimes) };
    } catch (e) {
      return { error: /** @type {any} */ (e).code === 'unknown_method' ? 'The Core runs older code than the app: end and run the Houston Core task.' : why(e) };
    }
  },
  // Longer than the gateway's own start timeout, so its reason comes back rather than ours.
  /** @param {unknown} name */
  install: (name) => core.call('mcp.install', { name: serverName(name) }, 180_000).then(() => true),
  /** @param {unknown} name @param {unknown} hash */
  pin: (name, hash) => core.call('mcp.pin', { name: serverName(name), hash: toolsHashArg(hash) }).then(() => true),
  /** @param {unknown} name */
  disable: (name) => core.call('mcp.disable', { name: serverName(name) }).then(() => true),
  // A standing grant, by id: refuse its scheduled runs, or let them start again (Stop All pauses them all).
  /** @param {unknown} id */
  pauseGrant: (id) => core.call('standing.pause', { id: standingId(id) }).then(() => true),
  /** @param {unknown} id */
  resumeGrant: (id) => core.call('standing.resume', { id: standingId(id) }).then(() => true),
  // A memory item an agent proposed: serve it to the profile's sessions, or keep it out.
  /** @param {unknown} id @param {unknown} decision */
  reviewMemory: (id, decision) => core.call('memory.review', { id: memoryId(id), decision: memoryDecision(decision) }).then(() => true),
};

/**
 * @param {{
 *   terminals: import('./terminal.js').Terminals,
 *   send: (channel: string, ...args: unknown[]) => void,
 *   workspace: () => { id: string, folder: string },
 * }} opts
 */
export function createAgents({ terminals, send, workspace }) {
  const changed = () => send('agents:changed');

  /** @param {unknown} v @param {string} what */
  const id = (v, what) => {
    if (typeof v !== 'string' || !v || v.length > 100) throw new Error(`${what} is an id`);
    return v;
  };

  /**
   * Show a running session in a terminal tab. Returns the tab's terminal id; when a tab already
   * shows it, that one's, for the renderer to bring forward.
   * @param {string} session @param {string} [label] the tab's title
   * @returns {Promise<{ terminal: number }>}
   */
  async function open(session, label) {
    const shown = terminals.bySession(session);
    if (shown !== undefined) return { terminal: shown };
    /** @type {{ data: (d: string) => void, exit: (code: number | null, reason: string) => void } | null} */
    let tab = null;
    const early = [];
    const a = await attachSession(dataDir(), session, {
      onData: (d) => (tab ? tab.data(d) : early.push(d)),
      onEnd: (e) => { tab?.exit(e.exitCode, e.reason === 'detached' ? 'detached from the Core' : `session ended: ${e.reason}`); changed(); },
    });
    const s = (await core.call('session.list')).find((/** @type {any} */ x) => x.id === session);
    tab = terminals.adopt({
      write: (d) => a.write(d),
      resize: (cols, rows) => a.resize(rows, cols),
      // Closing the tab stops the session, like closing any other terminal.
      kill: () => { a.close(); core.call('session.stop', { id: session }).catch(() => {}).finally(changed); },
      // The Core keeps paths with forward slashes; the tab shows the Windows spelling.
    }, { cwd: (s?.workspace ?? '').replaceAll('/', '\\'), ws: workspace().id, agent: label || s?.identity || 'agent', session });
    // The tab first, then what arrived while it was being made (the replayed tail, mostly).
    send('term:opened', tab.info);
    for (const d of early) tab.data(d);
    return { terminal: tab.info.id };
  }

  return {
    /** What the tab lists, or why it can't. */
    async info() {
      if (process.platform !== 'win32') return { error: 'Agents run in Windows containers, so the Core runs on Windows only.' };
      try {
        const [identities, sessions, backends] = await Promise.all([core.call('identity.list', { profile: activeProfile() }), core.call('session.list'), core.call('backend.list')]);
        const rows = agentRows(identities, sessions, backends);
        for (const r of rows) for (const s of /** @type {any[]} */ (r.sessions)) s.shown = terminals.bySession(s.id) !== undefined;
        return { folder: workspace().folder, rows };
      } catch (e) {
        return { error: why(e) };
      }
    },

    /**
     * The Logs tab: the Core's audit events, newest first, filtered by identity, session and
     * decision, with the choices for those filters. @param {unknown} filter
     */
    async logs(filter) {
      if (process.platform !== 'win32') return { error: "The audit log is the Core's, and the Core runs on Windows only." };
      const f = logFilter(filter);
      try {
        const [found, identities, starts] = await Promise.all([
          core.call('audit.query', f), core.call('identity.list', { profile: activeProfile() }), core.call('audit.query', { type: 'session.start', limit: 50 }),
        ]);
        // ponytail: filtered after the query, so a page can come back short; a profile filter in audit.query if that matters.
        const mine = new Set(identities.map((/** @type {any} */ i) => i.id));
        const ours = (/** @type {any} */ e) => !e.identity?.subject || mine.has(e.identity.subject);
        return {
          events: found.events.filter(ours).reverse(), truncated: found.truncated,
          identities: identities.map((/** @type {any} */ i) => ({ id: i.id, name: i.displayName })),
          sessions: sessionChoices(starts.events.filter(ours)),
        };
      } catch (e) {
        return { error: why(e) };
      }
    },

    /** Start a contained session for an identity in the active workspace's folder, and show it. @param {unknown} identity */
    async start(identity) {
      const who = id(identity, 'identity');
      const { folder } = workspace();
      if (!folder) throw new Error('This workspace has no folder. Switch to one that does, or add one from Files.');
      const me = /** @type {any} */ (await core.call('identity.get', { id: who }));
      if ((me.profile ?? 'default') !== activeProfile()) throw new Error(`${me.displayName} belongs to profile ${me.profile}; switch to it from the 🧭 menu to start it.`);
      const s = await core.call('session.start', {
        identity: who, workspace: folder, size: { rows: 30, columns: 120 },
        ...(me.backend ? {} : { command: SHELL_COMMAND }),
        program: { pathDirs: toolchainPath(process.env.PATH ?? '', { home: os.homedir(), systemRoot: process.env.SystemRoot ?? 'C:\\Windows' }) },
      }, 60_000);
      changed();
      return open(s.id, me.displayName);
    },

    /** @param {unknown} session */
    open: (session) => open(id(session, 'session')),

    /**
     * Move an identity along its lifecycle, or mark it reviewed. The Core checks the move; suspending
     * or retiring ends its sessions there. @param {unknown} identity @param {unknown} action
     */
    async lifecycle(identity, action) {
      const who = id(identity, 'identity');
      if (typeof action !== 'string' || !Object.hasOwn(LIFECYCLE, action)) throw new Error(`action is one of ${Object.keys(LIFECYCLE).join(', ')}`);
      const r = await core.call(LIFECYCLE[/** @type {keyof typeof LIFECYCLE} */ (action)], { id: who });
      changed();
      return r;
    },

    /** @param {unknown} session */
    async stop(session) {
      const r = await core.call('session.stop', { id: id(session, 'session') });
      changed();
      return r;
    },
  };
}
