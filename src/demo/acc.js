// The demo's stand-in for window.acc (src/preload/shell.cjs): the same calls, answered
// from fabricated files, bookmarks, tasks and terminal output. No network, no process,
// no secret; nothing here leaves the browser tab. Used only by the GitHub Pages demo
// (scripts/demo.js), never by the app.

import { toUrl } from '../shared/url.js';
import { docIdFromUrl, isDocUrl } from '../shared/docs.js';
import { pushRecent } from '../shared/recent.js';
import { toggleFavorite } from '../shared/favorites.js';
import { trayItem } from '../shared/chat.js';
import { chatRow, cronsoleRow, hubRow, mcpRow, shellRows } from '../shared/connections.js';
import { searchConversations } from '../shared/conversations.js';
import { Activity, activityRows } from '../shared/activity.js';
import { Runs, runRows } from '../shared/runs.js';
import { WELCOME_ID, WELCOME_URL } from './about.js';

const HOUR = 3_600_000;
const BASE = 'D:/work';
const HOME = 'C:/Users/dev';

/** @param {string} id @param {string} name @param {string} kind @param {any[]} [children] @param {string} [desc] */
const node = (id, name, kind, children, desc) => ({ id, name, kind, ...(children ? { children } : {}), ...(desc ? { desc } : {}) });

export const TREE = [
  node('@projects', 'Projects', 'projects', [
    node('ai-command-center', 'houston', 'repo', [node(WELCOME_ID, 'README.md', 'md')], 'This app'),
    node('acme-api', 'acme-api', 'repo', [
      node('acme-api/README.md', 'README.md', 'md'),
      node('acme-api/package.json', 'package.json', 'config'),
      node('acme-api/src', 'src', 'folder', [
        node('acme-api/src/server.js', 'server.js', 'file'),
        node('acme-api/src/routes.js', 'routes.js', 'file'),
      ]),
      node('acme-api/docs', 'docs', 'folder', [node('acme-api/docs/architecture.md', 'architecture.md', 'md')]),
    ], 'An example REST service'),
    node('docs-site', 'docs-site', 'repo', [
      node('docs-site/index.html', 'index.html', 'html'),
      node('docs-site/README.md', 'README.md', 'md'),
    ], 'A static documentation site'),
    node('notes', 'notes', 'folder', [
      node('notes/ideas.md', 'ideas.md', 'md'),
      node('notes/standup-2026-10-06.md', 'standup-2026-10-06.md', 'md'),
    ]),
  ]),
  node('~/.claude', '.claude', 'cli', [
    node('~/.claude/CLAUDE.md', 'CLAUDE.md', 'md'),
    node('~/.claude/skills', 'skills', 'folder', [node('~/.claude/skills/release-notes', 'release-notes', 'skill')]),
  ]),
];

const BOOKMARKS = [
  { name: 'Bookmarks bar', children: [
    { name: 'Electron docs', url: 'https://www.electronjs.org/docs/latest' },
    { name: 'xterm.js', url: 'https://xtermjs.org/' },
    { name: 'Model Context Protocol', url: 'https://modelcontextprotocol.io/' },
    { name: 'ai-automation-tools', children: [
      { name: 'ai-automation-tools.dev', url: 'https://ai-automation-tools.dev/' },
      { name: 'Project Hub demo', url: 'https://project-hub.ai-automation-tools.dev/' },
      { name: 'Cronsole demo', url: 'https://cronsole-demo.ai-automation-tools.dev/' },
    ] },
  ] },
];

const FAVORITES = [{ name: 'Favorites', children: [{ name: 'GitHub', url: 'https://github.com/' }] }];

const SHELLS = [
  { id: 'pwsh', label: 'PowerShell 7', powershell: true },
  { id: 'powershell', label: 'Windows PowerShell', powershell: true },
  { id: 'cmd', label: 'Command Prompt', powershell: false },
];

