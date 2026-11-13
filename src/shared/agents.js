// The Agents tab's logic: which identities it lists and what each row offers, and the toolchain
// folders a contained session gets on its PATH. The Core decides what a session may do; this
// only shapes what the window shows and asks for.

import path from 'node:path';

/**
 * What an identity with no backend runs: a plain contained shell. Fixed here, so no IPC message
 * names a command (the same rule as shells.js).
 */
export const SHELL_COMMAND = 'cmd.exe /d /q /k';

/**
 * The operator's PATH folders a contained session may search, after the Windows ones the Core
 * puts first: absolute, outside the users folder (denied to every session) and outside the
 * Windows folder (already there). Adding a folder to PATH grants nothing: the container still
 * reads only what its policy allows, and Windows' program folders are readable to it already.
 *
 * @param {string} PATH
 * @param {{ home: string, systemRoot: string }} where
 * @returns {string[]}
 */
export function toolchainPath(PATH, { home, systemRoot }) {
  const w = path.win32;
  const key = (/** @type {string} */ p) => w.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  const users = key(w.dirname(home));
  const sys = key(systemRoot);
  const under = (/** @type {string} */ k, /** @type {string} */ parent) => k === parent || k.startsWith(`${parent}\\`);
  const seen = new Set();
  return PATH.split(';').map((p) => p.trim()).filter((p) => {
    // A drive-absolute path only: not relative, not \\server, no variables left unexpanded.
    if (!/^[A-Za-z]:[\\/]/.test(p) || /[%"]/.test(p)) return false;
    const k = key(p);
    if (under(k, users) || under(k, sys) || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((p) => w.normalize(p).replace(/[\\/]+$/, ''));
}

/**
 * @typedef {{ id: string, kind: string, displayName: string, backend: string | null, status: string, containment: string }} Identity
 * @typedef {{ id: string, identity: string, workspace: string, startedAt: string }} Session
 * @typedef {{ name: string, displayName: string, installed: boolean, signIn: string }} Backend
 * @typedef {{ id: string, name: string, status: string, what: string, canStart: boolean, why: string, signIn: string, sessions: Session[] }} AgentRow
 */

/**
 * One row per identity that could run: not the operator, not retired. Active ones first, then
 * by name. A row can start a session when the identity is active, contained, and its backend
 * (if any) is installed; otherwise `why` says what's missing.
 *
 * @param {Identity[]} identities
 * @param {Session[]} sessions running now
 * @param {Backend[]} backends
 * @returns {AgentRow[]}
 */
export function agentRows(identities, sessions, backends) {
  return identities
    .filter((i) => i.kind !== 'operator' && i.status !== 'retired')
    .map((i) => {
      const b = i.backend ? backends.find((x) => x.name === i.backend) : null;
      const why = i.status !== 'active' ? `${i.status}: activate it to start a session`
        : i.containment !== 'container' ? `runs ${i.containment}, which this build can't start yet`
          : i.backend && !b ? `unknown backend ${i.backend}`
            : b && !b.installed ? `${b.displayName} is not installed`
              : '';
      return {
        id: i.id, name: i.displayName, status: i.status,
        what: b ? b.displayName : i.backend ?? 'contained shell',
        canStart: !why, why, signIn: b?.signIn ?? '',
        sessions: sessions.filter((s) => s.identity === i.id),
      };
    })
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name));
}
