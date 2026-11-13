// The Agents tab's main-process side: identities and running sessions from the Core, and a
// contained session shown as a terminal tab. Houston only asks: the Core checks the identity,
// its grants and the workspace, and refuses with a reason the tab shows (ADR-004).
//
// The renderer names an identity or a session id and nothing else. The folder is the active
// workspace's, the command is the identity's backend manifest or the fixed SHELL_COMMAND, and
// PATH gets the operator's toolchain folders (toolchainPath), which grants nothing.

import os from 'node:os';
import { attachSession, dataDir } from '../../core/client.js';
import { SHELL_COMMAND, agentRows, toolchainPath } from '../shared/agents.js';
import { docPage, escapeHtml } from '../shared/docs.js';
import { logFilter, sessionChoices, transcriptBody, transcriptIdFromUrl } from '../shared/logs.js';
import { core } from './core.js';

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

/**
 * The Core's part of the Settings page: its data folder, the limits it runs with, and how many
 * identities, grants, waiting cards and sessions it has. Null off Windows.
 * @returns {Promise<import('../shared/scopes.js').Snapshot['core']>}
 */
export async function coreSettings() {
  if (process.platform !== 'win32') return null;
  try {
    const [status, identities, approvals] = await Promise.all([core.call('core.status', {}, 3000), core.call('identity.list'), core.call('approval.list')]);
    if (!status.limits) return { error: 'it runs older code than the app; end and run the Houston Core task' };
    const grants = identities.flatMap((/** @type {any} */ i) => i.grants ?? []);
    return {
      dir: dataDir(), sessions: status.sessions, identities: identities.length, grants: grants.length,
      askGrants: grants.filter((/** @type {any} */ g) => g.effect === 'ask').length, approvals: approvals.length, limits: status.limits,
    };
  } catch (e) {
    return { error: why(e) };
  }
}

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
        const [identities, sessions, backends] = await Promise.all([core.call('identity.list'), core.call('session.list'), core.call('backend.list')]);
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
          core.call('audit.query', f), core.call('identity.list'), core.call('audit.query', { type: 'session.start', limit: 50 }),
        ]);
        return {
          events: found.events.reverse(), truncated: found.truncated,
          identities: identities.map((/** @type {any} */ i) => ({ id: i.id, name: i.displayName })),
          sessions: sessionChoices(starts.events),
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

    /** @param {unknown} session */
    async stop(session) {
      const r = await core.call('session.stop', { id: id(session, 'session') });
      changed();
      return r;
    },
  };
}