const CRONSOLE_UI = 'https://cronsole-demo.ai-automation-tools.dev/';
const DEMO_SPACE = { active: 'default', list: [{ id: 'default', name: 'Default', folder: '', hubId: '' }], folder: '', terminals: [], live: false };

/** @param {number} now */
const tasks = (now) => [
  { id: 'task-backup', name: 'Nightly backup', platform: 'windows', schedule: 'Daily 02:00', status: 'ACTIVE', nextRunTime: new Date(now + 6 * HOUR).toISOString(), lastRunAt: new Date(now - 18 * HOUR).toISOString(), lastRunStatus: 'Success' },
  { id: 'task-links', name: 'Docs link check', platform: 'claude', schedule: 'Mon 09:00', status: 'ACTIVE', nextRunTime: new Date(now + 50 * HOUR).toISOString(), lastRunAt: new Date(now - 5 * 24 * HOUR).toISOString(), lastRunStatus: 'Failed' },
  { id: 'task-roadmap', name: 'Roadmap routine', platform: 'claude', schedule: 'Sun, Wed 20:00', status: 'ACTIVE', nextRunTime: new Date(now + 30 * HOUR).toISOString() },
  { id: 'task-export', name: 'Old export job', platform: 'windows', schedule: 'Hourly', status: 'DISABLED' },
];

/** Cronsole's recorded runs of a task, newest first. @param {string} taskId @param {number} now */
const runs = (taskId, now) => {
  const t = tasks(now).find((x) => x.id === taskId);
  if (!t?.lastRunAt) return [];
  const at = Date.parse(t.lastRunAt);
  const failed = t.lastRunStatus === 'Failed';
  return [0, 1, 2].map((i) => ({
    id: `${taskId}-run-${i}`,
    status: failed && i === 0 ? 'FAILURE' : 'SUCCESS',
    triggeredAt: new Date(at - i * 24 * HOUR).toISOString(),
    durationMs: failed && i === 0 ? 4200 : 61_000 + i * 900,
    log: failed && i === 0 ? '2 broken links: docs/setup.md -> /install (404)' : 'Done.',
    platformRunId: null,
  }));
};

/** @param {number} now */
const calls = (now) => [
  { at: now - 4 * 60_000, method: 'tools/call', tool: 'sidebar_search', args: '{"query":"architecture"}', ok: true, ms: 12, client: 'claude-code 2.1.307' },
  { at: now - 5 * 60_000, method: 'tools/call', tool: 'list_tabs', args: '{}', ok: true, ms: 3, client: 'claude-code 2.1.307' },
  { at: now - 6 * 60_000, method: 'initialize', ok: true, ms: 2, client: 'claude-code 2.1.307' },
];

const NPM_TEST = [
  '',
  '> acme-api@1.4.0 test',
  '> node --test',
  '',
  '\x1b[32m✔\x1b[0m routes answer /health (3.1ms)',
  '\x1b[32m✔\x1b[0m GET /orders pages by cursor (8.4ms)',
  '\x1b[32m✔\x1b[0m POST /orders rejects a missing customer (2.2ms)',
  '\x1b[31m✖\x1b[0m DELETE /orders/:id returns 204 (5.0ms)',
  '  Expected 204, got 500',
  '\x1b[90mℹ tests 4 · pass 3 · fail 1\x1b[0m',
];

const OUTPUT = /** @type {Record<string, string[]>} */ ({
  'npm test': NPM_TEST,
  'git status': ['On branch main', "Your branch is up to date with 'origin/main'.", '', 'Changes not staged for commit:', '\x1b[31m\tmodified:   src/routes.js\x1b[0m'],
  ls: ['', '    Directory: D:\\work\\acme-api', '', 'Mode          LastWriteTime   Name', '----          -------------   ----', 'd----   2026-10-06  09:12     docs', 'd----   2026-10-06  09:12     src', '-a---   2026-10-06  09:12     package.json', '-a---   2026-10-06  09:12     README.md'],
  help: ['This is the demo, so nothing runs. These answer with canned output:', '  npm test   git status   ls   cls'],
});
OUTPUT.dir = OUTPUT.ls;
OUTPUT['Get-ChildItem'] = OUTPUT.ls;

