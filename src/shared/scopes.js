// The Settings page (SET-07): every control Houston and its Core have, what it is set to now, its
// scope, and where it's changed. The scopes and their rules are harness-requirements.md's scope
// table. Read-only on purpose: each control keeps the one place it's changed, and this page says
// where. No DOM; main gathers the snapshot and serves the page (acc://settings/).

export const SETTINGS_URL = 'acc://settings/';

/** @typedef {'global' | 'profile' | 'workspace' | 'session'} Scope */

/** @type {Record<Scope, { label: string, rule: string }>} */
export const SCOPES = {
  global: { label: 'Global', rule: 'One per install. No profile, workspace or grant overrides it.' },
  profile: { label: 'Profile', rule: 'Belongs to a profile and is never seen from another. Profiles come in H5; until then there is one, so these apply to this install.' },
  workspace: { label: 'Workspace', rule: 'Saved with each workspace and restored when it opens. Shown for the active workspace.' },
  session: { label: 'Session', rule: 'Lives as long as one agent session, and dies with it.' },
};

/**
 * What main knows when the page is asked for. Every field is plain data; a missing Core is
 * `core: { error }`, and off Windows `core: null`.
 * @typedef {{
 *   hubUrl: string, hubToken: 'none' | 'sent' | 'withheld', quickLinks: number, newsSources: number, bookmarkSource: string,
 *   adBlock: boolean, closeToTray: boolean,
 *   chat: { model: string, missing: string[] },
 *   cronsole: { configured: boolean, ui: string },
 *   mcpUrl: string,
 *   workspaces: number,
 *   workspace: { name: string, folder: string, tabs: number, terminals: number },
 *   core: null | { error: string } | {
 *     dir: string, sessions: number, identities: number, grants: number, askGrants: number, approvals: number,
 *     limits: { approvalSeconds: number, transcriptBytes: number, sessionTranscriptBytes: number },
 *     mcp?: null | { servers: number, pinned: number, review: number },  null: a Core from before the gateway
 *     secrets?: null | number,
 *   },
 * }} Snapshot
 */

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** @param {number} b */
function size(b) {
  if (b >= 1024 ** 3 && b % 1024 ** 3 === 0) return `${b / 1024 ** 3} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

/**
 * Every control as a row: name, scope, value now, where it's changed.
 * @param {Snapshot} s
 * @returns {{ label: string, scope: Scope, value: string, where: string }[]}
 */
export function controls(s) {
  const core = s.core && !('error' in s.core) ? s.core : null;
  const noCore = s.core === null ? 'no Core on this system (Windows only)' : s.core && 'error' in s.core ? `Core not reachable: ${s.core.error}` : '';
  const fromCore = (/** @type {(c: NonNullable<typeof core>) => string} */ f) => (core ? f(core) : noCore);
  return [
    // Global: one per install.
    { label: 'Hard denies', scope: 'global', value: 'your user profile and its credential folders, the Core\'s own data, other private trees', where: 'Fixed in the Core (core/policy.js, launch defaults); no grant overrides them' },
    { label: 'Stop All', scope: 'global', value: 'Ctrl+Shift+Backspace, the ⏹ button on the address bar, the tray menu', where: 'Fixed; it ends every agent session the Core runs' },
    { label: 'Audit log', scope: 'global', value: fromCore((c) => `${c.dir}\\audit`), where: 'Written by the Core only, hash-chained; read it in the Logs tab' },
    { label: 'Transcript limits', scope: 'global', value: fromCore((c) => `${size(c.limits.sessionTranscriptBytes)} a session, ${size(c.limits.transcriptBytes)} in all, oldest deleted first`), where: 'Core defaults (core/transcripts.js)' },
    { label: 'Approval timeout', scope: 'global', value: fromCore((c) => `an unanswered card denies after ${c.limits.approvalSeconds} s`), where: 'Core default (core/approvals.js)' },
    { label: 'MCP server', scope: 'global', value: s.mcpUrl || 'not running', where: 'Fixed: loopback only, a new token at every launch' },
    { label: 'Close to tray', scope: 'global', value: s.closeToTray ? 'on' : 'off', where: 'File menu, or the tray menu' },
    // Profile: one profile until H5.
    { label: 'Agent identities and grants', scope: 'profile', value: fromCore((c) => `${count(c.identities, 'identity', 'identities')}, ${count(c.grants, 'grant')} (${c.askGrants} ask)`), where: 'npm run ctl -- identity.* / grant.* (the Identity Center comes in H5); the Agents tab lists them' },
    { label: 'MCP servers (gateway)', scope: 'profile', value: fromCore((c) => (c.mcp ? `${count(c.mcp.servers, 'server')} registered, ${c.mcp.pinned} pinned${c.mcp.review ? `, ${c.mcp.review} need review` : ''}` : 'needs a newer Core')), where: 'npm run ctl -- mcp.add / mcp.install / mcp.pin (an Integrations screen is next); each agent session reaches them through its own gateway, HOUSTON_MCP_URL' },
    { label: 'Secrets (vault)', scope: 'profile', value: fromCore((c) => (typeof c.secrets === 'number' ? `${count(c.secrets, 'secret')} stored; values are never shown` : 'needs a newer Core')), where: 'npm run ctl -- secret.set name=<name> (the value from stdin); only an MCP server with a secret: use grant receives one' },
    { label: 'Project Hub', scope: 'profile', value: `${s.hubUrl}${s.hubToken === 'sent' ? ', with its access token' : s.hubToken === 'withheld' ? ', access token withheld (plain http to another machine)' : ''}`, where: 'settings.json hubUrl, or ACC_HUB_URL in .env; its access token is ACC_HUB_TOKEN in .env' },
    { label: 'Workspaces', scope: 'profile', value: count(s.workspaces, 'workspace'), where: 'The 🧭 Houston menu; add one by right-clicking a folder in Files' },
    { label: 'Bookmarks source', scope: 'profile', value: s.bookmarkSource || 'the first browser found', where: 'The picker at the top of the Bookmarks tab' },
    { label: 'Quick links', scope: 'profile', value: count(s.quickLinks, 'link'), where: 'settings.json quickLinks' },
    { label: 'News sources', scope: 'profile', value: count(s.newsSources, 'source'), where: 'settings.json newsSources' },
    { label: 'Ad blocking', scope: 'profile', value: s.adBlock ? 'on' : 'off', where: 'Extensions menu' },
    { label: 'Chat', scope: 'profile', value: s.chat.missing.length ? `off: ${s.chat.missing.join(', ')} not set` : `on, model ${s.chat.model}`, where: '.env: ACC_CHAT_API_KEY (or ANTHROPIC_API_KEY) and ACC_CHAT_MODEL; the key never leaves the main process' },
    { label: 'Cronsole', scope: 'profile', value: s.cronsole.configured ? `connected${s.cronsole.ui ? `, UI at ${s.cronsole.ui}` : ''}` : 'not set', where: '.env: ACC_CRONSOLE_MCP and ACC_CRONSOLE_UI' },
    // Workspace: the active one.
    { label: 'Folder', scope: 'workspace', value: s.workspace.folder || 'none', where: 'Set when the workspace is added; agent sessions start here' },
    { label: 'Tabs, terminals and conversations', scope: 'workspace', value: `${count(s.workspace.tabs, 'tab')}, ${count(s.workspace.terminals, 'terminal')}`, where: 'Saved as you work and restored when the workspace opens' },
    // Session.
    { label: 'Allow once, allow for this session', scope: 'session', value: fromCore((c) => `${count(c.approvals, 'card')} waiting`), where: 'The approval bar above the terminals; never carried to another session' },
    { label: 'Running agent sessions', scope: 'session', value: fromCore((c) => count(c.sessions, 'session')), where: 'The Agents tab; each has its own frozen copy of its grants' },
  ];
}

/**
 * The page body: the precedence rule, then a table per scope.
 * @param {Snapshot} s @param {(t: string) => string} esc HTML escaping
 */
export function settingsBody(s, esc) {
  const rows = controls(s);
  const tables = /** @type {Scope[]} */ (Object.keys(SCOPES)).map((scope) => {
    const mine = rows.filter((r) => r.scope === scope);
    const title = scope === 'workspace' ? `${SCOPES[scope].label}: ${s.workspace.name}` : SCOPES[scope].label;
    return `<h2>${esc(title)}</h2><p class="note">${esc(SCOPES[scope].rule)}</p>`
      + '<table><thead><tr><th>Control</th><th>Now</th><th>Changed in</th></tr></thead><tbody>'
      + mine.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}</td><td>${esc(r.where)}</td></tr>`).join('')
      + '</tbody></table>';
  });
  return '<h1>Settings</h1><p class="note">Every control, what it is now, its scope and where to change it. '
    + 'When two scopes disagree: a global deny wins, then any explicit deny, then the narrowest matching allow; no allow means deny.</p>'
    + tables.join('');
}
