// The demo's stand-in for the Houston Core: made-up agent identities and grants, one session
// already running, contained terminal tabs, the approval inbox, the audit log, transcripts and
// the Settings page, the Identity Center and the Integrations tab. It runs the window's own rules (src/shared/agents.js, logs.js, scopes.js,
// approvals.js) on fabricated state, in the browser tab. Nothing runs, nothing is fetched.

import { agentRows } from '../shared/agents.js';
import { backendRows, memoryRows, secretRows, serverName, serverRows, standingId, standingRows } from '../shared/integrations.js';
import { escapeHtml } from '../shared/docs.js';
import { logFilter, sessionChoices, transcriptBody, transcriptIdFromUrl } from '../shared/logs.js';
import { SETTINGS_URL, settingsBody } from '../shared/scopes.js';
import { IDENTITIES_URL, identitiesBody } from '../shared/identities.js';

const WS = 'D:/work/acme-api';
const MIN = 60_000;
const APPROVAL_MS = 120_000;
// Made up, and assembled here so no scanner mistakes the source for a leak.
const FAKE_KEY = ['sk', 'ant', 'demo03', 'Xq7dL2mPz9WvK4nR8tYb1cHs6Fg0Jk5Ue3'].join('-');

/** @param {string} resource @param {string} permission @param {'allow' | 'ask'} [effect] */
let grantN = 0;
const grant = (resource, permission, effect = 'allow') => ({
  id: `g-${++grantN}`, resource, permission, effect, grantedAt: '2026-11-12T09:00:00Z', grantedBy: 'local:operator', expiresAt: null, lastUsedAt: null,
});
/** The rest of an identity's record, as the Core's identity.list has it. @param {object} i @param {string | null} [reviewBy] */
const ident = (i, reviewBy = null) => ({
  owner: 'local:operator', parent: null, purpose: null, createdAt: '2026-11-12T09:00:00Z', lastUsedAt: null, expiresAt: null, retiredAt: null, tags: [],
  reviewedAt: reviewBy && '2026-08-15T09:00:00Z', reviewBy, ...i,
});
// Every folder no grant opens, as policy.js globalDenies() lists them (made up; only the count is shown).
const ALWAYS_DENIED = ['core-data', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'GitHub CLI', '.git-credentials', '_netrc', 'Protect', 'Credentials', 'Credentials (Local)', 'Vault'];
const IDENTITIES = [
  ident({ id: 'local:operator', kind: 'operator', displayName: 'You', owner: null, status: 'active', containment: 'unconfined', backend: null, grants: [] }),
  ident({ id: 'local:dev-claude', kind: 'ai-agent', displayName: 'Dev Claude', status: 'active', containment: 'container', backend: 'claude-code', purpose: 'Day-to-day work in acme-api',
    grants: [grant(`file:${WS}/**`, 'write'), grant('net:api.anthropic.com:443', 'connect'), grant('net:registry.npmjs.org:443', 'connect', 'ask')] }, '2027-01-20T09:00:00Z'),
  ident({ id: 'local:build-shell', kind: 'ai-agent', displayName: 'Build shell', status: 'active', containment: 'container', backend: null, purpose: 'npm ci and the test suite',
    grants: [grant(`file:${WS}/**`, 'write'), grant('net:registry.npmjs.org:443', 'connect'), grant('net:example.com:443', 'connect', 'ask')] }, '2026-11-01T09:00:00Z'),
  ident({ id: 'local:review-codex', kind: 'ai-agent', displayName: 'Review Codex', status: 'suspended', containment: 'container', backend: 'codex',
    grants: [grant(`file:${WS}/**`, 'read'), grant('net:chatgpt.com:443', 'connect')] }),
];
const BACKENDS = [
  { name: 'claude-code', displayName: 'Claude Code', hosts: ['api.anthropic.com:443'], signIn: 'Run /login in the session, once; it signs in to a home of its own.', installed: true },
  { name: 'codex', displayName: 'Codex', hosts: ['chatgpt.com:443'], signIn: 'Sign in with ChatGPT in the session, once.', installed: true },
];
const hash = (/** @type {string} */ c) => c.repeat(64);
const tool = (/** @type {string} */ name, /** @type {string} */ description) => ({ name, description });
const HOUSTON_TOOLS = [tool('list_tabs', 'The open browser tabs.'), tool('open_tab', 'Open a URL in a new tab.'), tool('terminal_run', 'Run a command in a terminal, after the user clicks Run.')];
const GITHUB_TOOLS = [tool('list_issues', 'List issues in a repository.'), tool('create_pull_request', 'Open a pull request.')];
const CRONSOLE_TOOLS = [tool('list_tasks', 'List scheduled tasks.'), tool('run_task', 'Run a task now.'), tool('get_task_history', "A task's recent runs.")];
/** Made-up registrations: the app's own server, a contained one, and one read but not yet pinned. */
const SERVERS = () => [
  { name: 'houston', identity: 'local:mcp/houston', transport: 'http', url: 'http://127.0.0.1:52011/mcp', command: null, env: { Authorization: 'Bearer secret:houston-mcp' }, pathDirs: [], state: 'pinned', tools: HOUSTON_TOOLS, toolsHash: hash('a'), pinnedHash: hash('a') },
  { name: 'github', identity: 'local:mcp/github', transport: 'container', command: '"C:\\Program Files\\nodejs\\node.exe" D:\\mcp\\github\\dist\\index.js', env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'secret:github-token' }, pathDirs: ['C:\\Program Files\\nodejs'], state: 'pinned', tools: GITHUB_TOOLS, toolsHash: hash('b'), pinnedHash: hash('b') },
  { name: 'cronsole', identity: 'local:mcp/cronsole', transport: 'host', command: '"C:\\Program Files\\nodejs\\node.exe" D:\\work\\cronsole\\mcp-server\\dist\\index.js', env: { CRONSOLE_TOKEN: 'secret:cronsole-token' }, pathDirs: ['C:\\Program Files\\nodejs'], state: 'installed', tools: CRONSOLE_TOOLS, toolsHash: hash('c'), pinnedHash: null },
];
const SECRETS = [
  { name: 'cronsole-token', created_at: '2026-11-12T09:00:00Z', updated_at: '2026-11-12T09:00:00Z', last_used_at: null },
  { name: 'github-token', created_at: '2026-11-12T09:00:00Z', updated_at: '2026-11-12T09:00:00Z', last_used_at: '2026-11-13T08:00:00Z' },
  { name: 'houston-mcp', created_at: '2026-11-12T09:00:00Z', updated_at: '2026-11-13T08:00:00Z', last_used_at: '2026-11-13T08:05:00Z' },
];
/** @param {string} id */
const nameOf = (id) => IDENTITIES.find((i) => i.id === id)?.displayName ?? id;

