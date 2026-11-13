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

/** A memory item's id: a UUID (core/memory.js). @param {unknown} id */
export function memoryId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('That is not a memory item id.');
  return id;
}

/** @param {unknown} d the renderer's; approve or reject */
export function memoryDecision(d) {
  if (d !== 'approve' && d !== 'reject') throw new Error('A memory item is approved or rejected.');
  return d;
}

/**
 * The profile's memory (H6): the items waiting for review, oldest first, each with who wrote it
 * and from which session, and how many are approved. Only approved ones reach a session.
 * @param {{ id: string, text: string, state: string, source: { identity: string, session: string | null }, createdAt: string }[]} list memory.list's answer
 */
export function memoryRows(list) {
  const waiting = list.filter((m) => m.state === 'pending').reverse();
  return {
    approved: list.filter((m) => m.state === 'approved').length,
    waiting: waiting.map((m) => ({
      id: m.id, text: m.text.length > 140 ? `${m.text.slice(0, 139)}…` : m.text,
      sub: `from ${m.source.identity} · ${new Date(m.createdAt).toLocaleString()}`,
      title: [m.text, '', `Written by ${m.source.identity}${m.source.session ? ` in session ${m.source.session}` : ''}.`, 'Approve to serve it to this profile\'s sessions that hold a memory read grant; reject to keep it out.'].join('\n'),
    })),
  };
}

/**
 * The local model runtimes answering now (runtime.list, H6): what each serves, and which agent CLI can use it.
 * @param {{ id: string, name: string, port: number, models: string[], apis: Record<string, boolean> }[]} list
 */
export function runtimeRows(list) {
  const NEEDS = /** @type {const} */ ([['Codex', 'responses'], ['Claude Code', 'messages']]);
  return list.map((r) => {
    const can = NEEDS.filter(([, api]) => r.apis[api]).map(([cli]) => cli);
    return {
      id: r.id, name: `${r.name} :${r.port}`,
      sub: `${r.models.length} model${r.models.length === 1 ? '' : 's'} · ${can.length ? `for ${can.join(' and ')}` : 'no agent CLI can use it yet'}`,
      title: [`${r.name} on 127.0.0.1:${r.port}. APIs: ${Object.entries(r.apis).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}.`,
        `Models: ${r.models.slice(0, 30).join(', ')}${r.models.length > 30 ? ', …' : ''}`,
        `A session uses it with session.start runtime=${r.id} model=<model>; its identity needs net:127.0.0.1:${r.port} (connect).`,
        can.length < NEEDS.length ? `${NEEDS.filter(([, api]) => !r.apis[api]).map(([cli, api]) => `${cli} needs the ${api} API`).join('; ')}: a newer ${r.name} may serve it.` : ''].filter(Boolean).join('\n'),
    };
  });
}

/** A standing grant's id, as core/standing.js STANDING_ID. */
const STANDING = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** @param {unknown} id the renderer's; must be a standing grant id */
export function standingId(id) {
  if (typeof id !== 'string' || !STANDING.test(id)) throw new Error('That is not a standing grant id.');
  return id;
}

/**
 * One row per standing grant (H4), ones that won't run first: who it runs as, for how long, until when,
 * and Pause or Resume. Stop All pauses them all, so Resume is how a scheduled run comes back. Revoked
 * ones are left out; making and approving one stays with ctl.
 * @param {{ id: string, identity: string, workspace: string, command: string, maxMinutes: number, expiresAt: string, status: string,
 *   grantsChanged: boolean, lastRunAt: string | null, running: string | null, containment?: string }[]} list standing.list's answer
 * @param {number} now ms since the epoch
 */
export function standingRows(list, now) {
  return list
    .filter((s) => s.status !== 'revoked')
    .map((s) => {
      const expired = !(Date.parse(s.expiresAt) > now);
      const problem = s.status === 'paused' ? 'paused: no scheduled run starts' : expired ? 'expired' : s.grantsChanged ? "its identity's grants changed: approve it again (ctl)" : '';
      return {
        id: s.id, problem: Boolean(problem),
        icon: s.running ? '●' : problem ? '⏸' : '⏱',
        tone: /** @type {'ready' | 'idle' | 'exited'} */ (s.running ? 'ready' : problem ? 'exited' : 'idle'),
        sub: problem || `${s.containment === 'unconfined' ? '⚠ unconfined · ' : ''}${s.identity} · up to ${s.maxMinutes} min${s.running ? ' · running now' : ''}`,
        title: [`${s.id}: runs ${s.identity}, unattended, in ${s.workspace}${s.containment === 'unconfined' ? ', unconfined: a broad-access identity, outside any container' : ''}`, s.command, `Budget ${s.maxMinutes} min; expires ${new Date(s.expiresAt).toLocaleString()}`,
          s.lastRunAt ? `Last run ${new Date(s.lastRunAt).toLocaleString()}` : 'Not run yet', `A task runs it with: harness run --grant ${s.id}`].join('\n'),
        actions: s.status === 'paused'
          ? [{ act: /** @type {'resume'} */ ('resume'), label: 'Resume', title: 'Let scheduled runs start again' }]
          : [{ act: /** @type {'pause'} */ ('pause'), label: 'Pause', title: 'Refuse scheduled runs until resumed; a run going now carries on' }],
      };
    })
    .sort((a, b) => Number(b.problem) - Number(a.problem) || a.id.localeCompare(b.id));
}