/** What the fake shell prints for one command line. @param {string} line */
export function commandOutput(line) {
  const cmd = line.trim();
  if (!cmd) return '';
  if (cmd === 'cls' || cmd === 'clear') return '\x1b[2J\x1b[H';
  const lines = OUTPUT[cmd] ?? [`This is the demo: "${cmd}" didn't run. Try npm test, git status, ls or help.`];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * @param {{
 *   now?: () => number,
 *   onTab?: (tab: { url: string, title: string } | null) => void,
 *   notify?: (text: string) => void,
 *   askAfterMs?: number | null,
 * }} [opts] askAfterMs: when to show the terminal_run confirm bar once; null never does
 */
export function demoApi({ now = Date.now, onTab = () => {}, notify = () => {}, askAfterMs = null } = {}) {
  /** @type {Map<string, Set<(...args: any[]) => void>>} */
  const listeners = new Map();
  let trayId = 0;
  /** @type {{ active: string | null, list: { id: string, name: string, updated: number, text: string }[] }} */
  const demoChats = {
    active: null,
    list: [
      { id: 'c1', name: 'Why does npm test fail on Windows?', updated: now() - 2 * 3600_000, text: 'Why does npm test fail on Windows? The path separator in tree.test.js: use path.join.' },
      { id: 'c2', name: 'Deploy steps for acme-api', updated: now() - 3 * 86400_000, text: 'How do I deploy acme-api? Merge to main; the release workflow builds and ships it.' },
    ],
  };
  /** @param {string} name */
  const listen = (name) => (/** @type {(...args: any[]) => void} */ fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)?.add(fn);
    return () => listeners.get(name)?.delete(fn);
  };
  /** @param {string} name @param {...unknown} args */
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args); };
  const later = (/** @type {() => void} */ fn, ms = 30) => setTimeout(fn, ms);

  let recent = [
    { type: 'url', target: 'https://modelcontextprotocol.io/', label: 'Model Context Protocol', at: now() - 2 * HOUR },
    { type: 'terminal', target: `${BASE}/acme-api`, label: `${BASE}/acme-api`, at: now() - 3 * HOUR },
    { type: 'file', target: 'acme-api/README.md', label: 'README.md', at: now() - 26 * HOUR },
  ];
  /** @param {any} item */
  const addRecent = (item) => { recent = /** @type {any} */ (pushRecent(/** @type {any} */ (recent), item, now())); emit('recent', recent); };

  /** Hub favorites, mutable so the address-bar star toggles them like the real app. */
  let favs = JSON.parse(JSON.stringify(FAVORITES));

  const log = calls(now());
  /** @param {string} tool @param {unknown} args @param {boolean} [ok] */
  const logCall = (tool, args, ok = true) => emit('logged', { at: now(), method: 'tools/call', tool, args: JSON.stringify(args), ok, ms: 4 });

  // ---- tabs: no browser engine behind them, just the state the tab strip shows ----
  /** @type {Map<number, { id: number, url: string, title: string, loading: boolean, canGoBack: boolean, canGoForward: boolean, history: string[], at: number }>} */
  const tabs = new Map();
  /** @type {string[]} */
  const closed = [];
  let nextTab = 1;
  /** @type {number | null} */
  let active = null;
  let hidden = false;

  /** @param {string} url */
  const titleOf = (url) => {
    if (isDocUrl(url)) return docIdFromUrl(url).split('/').pop() || url;
    if (url.startsWith('acc://run/')) return 'Cronsole run';
    if (url.startsWith('acc://runlog/')) return 'Run';
    try { return new URL(url).hostname || url; } catch { return url; }
  };
  const show = () => {
    const t = active !== null ? tabs.get(active) : null;
    onTab(t && !hidden ? { url: t.url, title: t.title } : null);
  };
  /** @param {number} id */
  const update = (id) => {
    const t = tabs.get(id);
    if (!t) return;
    t.canGoBack = t.at > 0;
    t.canGoForward = t.at < t.history.length - 1;
    const { history: _h, at: _a, ...state } = t;
    emit('tab:update', { ...state, favicon: '' });
    if (id === active) show();
  };
  /** @param {number} id */
  const activate = (id) => {
    if (!tabs.has(id)) return;
    active = id;
    hidden = false;
    emit('tab:activated', id);
    show();
  };
  /** @param {string} url */
  const create = (url) => {
    const id = nextTab++;
    tabs.set(id, { id, url, title: titleOf(url), loading: false, canGoBack: false, canGoForward: false, history: [url], at: 0 });
    emit('tab:created', { id, url, title: titleOf(url) });
    activate(id);
    update(id);
    if (/^https?:/.test(url)) addRecent({ type: 'url', target: url, label: titleOf(url) });
    return id;
  };
  /** @param {number} id @param {string} url */
  const go = (id, url) => {
    const t = tabs.get(id);
    if (!t) return;
    t.history = [...t.history.slice(0, t.at + 1), url];
    t.at = t.history.length - 1;
    t.url = url;
    t.title = titleOf(url);
    update(id);
  };

  // ---- terminals: a prompt that echoes what's typed and answers a few commands ----
  /** @type {Map<number, { line: string, prompt: string }>} */
  const terms = new Map();
  let nextTerm = 1;
  /** @param {number} id @param {string} data */
  const out = (id, data) => later(() => emit('term:data', id, data));

  /** @param {number} id @param {string} data */
  function type(id, data) {
    const s = terms.get(id);
    if (!s) return;
    for (const ch of data) {
      if (ch === '\r') {
        out(id, `\r\n${commandOutput(s.line)}${s.prompt}`);
        s.line = '';
      } else if (ch === '\x7f') {
        if (s.line) { s.line = s.line.slice(0, -1); out(id, '\b \b'); }
      } else if (ch === '\x03') {
        s.line = '';
        out(id, `^C\r\n${s.prompt}`);
      } else if (ch >= ' ') {
        s.line += ch;
        out(id, ch);
      }
    }
  }

  // ---- one terminal_run ask, to show the confirm bar ----
  let asked = false;
  const ask = { id: 1, command: 'npm test', cwd: 'D:\\work\\acme-api' };
  // The MCP panel's agent work: two made-up past asks, then the one above.
  const work = new Activity();
  /** @param {{ kind: 'command', asked: string, target: string }} w @param {boolean} yes @param {number} [exitCode] */
  const seed = (w, yes, exitCode) => {
    const item = work.ask(w, now() - 2 * HOUR);
    work.answered(item.id, yes, false, now() - 2 * HOUR);
    if (exitCode === undefined) return;
    work.ranAs(item.id, item.id);
    work.runEnded(/** @type {any} */ ({ run: item.id, state: exitCode ? 'failed' : 'succeeded', exitCode, endedAt: now() - 2 * HOUR + 4000 }));
  };
  seed({ kind: 'command', asked: 'npm run lint', target: 'D:\\work\\acme-api' }, true, 0);
  seed({ kind: 'command', asked: 'git push --force', target: 'D:\\work\\acme-api' }, false);
  // The run history behind the MCP panel's Runs list: the lint run above, and an older failure.
  const history = new Runs();
  /** @param {string} command @param {number} code @param {string} output @param {string[]} changed @param {number} ago */
  const pastRun = (command, code, output, changed, ago) => {
    const r = history.start({ terminal: 0, command, cwd: 'D:\\work\\acme-api' }, now() - ago);
    history.end(0, code, output, now() - ago + 4000);
    r.changed = changed;
  };
  pastRun('npm test', 1, '> acme-api@1.0.0 test\r\n✗ login rejects a wrong password\r\n1 failing', [], 5 * HOUR);
  pastRun('npm run lint', 0, '> acme-api@1.0.0 lint\r\n0 problems', ['src/server.js'], 2 * HOUR);
  let askWork = 0;
  const workChanged = () => emit('activity', activityRows(work.list));

  const api = {
    info: async () => ({
      hubUrl: 'http://localhost:8765',
      quickLinks: [
        { label: 'Project Hub demo', url: 'https://project-hub.ai-automation-tools.dev/' },
        { label: 'ai-automation-tools.dev', url: 'https://ai-automation-tools.dev/' },
      ],
      versions: { electron: 'demo', chrome: 'demo', node: 'demo' },
      shell: SHELLS[0].label,
      shells: SHELLS,
      layout: { sidebarWidth: 300, terminalHeight: 240, terminalOpen: true, chatWidth: 340, chatOpen: true, bookmarkSource: 'chrome', tabs: [] },
      browsePartition: 'persist:browse',
    }),
    saveLayout: async () => {},

    hub: {
      health: async () => ({ ok: true, state: 'ready' }),
      scan: async () => ({ base: BASE, home: HOME, tree: TREE }),
      webmarks: async () => ({ sources: [{ id: 'chrome', label: 'Chrome · Default' }], source: 'chrome', roots: BOOKMARKS }),
      favorites: async () => ({ roots: favs }),
      favorite: async (/** @type {string} */ url, /** @type {string} */ name) => {
        const out = toggleFavorite(favs, { url, name });
        favs = /** @type {any} */ (out.roots);
        return out;
      },
      open: async () => { throw new Error('VS Code and Explorer open from the desktop app, not the demo.'); },
      onChanged: listen('hub:changed'),
    },

    tabs: {
      create: async (/** @type {string} */ input) => create(toUrl(String(input || 'about:blank'))),
      activate: async (/** @type {number} */ id) => activate(id),
      close: async (/** @type {number} */ id) => {
        const t = tabs.get(id);
        if (!t) return;
        closed.push(t.url);
        tabs.delete(id);
        emit('tab:closed', id);
        if (active === id) {
          active = null;
          const last = [...tabs.keys()].pop();
          if (last !== undefined) activate(last);
          else show();
        }
      },
      navigate: async (/** @type {string} */ input) => { if (active !== null) go(active, toUrl(String(input))); },
      command: async (/** @type {string} */ action) => {
        const t = active !== null ? tabs.get(active) : null;
        if (action === 'reopen' && closed.length) return void create(/** @type {string} */ (closed.pop()));
        if (!t) return;
        if (action === 'back' && t.at > 0) { t.at--; t.url = t.history[t.at]; t.title = titleOf(t.url); update(t.id); }
        if (action === 'forward' && t.at < t.history.length - 1) { t.at++; t.url = t.history[t.at]; t.title = titleOf(t.url); update(t.id); }
      },
      find: async () => { if (active !== null) later(() => emit('tab:found', active, { active: 0, total: 0 })); },
      stopFind: async () => {},
      onFound: listen('tab:found'),
      openExternal: async (/** @type {string} */ url) => notify(`In the app this opens ${url} in your default browser.`),
      // The app reopens last session's tabs here; the demo opens its welcome page.
      restore: async () => { if (!tabs.size) create(WELCOME_URL); },
      setBounds: () => {},
      setHidden: (/** @type {boolean} */ h) => { hidden = Boolean(h); show(); },
      onCreated: listen('tab:created'),
      onUpdate: listen('tab:update'),
      onActivated: listen('tab:activated'),
      onClosed: listen('tab:closed'),
    },

    term: {
      create: async (/** @type {{ cwd?: string, shell?: string }} */ opts = {}) => {
        const id = nextTerm++;
        const shell = SHELLS.find((s) => s.id === opts.shell) ?? SHELLS[0];
        const cwd = opts.cwd || `${BASE}/acme-api`;
        const win = cwd.replaceAll('/', '\\');
        const prompt = shell.powershell ? `\x1b[32mPS\x1b[0m ${win}> ` : `${win}>`;
        terms.set(id, { line: '', prompt });
        out(id, `\x1b[90m${shell.label} · demo session: nothing runs, a few commands answer. Try npm test.\x1b[0m\r\n\r\n${prompt}`);
        addRecent({ type: 'terminal', target: cwd, label: cwd });
        return { id, cwd, shell: shell.label, powershell: shell.powershell, ws: 'default' };
      },
      kill: async (/** @type {number} */ id) => { terms.delete(id); },
      write: (/** @type {number} */ id, /** @type {string} */ data) => type(id, data),
      setActive: () => {},
      resize: () => {},
      onData: listen('term:data'),
      onExit: listen('term:exit'),
      // No agent runs anything in the demo, so main never opens a run terminal.
      onOpened: listen('term:opened'),
    },

    recent: {
      list: async () => recent,
      add: async (/** @type {any} */ item) => addRecent(item),
      onChanged: listen('recent'),
    },

    mcp: {
      answer: async (/** @type {number} */ id, /** @type {number | true | null} */ answer) => {
        if (id !== ask.id) return;
        work.answered(askWork, answer === true, false);
        // Nothing runs in the demo: a Run click finishes at once.
        if (answer === true) {
          work.ranAs(askWork, askWork);
          work.runEnded(/** @type {any} */ ({ run: askWork, state: 'succeeded', exitCode: 0, endedAt: now() }));
        }
        workChanged();
        logCall('terminal_run', { command: ask.command }, answer === true);
      },
      onConfirm: (/** @type {(ask: { id: number, command: string }) => void} */ fn) => {
        const off = listen('confirm')(fn);
        if (!asked && askAfterMs !== null) {
          asked = true;
          setTimeout(() => {
            askWork = work.ask({ kind: 'command', asked: ask.command, target: ask.cwd }).id;
            workChanged();
            emit('confirm', ask);
          }, askAfterMs);
        }
        return off;
      },
      onCancel: listen('cancel'),
      log: async () => log,
      onLogged: listen('logged'),
    },

    activity: {
      list: async () => activityRows(work.list),
      onChanged: listen('activity'),
    },

    runs: {
      list: async (/** @type {string} */ query) => runRows(history.list, query),
      onChanged: listen('runs'),
    },

    chat: {
      info: async () => ({ model: 'demo · no model', missing: [], mcp: true, history: [] }),
      stop: async () => {},
      attach: async (/** @type {'page' | 'terminal'} */ kind) => {
        const name = kind === 'page' ? 'read_tab' : 'terminal_read';
        logCall(name, {});
        const text = kind === 'page'
          ? JSON.stringify({ id: 1, url: 'https://example.com/', title: 'Demo page', text: 'Made-up page text', truncated: false })
          : JSON.stringify({ terminal: 1, text: 'PS D:/work> npm test\n> 42 passing' });
        return { id: ++trayId, ...trayItem(kind, text) };
      },
      send: async (/** @type {string} */ text) => {
        const query = String(text).slice(0, 40);
        emit('chat', { type: 'tool', name: 'sidebar_search', input: { query } });
        logCall('sidebar_search', { query });
        emit('chat', { type: 'result', name: 'sidebar_search', ok: true, text: 'Files (1): acme-api/docs/architecture.md' });
        // A few words at a time, the way the app shows a reply as it streams in.
        const reply = 'This is the demo, so no model is answering. In the app, Claude reads your message, calls the app\'s MCP tools (search the sidebar, open tabs, read a page or a terminal) and asks before it runs anything. Its model and key come from your environment.';
        for (const piece of reply.match(/\S+\s*/g) ?? []) {
          emit('chat', { type: 'delta', text: piece });
          await new Promise((r) => later(() => r(undefined), 25));
        }
      },
      // Two made-up conversations, kept in memory only.
      list: async (/** @type {string} */ query) => ({
        active: demoChats.active,
        name: demoChats.list.find((c) => c.id === demoChats.active)?.name ?? '',
        list: searchConversations(demoChats.list, query || ''),
      }),
      new: async () => { demoChats.active = null; },
      open: async (/** @type {string} */ id) => { demoChats.active = id; },
      rename: async (/** @type {string} */ id, /** @type {string} */ name) => {
        const c = demoChats.list.find((x) => x.id === id);
        if (c) c.name = String(name).trim().slice(0, 80) || c.name;
      },
      delete: async (/** @type {string} */ id) => {
        demoChats.list = demoChats.list.filter((c) => c.id !== id);
        if (demoChats.active === id) demoChats.active = null;
      },
      onEvent: listen('chat'),
    },

    // One workspace: the demo has no folders to add.
    workspace: {
      info: async () => DEMO_SPACE,
      switch: async () => DEMO_SPACE,
      add: async () => { notify('Workspaces open real folders; that needs the desktop app.'); return DEMO_SPACE; },
      remove: async () => DEMO_SPACE,
      onChanged: listen('workspace'),
    },

    cronsole: {
      info: async () => ({ configured: true, ui: CRONSOLE_UI }),
      tasks: async () => tasks(now()),
      history: async (/** @type {string} */ taskId) => runs(taskId, now()),
    },

    // A made-up repo. The diff pages are the desktop app's (acc://git), so the demo's rows open the stand-in page.
    git: {
      status: async () => ({
        repo: 'D:\\work\\acme-api', branch: 'feature/rate-limits', upstream: 'origin/feature/rate-limits', ahead: 2, behind: 0,
        files: [
          { path: 'src/middleware/rateLimit.ts', from: null, staged: 'M', unstaged: null, kind: 'changed' },
          { path: 'src/routes/users.ts', from: null, staged: null, unstaged: 'M', kind: 'changed' },
          { path: 'docs/api/limits.md', from: null, staged: null, unstaged: '?', kind: 'untracked' },
        ],
      }),
    },

    // The same made-up repo with its dev server up. Nothing starts in the demo.
    dev: {
      info: async () => ({
        folder: 'D:\\work\\acme-api', manager: 'npm', scripts: ['dev', 'preview'], reason: '',
        servers: [{ id: 1, folder: 'D:\\work\\acme-api', script: 'dev', manager: 'npm', state: 'ready', code: null, url: 'http://localhost:5173/', port: 5173, startedAt: now() - 600_000, pid: 4242, text: 'http://localhost:5173/' }],
      }),
      start: async () => { throw new Error('This is the demo, so no dev server starts.'); },
      stop: async () => { throw new Error('This is the demo, so there is no process to stop.'); },
      restart: async () => { throw new Error('This is the demo, so no dev server starts.'); },
      onChanged: listen('dev'),
    },

    // Made-up states: what a machine with Hub up, Git Bash missing and no chat key would show.
    connections: {
      check: async (/** @type {string | undefined} */ id) => [
        hubRow('http://127.0.0.1:4273', { ok: true, state: 'ready' }),
        cronsoleRow({ configured: true, ui: CRONSOLE_UI }, { count: tasks(now()).length }),
        ...shellRows([{ id: 'pwsh' }, { id: 'powershell' }, { id: 'cmd' }]),
        chatRow({ model: '', missing: ['ACC_CHAT_API_KEY', 'ACC_CHAT_MODEL'] }),
        mcpRow({ url: 'http://127.0.0.1:52011/mcp' }),
      ].filter((r) => !id || r.id === id || (id === 'shells' && r.id.startsWith('shell:'))),
    },
    menu: async () => { notify('Menus are native in the desktop app; the demo has none.'); return null; },
    extensions: { list: async () => [] },
    onShortcut: listen('shortcut'),
  };
  return api;
}