/**
 * @typedef {{ id: number, print: (text: string) => void, end: (reason: string) => void }} DemoTerm
 * @typedef {{ id: string, identity: string, workspace: string, startedAt: string, term: DemoTerm | null, allowed: Set<string>, text: string }} DemoSession
 */

/**
 * @param {{
 *   now: () => number,
 *   emit: (name: string, ...args: unknown[]) => void,
 *   openTerminal: (o: { label: string, session: string, cwd: string, handle: (line: string) => string | Promise<string>, onClose: () => void }) => DemoTerm,
 *   fallback: (line: string) => string,
 *   approvalAfterMs?: number | null,
 * }} o fallback: the plain demo terminal's answers, for any other command
 */
export function demoHarness({ now, emit, openTerminal, fallback, approvalAfterMs = null }) {
  const iso = (/** @type {number} */ t = now()) => new Date(t).toISOString();
  let n = 0;
  const newId = () => `0d3m0000-${String(++n).padStart(4, '0')}-4a1e-9c2b-${String(now()).slice(-12).padStart(12, '0')}`;

  /** @type {any[]} */
  const events = [];
  /** @param {string} type @param {string} who @param {string | null} session @param {string} action @param {{ type: string, id: string }} resource @param {'allow' | 'ask' | 'deny'} result @param {string[]} reasons @param {object} [extra] @param {number} [at] */
  const event = (type, who, session, action, resource, result, reasons, extra = {}, at = now()) => {
    events.push({ schema: 'houston.audit/v0.1', event_id: `demo-${events.length + 1}`, time: iso(at), type, identity: { subject: who, containment: who === 'local:operator' ? undefined : 'container' },
      session_id: session, action, resource, decision: { result, policy_version: 'demo', reasons }, ...extra });
  };

  /** @type {Map<string, DemoSession>} */
  const sessions = new Map();
  /** @type {any[]} */
  const pending = [];
  /** @type {Map<string, (answer: string) => void>} */
  const waiting = new Map();
  const approvalsChanged = () => emit('approvals', [...pending]);
  const agentsChanged = () => emit('agents');

  // History before the demo opened: an ended session, with a refusal and an answered ask.
  const past = newId();
  const t0 = now() - 3 * 60 * MIN;
  event('session.start', 'local:build-shell', past, 'session.start', { type: 'Session', id: past }, 'allow', ['grants compiled'], {}, t0);
  event('egress.connect', 'local:build-shell', past, 'net.connect', { type: 'Host', id: 'registry.npmjs.org:443' }, 'allow', ['grant net:registry.npmjs.org:443'], {}, t0 + 2 * MIN);
  event('egress.connect', 'local:build-shell', past, 'net.connect', { type: 'Host', id: 'pastebin.com:443' }, 'deny', ['no grant for this host'], {}, t0 + 4 * MIN);
  event('session.end', 'local:build-shell', past, 'session.end', { type: 'Session', id: past }, 'allow', ['exit 0'], { outcome: { status: 'ok' } }, t0 + 9 * MIN);
  /** @type {Map<string, string>} */
  const transcripts = new Map([[past, `# session ${past} · local:build-shell · ${WS} · started ${iso(t0)}\n${WS.replaceAll('/', '\\')}>npm ci\nadded 214 packages in 9s\n${WS.replaceAll('/', '\\')}>curl.exe -sS https://pastebin.com/\ncurl: (56) CONNECT tunnel failed, response 403\n${WS.replaceAll('/', '\\')}>type .env\nANTHROPIC_API_KEY=[REDACTED:anthropic-key]\n# ended: exit 0\n`]]);

  /** @param {string} identity @param {number} [at] */
  function startSession(identity, at = now()) {
    const id = newId();
    const s = { id, identity, workspace: WS, startedAt: iso(at), term: null, allowed: new Set(), text: '' };
    sessions.set(id, s);
    event('session.start', identity, id, 'session.start', { type: 'Session', id }, 'allow', ['grants compiled'], {}, at);
    transcripts.set(id, `# session ${id} · ${identity} · ${WS} · started ${iso(at)}\n`);
    return s;
  }
  // Dev Claude has been working for a while.
  const running = startSession('local:dev-claude', now() - 25 * MIN);
  transcripts.set(running.id, `${transcripts.get(running.id)}Claude Code · acme-api\n> fix the failing login test\n● Read src/routes.js\n● Edit src/routes.js: compare password hashes with timingSafeEqual\n● Bash npm test: 42 passing\n`);

  /** @param {DemoSession} s @param {string} line what the terminal printed */
  const record = (s, line) => transcripts.set(s.id, `${transcripts.get(s.id) ?? ''}${line}\n`);

  /** A network request from a session: allowed, held for the operator, or refused. @param {DemoSession} s @param {string} host */
  function connect(s, host) {
    const g = IDENTITIES.find((i) => i.id === s.identity)?.grants.find((x) => x.resource === `net:${host}`);
    const resource = { type: 'Host', id: host };
    if (g?.effect === 'allow' || s.allowed.has(host)) {
      event('egress.connect', s.identity, s.id, 'net.connect', resource, 'allow', [g?.effect === 'allow' ? `grant net:${host}` : 'allowed for this session']);
      return Promise.resolve(true);
    }
    if (!g) {
      event('egress.connect', s.identity, s.id, 'net.connect', resource, 'deny', ['no grant for this host']);
      return Promise.resolve(false);
    }
    const id = `ap-${events.length + 1}`;
    const card = { id, identity: s.identity, session_id: s.id, workspace: WS.replaceAll('/', '\\'), action: 'net.connect', resource, createdAt: iso(), expiresAt: iso(now() + APPROVAL_MS) };
    event('approval.requested', s.identity, s.id, 'net.connect', resource, 'ask', ['waiting for the operator'], { approval: { id, expires_at: card.expiresAt } });
    pending.push(card);
    approvalsChanged();
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle('timeout'), APPROVAL_MS);
      /** @param {string} answer */
      function settle(answer) {
        clearTimeout(timer);
        waiting.delete(id);
        pending.splice(pending.findIndex((p) => p.id === id), 1);
        const yes = answer === 'once' || answer === 'session';
        if (answer === 'session') s.allowed.add(host);
        const by = answer === 'timeout' || answer === 'session ended' ? 'local:core' : 'local:operator';
        event('approval.decided', s.identity, s.id, 'net.connect', resource, yes ? 'allow' : 'deny', [answer === 'timeout' ? 'no answer in 120 s' : `the operator chose ${answer}`], { approval: { id, answer, by } });
        event('egress.connect', s.identity, s.id, 'net.connect', resource, yes ? 'allow' : 'deny', [yes ? `approved (${answer})` : `denied (${answer})`]);
        approvalsChanged();
        resolve(yes);
      }
      waiting.set(id, settle);
    });
  }

  /** What a contained shell answers. @param {DemoSession} s @param {string} line */
  function handle(s, line) {
    const prompt = `${WS.replaceAll('/', '\\')}>`;
    record(s, `${prompt}${line}`);
    const cmd = line.trim();
    const url = /https?:\/\/([^/\s:]+)(?::(\d+))?/i.exec(cmd);
    if (/^curl(\.exe)?\b/i.test(cmd) && url) {
      const host = `${url[1].toLowerCase()}:${url[2] ?? (/^https/i.test(cmd.slice(url.index)) ? '443' : '80')}`;
      return connect(s, host).then((ok) => {
        const out = ok ? '<!doctype html><html><head><title>Example Domain</title>…' : 'curl: (56) CONNECT tunnel failed, response 403';
        record(s, out);
        return `${out}\r\n`;
      });
    }
    if (/^npm (i|install|ci)\b/i.test(cmd)) {
      return connect(s, 'registry.npmjs.org:443').then((ok) => {
        const out = ok ? 'added 214 packages in 9s' : 'npm error code E403\nnpm error 403 Forbidden - GET https://registry.npmjs.org/express';
        record(s, out);
        return `${out.replaceAll('\n', '\r\n')}\r\n`;
      });
    }
    if (/^(type|cat)\s+\.env$/i.test(cmd)) {
      // Shown on screen as it is; the transcript keeps only the marker.
      record(s, 'ANTHROPIC_API_KEY=[REDACTED:anthropic-key]');
      return `ANTHROPIC_API_KEY=${FAKE_KEY}\r\n\x1b[90m(made up; open this session's transcript in the Logs tab: it was redacted before it was written)\x1b[0m\r\n`;
    }
    if (/^(dir|ls)\s+(%userprofile%|~|c:\\users)/i.test(cmd)) {
      event('file.denied', s.identity, s.id, 'file.read', { type: 'Folder', id: 'C:/Users/dev' }, 'deny', ['the user profile is denied to every session']);
      record(s, 'Access is denied.');
      return 'Access is denied.\r\n';
    }
    if (/^help$/i.test(cmd)) {
      return 'In this contained session:\r\n  curl.exe https://example.com/   an ask grant: a card asks you first\r\n  curl.exe https://pastebin.com/  no grant: refused\r\n  npm install                     needs registry.npmjs.org\r\n  type .env                       a secret, redacted in the transcript\r\n  dir %USERPROFILE%               your profile is out of reach\r\n';
    }
    const out = fallback(line);
    if (out.trim()) record(s, out.replace(/\x1b\[[0-9;]*m/g, '').replaceAll('\r\n', '\n').trimEnd());
    return out;
  }

  /** @param {DemoSession} s */
  function show(s) {
    if (s.term) return s.term.id;
    s.term = openTerminal({
      label: nameOf(s.identity), session: s.id, cwd: WS,
      handle: (line) => handle(s, line),
      onClose: () => { s.term = null; stop(s.id); },
    });
    const replay = (transcripts.get(s.id) ?? '').split('\n').filter((l) => l && !l.startsWith('# ')).join('\r\n');
    s.term.print(`\x1b[90m🛡 ${nameOf(s.identity)} in a container (demo): only ${WS} and its grants. Type help.\x1b[0m\r\n${replay ? `${replay}\r\n` : ''}`);
    agentsChanged();
    return s.term.id;
  }

  /** @param {string} id @param {string} [reason] */
  function stop(id, reason = 'stopped') {
    const s = sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
    for (const p of pending.filter((x) => x.session_id === id)) waiting.get(p.id)?.('session ended');
    event('session.end', s.identity, id, 'session.end', { type: 'Session', id }, 'allow', [reason], { outcome: { status: 'error', error_code: reason } });
    record(s, `# ended: ${reason}`);
    const term = s.term;
    s.term = null;
    term?.end(`session ended: ${reason}`);
    agentsChanged();
    return true;
  }

  // An agent asks for something while the operator watches: the approval card, unprompted.
  if (approvalAfterMs !== null) {
    setTimeout(() => {
      if (!sessions.has(running.id)) return;
      record(running, '● Bash npm install express-rate-limit');
      void connect(running, 'registry.npmjs.org:443').then((ok) => record(running, ok ? 'added 1 package in 2s' : 'npm error 403 Forbidden'));
    }, approvalAfterMs);
  }

  const servers = SERVERS();
  /** @param {unknown} name */
  const server = (name) => {
    const s = servers.find((x) => x.name === serverName(name));
    if (!s) throw new Error(`no MCP server named ${String(name)}`);
    return s;
  };

  /** A made-up standing grant: the Cron tab's nightly backup runs under it. */
  const standing = [{ id: 'nightly-backup', identity: 'local:build-shell', workspace: WS.replaceAll('/', '\\'), command: 'cmd.exe /d /c backup.cmd', pathDirs: [], maxMinutes: 30,
    expiresAt: iso(now() + 60 * 24 * 60 * MIN), status: 'active', grantsChanged: false, lastRunAt: iso(now() - 18 * 60 * MIN), running: null, createdAt: iso(now() - 3 * 24 * 60 * MIN), updatedAt: iso(now() - 3 * 24 * 60 * MIN) }];
  // Profile memory (H6): one an agent proposed, waiting for review, and one already approved.
  const memory = [
    { id: '7d1c2e54-0b7a-4f0e-9a51-3c2d8e6f1a20', text: 'The API project builds with pnpm; npm install breaks its lockfile.', state: 'pending', source: { identity: 'local:dev-claude', session: 'a3f19c' }, createdAt: iso(now() - 40 * MIN) },
    { id: '0e9b6a31-5c4d-4e2f-8b17-6a5d4c3b2a10', text: 'Release notes go in docs/CHANGELOG.md, newest first.', state: 'approved', source: { identity: 'local:operator', session: null }, createdAt: iso(now() - 3 * 24 * 60 * MIN) },
  ];
  /** @param {unknown} id */
  const grantFor = (id) => {
    const g = standing.find((x) => x.id === standingId(id));
    if (!g) throw new Error(`no standing grant ${String(id)}`);
    return g;
  };

  const list = () => [...sessions.values()].map(({ id, identity, workspace, startedAt }) => ({ id, identity, workspace, startedAt }));
  const grants = IDENTITIES.flatMap((i) => i.grants);

  return {
    agents: {
      info: async () => ({ folder: WS.replaceAll('/', '\\'), rows: agentRows(/** @type {any} */ (IDENTITIES), list(), BACKENDS).map((r) => ({ ...r, sessions: r.sessions.map((x) => ({ ...x, shown: Boolean(sessions.get(x.id)?.term) })) })) }),
      start: async (/** @type {string} */ identity) => {
        const i = IDENTITIES.find((x) => x.id === identity);
        if (!i || i.status !== 'active' || i.kind === 'operator') throw new Error(`${identity} can't start: it isn't active`);
        const s = startSession(identity);
        agentsChanged();
        return { terminal: show(s) };
      },
      open: async (/** @type {string} */ id) => {
        const s = sessions.get(id);
        if (!s) throw new Error('no running session has that id');
        return { terminal: show(s) };
      },
      stop: async (/** @type {string} */ id) => { if (!stop(id)) throw new Error('no running session has that id'); return { reason: 'stopped' }; },
      // The Core's lifecycle rules (core/identities.js), on the made-up identities.
      lifecycle: async (/** @type {string} */ identity, /** @type {string} */ action) => {
        const i = /** @type {any} */ (IDENTITIES.find((x) => x.id === identity));
        if (!i || i.kind === 'operator') throw new Error(`no identity ${identity}`);
        if (action === 'review') {
          i.reviewedAt = iso();
          i.reviewBy = iso(now() + 90 * 24 * 60 * MIN);
        } else {
          const to = /** @type {Record<string, string>} */ ({ activate: 'active', suspend: 'suspended', retire: 'retired' })[action];
          const next = /** @type {Record<string, string[]>} */ ({ draft: ['active', 'retired'], active: ['suspended', 'retired'], suspended: ['active', 'retired'], retired: [] })[i.status];
          if (!to || !next.includes(to)) throw new Error(`${identity} is ${i.status}; it can become ${next.join(' or ') || 'nothing else'}`);
          event('identity.lifecycle', 'local:operator', null, `identity.${action}`, { type: 'Identity', id: identity }, 'allow', [], { lifecycle: { from: i.status, to } });
          i.status = to;
          if (to === 'retired') i.retiredAt = iso();
          if (to !== 'active') for (const s of [...sessions.values()]) if (s.identity === identity) stop(s.id);
        }
        agentsChanged();
        return { identity: i };
      },
      stopAll: async () => {
        const ids = [...sessions.keys()];
        event('stop.all', 'local:operator', null, 'stop.all', { type: 'Core', id: 'sessions' }, 'allow', [`${ids.length} running`]);
        ids.forEach((id) => stop(id));
        const r = { stopped: ids.length };
        emit('agents-stopped', r);
        return r;
      },
    },

    integrations: {
      info: async () => ({ servers: serverRows(/** @type {any} */ (servers)), secrets: secretRows(SECRETS), backends: backendRows(BACKENDS), standing: standingRows(standing, now()), memory: memoryRows(memory) }),
      install: async (/** @type {unknown} */ name) => {
        const s = server(name);
        s.state = s.state === 'discovered' ? 'installed' : s.state;
        return true;
      },
      pin: async (/** @type {unknown} */ name) => { const s = server(name); s.state = 'pinned'; s.pinnedHash = s.toolsHash; return true; },
      disable: async (/** @type {unknown} */ name) => { server(name).state = 'disabled'; return true; },
      pauseGrant: async (/** @type {unknown} */ id) => { grantFor(id).status = 'paused'; return true; },
      resumeGrant: async (/** @type {unknown} */ id) => { grantFor(id).status = 'active'; return true; },
      reviewMemory: async (/** @type {unknown} */ id, /** @type {unknown} */ decision) => {
        const m = memory.find((x) => x.id === id);
        if (m) m.state = decision === 'approve' ? 'approved' : 'rejected';
        return true;
      },
    },

    /** The Cron tab's view of a standing grant, as the Core's standing.get. @param {string} id */
    standingGrant: (id) => ({ ...grantFor(id) }),

    approvals: {
      list: async () => [...pending],
      decide: async (/** @type {string} */ id, /** @type {string} */ answer) => {
        const settle = waiting.get(id);
        if (!settle) throw new Error('That card was already answered or timed out.');
        settle(answer);
        return { result: answer === 'deny' ? 'deny' : 'allow' };
      },
    },

    logs: {
      query: async (/** @type {unknown} */ filter) => {
        const f = logFilter(filter);
        const found = events.filter((e) => (!f.identity || e.identity.subject === f.identity) && (!f.session_id || e.session_id === f.session_id) && (!f.result || e.decision.result === f.result));
        return {
          events: found.slice(-f.limit).reverse(), truncated: found.length > f.limit,
          identities: IDENTITIES.map((i) => ({ id: i.id, name: i.displayName })),
          sessions: sessionChoices(events.filter((e) => e.type === 'session.start')),
        };
      },
    },

    /** The Core's Connections row data. */
    status: () => ({ pid: 4242, startedAt: iso(now() - 4 * 60 * MIN), schema: 5, containment: 'container', sessions: sessions.size }),

    /** The body of an app page the demo can show (Settings, a transcript), or null. @param {string} url */
    page(url) {
      if (url.startsWith(IDENTITIES_URL)) {
        /** @type {Record<string, any>} */
        const reach = {};
        for (const i of IDENTITIES) {
          /** @type {Record<string, any>} */
          const types = {};
          for (const g of i.grants) {
            const type = g.resource.slice(0, g.resource.indexOf(':'));
            (types[type] ??= { allow: [], ask: [], deny: [] })[g.effect].push({ resource: g.resource.slice(type.length + 1), permission: g.permission });
          }
          const b = BACKENDS.find((x) => x.name === i.backend);
          const allowed = (/** @type {string} */ h) => i.grants.some((g) => g.resource === `net:${h}` && g.effect === 'allow');
          reach[i.id] = {
            status: i.status, containment: i.containment, enforced: true, types, expired: 0, notApplied: [], alwaysDenied: ALWAYS_DENIED, standing: [],
            backend: b ? { name: b.name, displayName: b.displayName, hosts: b.hosts, missingHosts: b.hosts.filter((h) => !allowed(h)) } : null,
          };
        }
        return identitiesBody({ identities: /** @type {any} */ (IDENTITIES), reach, sessions: list(), starts: events.filter((e) => e.type === 'session.start').reverse(), now: now() }, escapeHtml);
      }
      if (url === SETTINGS_URL) {
        return settingsBody({
          hubUrl: 'http://127.0.0.1:4273', hubToken: 'sent', quickLinks: 2, newsSources: 2, bookmarkSource: 'chrome', adBlock: true, closeToTray: true,
          chat: { model: '', missing: ['ACC_CHAT_API_KEY', 'ACC_CHAT_MODEL'] }, cronsole: { configured: true, ui: 'http://localhost:7373' }, mcpUrl: 'http://127.0.0.1:52011/mcp',
          workspaces: 2, workspace: { name: 'acme-api', folder: WS.replaceAll('/', '\\'), tabs: 2, terminals: 1 + [...sessions.values()].filter((s) => s.term).length },
          core: { dir: 'C:\\Users\\dev\\AppData\\Local\\houston-core', sessions: sessions.size, identities: IDENTITIES.length, grants: grants.length, askGrants: grants.filter((g) => g.effect === 'ask').length, approvals: pending.length,
            limits: { approvalSeconds: APPROVAL_MS / 1000, transcriptBytes: 5 * 1024 ** 3, sessionTranscriptBytes: 100 * 1024 ** 2 }, mcp: { servers: servers.length, pinned: servers.filter((x) => x.state === 'pinned').length, review: servers.filter((x) => x.state === 'needs_review').length }, secrets: SECRETS.length },
        }, escapeHtml);
      }
      const id = transcriptIdFromUrl(url);
      if (id === null) return null;
      const text = transcripts.get(id);
      if (text === undefined) return '<h1>Session transcript</h1><p class="note">The Core has no transcript for this session.</p>';
      return transcriptBody({ id, text, bytes: text.length, truncated: false }, escapeHtml);
    },
  };
}
