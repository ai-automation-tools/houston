// The Integrations tab's logic: the Core's MCP server registrations, vault secret names and agent
// backends, shaped for the window. The Core decides; this says what each row shows and which of
// install, pin and disable it offers. No Node imports: the browser demo loads it too.
//
// The window names a server (and, to pin, the hash of the list it showed) and nothing else.
// Registering a server and setting a secret stay with `npm run ctl`: no command line or secret
// value travels through the window (core/README.md, MCP gateway and Vault).

/** A server's name, as core/gateway.js SERVER_NAME. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * @typedef {{ name: string, description?: string }} Tool
 * @typedef {{ name: string, identity: string, transport: 'container' | 'host' | 'http', command: string | null, url?: string,
 *   env: Record<string, string>, pathDirs: string[], state: string, tools: Tool[] | null, toolsHash: string | null, pinnedHash: string | null }} Server
 * @typedef {'install' | 'pin' | 'disable'} Act
 * @typedef {{ act: Act, label: string, title: string }} Action
 * @typedef {{ name: string, state: string, tone: 'ready' | 'idle' | 'exited', icon: string, where: string, sub: string,
 *   runs: string, env: string[], tools: Tool[], showTools: boolean, hash: string | null, actions: Action[] }} ServerRow
 */

/** @param {unknown} name the renderer's; must be a server name */
export function serverName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('That is not an MCP server name.');
  return name;
}

/** @param {unknown} hash the renderer's; must be a tools hash */
export function toolsHashArg(hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('That is not a tool list hash.');
  return hash;
}

/**
 * One row per registration, servers needing a decision first (needs review, then read but not
 * pinned), then by name. A row lists the tools the operator would be pinning; a pinned one
 * shows only how many it serves.
 * @param {Server[]} servers mcp.list's answer
 * @returns {ServerRow[]}
 */
export function serverRows(servers) {
  const order = ['needs_review', 'installed', 'discovered', 'pinned', 'disabled'];
  return servers
    .map((s) => {
      const n = s.tools?.length ?? 0;
      const tools = `${n} tool${n === 1 ? '' : 's'}`;
      const http = s.transport === 'http';
      const read = { act: /** @type {Act} */ ('install'), label: s.state === 'discovered' ? 'Install' : 'Read again',
        title: http ? `Connect to ${s.url} and read its tools` : `Run it once ${s.transport === 'host' ? 'on the host' : 'in its container'}, as ${s.identity}, and read its tools` };
      const pin = { act: /** @type {Act} */ ('pin'), label: s.state === 'disabled' ? 'Enable' : `Pin ${tools}`, title: `Serve these ${tools} to sessions whose identities are granted them` };
      const off = { act: /** @type {Act} */ ('disable'), label: 'Disable', title: 'No session gets its tools; calls are refused at once' };
      const by = /** @type {Record<string, { sub: string, tone: ServerRow['tone'], icon: string, actions: Action[] }>} */ ({
        discovered: { sub: 'registered: Install runs it once to read its tools', tone: 'idle', icon: '○', actions: [read] },
        installed: { sub: `${tools} read: pin them to serve sessions`, tone: 'idle', icon: '◐', actions: [pin, read, off] },
        pinned: { sub: `${tools} served`, tone: 'ready', icon: '●', actions: [read, off] },
        needs_review: { sub: `its tools changed (${tools} now): review them and pin again; calls are refused until then`, tone: 'exited', icon: '⚠', actions: [pin, off] },
        disabled: { sub: 'disabled', tone: 'exited', icon: '■', actions: s.toolsHash ? [pin, read] : [read] },
      })[s.state] ?? { sub: s.state, tone: 'exited', icon: '?', actions: [] };
      return {
        name: s.name, state: s.state, tone: by.tone, icon: by.icon, sub: by.sub, actions: by.actions,
        where: http ? 'http · unconfined' : s.transport === 'host' ? 'host · unconfined' : 'contained',
        runs: http ? s.url ?? '' : s.command ?? '',
        env: Object.entries(s.env ?? {}).map(([k, v]) => `${k} = ${v}`),
        tools: s.tools ?? [], showTools: ['installed', 'needs_review'].includes(s.state), hash: s.toolsHash,
      };
    })
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.name.localeCompare(b.name));
}

/**
 * @param {{ name: string, created_at: string, updated_at: string, last_used_at: string | null }[]} secrets secret.list's answer: names and dates, never values
 * @param {(iso: string) => string} [date]
 */
export function secretRows(secrets, date = (iso) => new Date(iso).toLocaleDateString()) {
  return secrets.map((s) => ({
    name: s.name,
    sub: `set ${date(s.updated_at)} · ${s.last_used_at ? `last given to a server ${date(s.last_used_at)}` : 'never given to a server'}`,
  }));
}

/** @param {{ name: string, displayName: string, installed: boolean, signIn: string, hosts?: string[] }[]} backends backend.list's answer */
export function backendRows(backends) {
  return backends.map((b) => ({
    name: b.displayName, installed: b.installed, sub: b.installed ? 'installed' : 'not installed on this machine',
    title: [b.name, b.hosts?.length ? `Reaches ${b.hosts.join(', ')}` : '', b.signIn && `First time: ${b.signIn}`].filter(Boolean).join('\n'),
  }));
}
