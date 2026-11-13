// The Agents tab's logic: which identities it lists and what each row offers. The Core decides
// what a session may do; this only shapes what the window shows and asks for. No Node imports:
// the browser demo loads it too. The toolchain PATH rule is main's, in toolchain.js.

/**
 * What an identity with no backend runs: a plain contained shell. Fixed here, so no IPC message
 * names a command (the same rule as shells.js).
 */
export const SHELL_COMMAND = 'cmd.exe /d /q /k';

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
