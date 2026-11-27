// Houston: main process. One BaseWindow holding the shell UI (sidebar, tab
// strip, terminal panel) as a WebContentsView, with a WebContentsView per browser tab
// stacked over the shell's content area.

import { app, BaseWindow, Menu, Tray, WebContentsView, ipcMain, nativeTheme, net, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendLog, logCrashes, logError } from './applog.js';
import { hub, subscribeHubEvents } from './hub.js';
import { chat } from './chat.js';
import { cronsole } from './cronsole.js';
import { mcpLog, startMcp } from './mcp.js';
import { store } from './store.js';
import { activeProfile, setNextProfile } from './profile.js';
import { browsePartition } from '../shared/profiles.js';
import { Tabs } from './tabs.js';
import { Terminals, ptyDrainMs } from './terminal.js';
import { extensionsMenu, listExtensions, setupExtensions } from './extensions.js';
import { loadBlocker } from './adblock.js';
import { smoke } from './smoke.js';
import { serveDocs, invalidateDocsIndex } from './docs.js';
import { diffPage as gitDiff, status as gitStatus } from './git.js';
import { DevServers } from './devservers.js';
import { fileListing, isLocalFileUrl, toUrl } from '../shared/url.js';
import { chromeUserAgent, cleanSavedTabs, savedActiveIndex } from '../shared/session.js';
import { allTools } from '../shared/tools.js';
import { elementLine, pageHost } from '../shared/pageactions.js';
import { Confirmations } from '../shared/confirm.js';
import { Runs, changedFiles, runIdFromUrl, runInfo, runRows, runStateText } from '../shared/runs.js';
import { docPage, escapeHtml, runLogPage } from '../shared/docs.js';
import { cleanOutput } from '../shared/output.js';
import { Activity, activityRows } from '../shared/activity.js';
import { menuItems } from '../shared/menu.js';
import { HUB_FAVORITES } from '../shared/tree.js';
import { isPermissionAllowed } from '../shared/permissions.js';
import { mergeNews, parseNews } from '../shared/news.js';
import { addWorkspace, drivePath, removeWorkspace, saveWorkspace, workspaceSummary } from '../shared/workspaces.js';
import { chatRow, coreRow, cronsoleRow, hubRow, mcpRow, shellRows } from '../shared/connections.js';
import { core } from './core.js';
import { coreSettings, createAgents, identitiesPage, integrations, transcriptPage } from './agents.js';
import { feed, startPage } from './feed.js';
import { controls, settingsBody } from '../shared/scopes.js';
import { PANE_ROWS, prefChange } from '../shared/prefs.js';
import { DEFAULT_HUB_URL } from '../shared/settings.js';
import { bundleName, coreHealthRows, diagnosticsBundle, healthBody } from '../shared/health.js';
import { tailLines } from '../../core/health.js';
import { appSecretValues, env } from './env.js';
import { watchApprovals } from './approvals.js';
import { conversationText, isConversationId, removeConversation, renameConversation, searchConversations, titleFrom, touchConversation } from '../shared/conversations.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

// acc://shell/... serves the shell UI. Mapped prefixes only, and every resolved path is
// checked to stay under its folder, so a crafted URL can't read anything else on disk.
const SERVE = [
  ['/vendor/xterm/', path.join(ROOT, 'node_modules', '@xterm', 'xterm')],
  ['/vendor/addon-fit/', path.join(ROOT, 'node_modules', '@xterm', 'addon-fit')],
  ['/vendor/addon-search/', path.join(ROOT, 'node_modules', '@xterm', 'addon-search')],
  ['/shared/', path.join(ROOT, 'src', 'shared')],
  ['/', path.join(ROOT, 'src', 'renderer')],
];

protocol.registerSchemesAsPrivileged([
  { scheme: 'acc', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ACC_USER_DATA: run on another profile (npm run smoke's throwaway one). Before the
// single-instance lock, which is per profile, so a smoke run works beside the real app.
if (process.env.ACC_USER_DATA) app.setPath('userData', process.env.ACC_USER_DATA);

// A smoke run keeps painting and running timers while its window is covered or minimized,
// so its checks don't depend on the desktop being left alone. The real app keeps Chromium's
// throttling, which saves power when it's in the background.
if (process.env.ACC_SMOKE_DIR) {
  for (const s of ['disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows', 'disable-background-timer-throttling']) app.commandLine.appendSwitch(s);
}

// The active profile's browser storage (H5): another profile's cookies and sign-ins are never loaded.
// After the userData folder is final: profile.json is read from it.
const BROWSE_PARTITION = browsePartition(activeProfile());

// Before any renderer or service worker starts: they read navigator.userAgent from this.
app.userAgentFallback = chromeUserAgent(app.userAgentFallback);

// One instance: a second launch focuses the first, or with --quit (Start-AICommandCenter.ps1
// -Quit, the Stop-Houston task) makes it quit as File → Quit does; --quit with nothing
// running just ends. exit(), not quit(): quit() is async, so whenReady would still run and
// start a second MCP server over the first's mcp.json.
if (!app.requestSingleInstanceLock() || process.argv.includes('--quit')) app.exit(0);

/** @type {BaseWindow | null} */
let win = null;
/** @type {WebContentsView | null} */
let shellView = null;
/** @type {Awaited<ReturnType<typeof startMcp>> | null} */
let mcp = null;
/** The active workspace's conversations; set once the store is readable. @type {import('../shared/conversations.js').ConversationIndex} */
let convs;
const cron = cronsole();
/** @type {(() => void) | null} */
let stopEvents = null;
/** @type {Tray | null} */
let tray = null;
/** Writes the diagnostics bundle and returns its path; set once the window is up. @type {(() => Promise<string>) | null} */
let saveDiagnostics = null;
// Set on a real quit (File → Quit, the tray's Quit, a smoke run's app.quit()), so the
// window's close goes through instead of hiding to the tray.
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Closing the window hides it to the tray (layout.json's closeToTray, on by default), or quits.
 * @param {boolean} on
 */
function setCloseToTray(on) {
  store.saveLayout({ closeToTray: on });
  const item = Menu.getApplicationMenu()?.getMenuItemById('close-to-tray');
  if (item) item.checked = on;
  tray?.setContextMenu(trayMenu());
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Houston', click: showWindow },
    { label: 'Stop all agent sessions', click: () => stopAllSessions() },
    { label: 'Close to tray', type: 'checkbox', checked: store.layout().closeToTray, click: (mi) => setCloseToTray(mi.checked) },
    { type: 'separator' },
    { label: 'Quit Houston', click: () => app.quit() },
  ]);
}

// ponytail: the tray borrows the Electron binary's own icon; ship an .ico when the app gets one.
async function createTray() {
  tray = new Tray(await app.getFileIcon(process.execPath, { size: 'small' }));
  tray.setToolTip('Houston');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

// The hotkey for Stop All; the toolbar button's title in index.html names it too.
const STOP_ALL_KEY = 'CmdOrCtrl+Shift+Backspace';

/**
 * Stop All (SEC-10): end every session the Core runs. The hotkey, the tray and the toolbar button
 * all land here, in the main process; the tray needs no page, so it works with the window hung.
 * The window shows the result.
 * @returns {Promise<{ stopped: number, paused?: number } | { error: string }>} paused: standing grants Stop All paused
 */
async function stopAllSessions() {
  /** @type {{ stopped: number, paused?: number } | { error: string }} */
  let r;
  try {
    r = await core.call('stop.all', {}, 15_000);
  } catch (e) {
    const err = /** @type {Error & { code?: string }} */ (e);
    r = { error: err.code === 'ENOENT' ? 'The Houston Core is not running, so no agent session is either.' : err.message };
  }
  send('agents:stopped', r);
  send('agents:changed');
  return r;
}

/** @param {string} channel @param {...unknown} args */
function send(channel, ...args) {
  if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.send(channel, ...args);
}

function serveShell() {
  protocol.handle('acc', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'shell') return new Response('not found', { status: 404 });
    const pathname = decodeURIComponent(url.pathname);
    for (const [prefix, dir] of SERVE) {
      if (!pathname.startsWith(prefix)) continue;
      const file = path.resolve(dir, pathname.slice(prefix.length) || 'index.html');
      if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    }
    return new Response('not found', { status: 404 });
  });
}

/**
 * Accept IPC only from the shell UI. Browser tabs run untrusted pages; they have no
 * preload that exposes these channels, and this check refuses them even if they did.
 * @param {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent} e
 */
function fromShell(e) {
  // The shell's main frame on acc://shell, not just its webContents: a subframe can't speak for it.
  return shellView !== null && e.sender === shellView.webContents
    && e.senderFrame === shellView.webContents.mainFrame && Boolean(e.senderFrame?.url.startsWith('acc://shell/'));
}

/**
 * @param {string} channel
 * @param {(...args: any[]) => unknown} fn
 */
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromShell(e)) throw new Error('refused');
    return fn(...args);
  });
}

/** @param {string} channel @param {(...args: any[]) => void} fn */
function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => { if (fromShell(e)) fn(...args); });
}

const NEWS_TIMEOUT_MS = 15_000;
const NEWS_MAX_BYTES = 2_000_000;

/**
 * One News source's text: an http(s) address fetched with a deadline and a size cap, or
 * a local `.md` path from settings.json read from disk. Node's fetch, so no browse-session cookies go with it.
 * @param {string} url
 */
async function readNewsSource(url) {
  if (!/^https?:/i.test(url)) {
    const stat = await fs.promises.stat(url);
    if (stat.size > NEWS_MAX_BYTES) throw new Error('The file is over 2 MB');
    return fs.promises.readFile(url, 'utf8');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(NEWS_TIMEOUT_MS), headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/markdown, text/plain;q=0.9, */*;q=0.5' } })
    .catch((err) => { throw new Error(err?.name === 'TimeoutError' ? `No answer within ${NEWS_TIMEOUT_MS / 1000} s` : "Couldn't reach it"); });
  if (!res.ok) throw new Error(`It returned ${res.status}`);
  if (Number(res.headers.get('content-length')) > NEWS_MAX_BYTES) throw new Error('The answer is over 2 MB');
  // Read with a running count: a body with no Content-Length stops at the cap instead of
  // being buffered whole. Throwing inside the loop cancels the stream.
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > NEWS_MAX_BYTES) throw new Error('The answer is over 2 MB');
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** @param {Electron.MenuItemConstructorOptions[]} [extensions] the Extensions submenu, once they're set up */
function buildMenu(extensions = [{ label: 'Loading…', enabled: false }]) {
  /** @param {string} label @param {string | undefined} accelerator @param {string} action */
  const item = (label, accelerator, action) => ({ label, accelerator, click: () => send('shortcut', action) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        // Ctrl+L and Ctrl+R are left off this menu on purpose: in PowerShell they clear
        // the screen and search history. Browser tabs map them in tabs.js instead.
        item('New tab', 'CmdOrCtrl+T', 'new-tab'),
        item('Close tab', 'CmdOrCtrl+W', 'close-tab'),
        item('Reopen closed tab', 'CmdOrCtrl+Shift+T', 'reopen-tab'),
        item('Focus address bar', 'Alt+D', 'focus-address'),
        { type: 'separator' },
        item('Next tab', 'Ctrl+Tab', 'next-tab'),
        item('Previous tab', 'Ctrl+Shift+Tab', 'prev-tab'),
        // Chrome's rule: Ctrl+1 to Ctrl+8 pick that tab, Ctrl+9 the last.
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => item(`Tab ${n}`, `CmdOrCtrl+${n}`, `tab-${n}`)),
        item('Last tab', 'CmdOrCtrl+9', 'tab-last'),
        { type: 'separator' },
        { id: 'stop-all', label: 'Stop all agent sessions', accelerator: STOP_ALL_KEY, click: () => stopAllSessions() },
        { type: 'separator' },
        { id: 'close-to-tray', label: 'Close to tray', type: 'checkbox', checked: store.layout().closeToTray, click: (mi) => setCloseToTray(mi.checked) },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Toggle terminal', 'CmdOrCtrl+`', 'toggle-terminal'),
        item('New terminal', 'CmdOrCtrl+Shift+`', 'new-terminal'),
        item('Command palette', 'CmdOrCtrl+K', 'palette'),
        item('Connections', undefined, 'connections'),
        item('Settings', 'CmdOrCtrl+,', 'settings'),
        item('Health', undefined, 'health'),
        {
          label: 'Save diagnostics bundle',
          click: () => saveDiagnostics?.().then((file) => shell.showItemInFolder(file), (err) => logError('diagnostics', err)),
        },
        item('Search everything', 'CmdOrCtrl+Shift+F', 'focus-search'),
        item('Toggle sidebar', 'CmdOrCtrl+B', 'toggle-sidebar'),
        item('Toggle chat', 'CmdOrCtrl+Shift+L', 'toggle-chat'),
        { type: 'separator' },
        item('Reload page', 'F5', 'reload'),
        item('Find in page', 'CmdOrCtrl+F', 'find'),
        item('Zoom in', 'CmdOrCtrl+=', 'zoom-in'),
        { ...item('Zoom in', 'CmdOrCtrl+Plus', 'zoom-in'), visible: false },
        item('Zoom out', 'CmdOrCtrl+-', 'zoom-out'),
        item('Reset zoom', 'CmdOrCtrl+0', 'zoom-reset'),
        item('Page developer tools', 'F12', 'devtools'),
        { label: 'Shell developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => shellView?.webContents.toggleDevTools() },
      ],
    },
    { label: 'Extensions', submenu: extensions },
  ]));
}

async function createWindow() {
  const layout = store.layout();
  win = new BaseWindow({ width: 1500, height: 950, minWidth: 900, minHeight: 600, title: 'Houston', autoHideMenuBar: true, backgroundColor: '#0b0d10' });

  shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'shell.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The shell loads only acc://shell files from this repo. Its preload needs
      // require() for <browser-action-list>, which a sandboxed preload can't do.
      sandbox: false,
    },
  });
  win.contentView.addChildView(shellView);
  const fit = () => {
    if (!win || !shellView) return;
    const { width, height } = win.getContentBounds();
    shellView.setBounds({ x: 0, y: 0, width, height });
  };
  win.on('resize', fit);
  fit();

  // Nothing in the shell navigates away or opens windows; links go to tabs.
  shellView.webContents.on('will-navigate', (e) => e.preventDefault());
  shellView.webContents.setWindowOpenHandler(({ url }) => {
    tabs.create(url);
    return { action: 'deny' };
  });
  // The shell's own text fields (address bar, search, chat, Settings) get the usual edit menu.
  // Rows and the terminal cancel their contextmenu event themselves, so they never reach this.
  shellView.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    const f = params.editFlags;
    Menu.buildFromTemplate([
      { role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste },
      { type: 'separator' }, { role: 'selectAll', enabled: f.canSelectAll },
    ]).popup();
  });

  const browseSession = session.fromPartition(BROWSE_PARTITION);
  // Pages are untrusted: deny every permission but the few in src/shared/permissions.js.
  // Without these handlers Electron grants whatever a page asks for.
  browseSession.setPermissionRequestHandler((_wc, permission, callback) => callback(isPermissionAllowed(permission)));
  browseSession.setPermissionCheckHandler((_wc, permission) => isPermissionAllowed(permission));
  browseSession.setDevicePermissionHandler(() => false);
  // Every file: request in a tab, a page's image as much as a navigation: one naming a host
  // (an SMB sign-in that sends the user's NTLM hash) is refused, a folder gets a plain listing,
  // and anything else is read as Chromium would.
  browseSession.protocol.handle('file', async (req) => {
    if (!isLocalFileUrl(req.url)) return new Response(null, { status: 403 });
    const where = fileURLToPath(req.url);
    if (fs.statSync(where, { throwIfNoEntry: false })?.isDirectory()) {
      const entries = (await fs.promises.readdir(where, { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory() }));
      return new Response(fileListing(req.url, entries), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
    }
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
  const devs = new DevServers(send);
  serveDocs(browseSession, {
    run: { title: 'Cronsole run', render: (url) => cron.page(url) },
    git: { title: 'Git diff', render: (url) => gitDiff(current().folder, url) },
    dev: { title: 'Dev server', render: async (url) => devs.page(url) },
    runlog: { title: 'Run', render: async (url) => runLog(url) },
    transcript: { title: 'Transcript', render: transcriptPage },
    settings: { title: 'Settings', render: () => settingsPage() },
    health: { title: 'Health', render: async () => docPage({ title: 'Health', trail: 'Houston › Health', body: healthBody(await healthSnapshot(), escapeHtml) }) },
    identities: { title: 'Identity Center', render: () => identitiesPage() },
    start: { title: 'Start', render: () => startPage() },
  });
  // Hub rescans on its own; reload the tree and drop the doc index when it says so.
  stopEvents = subscribeHubEvents(() => {
    invalidateDocsIndex();
    send('hub:changed');
  });
  const tabs = new Tabs({
    window: win,
    session: browseSession,
    send,
    onVisit: (url, title) => send('recent:changed', store.addRecent({ type: 'url', target: url, label: title || url })),
  });
  const terminals = new Terminals(send);
  // terminal_run's runs: a run ends when its session exits, and that exit code is its result.
  // runs.json keeps the history across restarts (the smoke run's is on its throwaway profile).
  const runs = new Runs(store.runs());
  const saveRuns = () => {
    try {
      store.saveRuns(runs.list);
    } catch (err) {
      logError('runs.json', err);
    }
    send('runs:changed');
  };
  /** The workspace repo's files by git status, or null outside a repo. @param {string} dir */
  const gitFiles = (dir) => gitStatus(dir).then((st) => (st.repo ? st.files : null), () => null);
  /** Each running run's git status from just before it started. @type {Map<number, Promise<import('../shared/git.js').GitFile[] | null>>} */
  const beforeRun = new Map();
  // The MCP panel's agent work: every ask from the confirm bar to its end.
  const activity = new Activity();
  const workChanged = () => send('activity:changed', activityRows(activity.list));
  /** @param {import('../shared/runs.js').Run | undefined} r */
  const runEnded = async (r) => {
    if (!r) return;
    if (activity.runEnded(r)) workChanged();
    saveRuns();
    const before = beforeRun.get(r.run);
    beforeRun.delete(r.run);
    if (!before) return;
    r.changed = changedFiles(await before, await gitFiles(r.cwd));
    saveRuns();
  };
  /** The active profile and the Core's list, for the 🧭 menu and Settings. The list is just the active one when the Core is down. */
  const profileInfo = async () => {
    const id = activeProfile();
    const list = process.platform === 'win32' ? await core.call('profile.list', {}, 3000).catch(() => null) : null;
    const all = /** @type {{ id: string, displayName: string, preset?: string | null }[]} */ (list ?? [{ id, displayName: id }]).map((p) => ({ id: p.id, displayName: p.displayName, preset: p.preset ?? null }));
    return { active: id, name: all.find((p) => p.id === id)?.displayName ?? id, list: all };
  };
  /** The acc://settings/ page: every control, its value now, its scope and where it's changed. */
  const settingsData = async () => {
    const settings = store.settings();
    const layout = store.layout();
    const ws = current();
    return {
      hubUrl: hub.url, hubToken: hub.token, quickLinks: settings.quickLinks.length, newsSources: settings.newsSources.length, feedIndex: settings.feedIndex, bookmarkSource: layout.bookmarkSource,
      adBlock: layout.adBlock, closeToTray: layout.closeToTray,
      chat: conversation.info(), cronsole: cron.info(), mcpUrl: mcp?.url ?? '',
      workspaces: spaces.list.length,
      workspace: { name: ws.name, folder: ws.folder ?? '', tabs: tabs.list().length, terminals: terminals.listSessions().filter((t) => t.ws === spaces.active).length },
      core: await coreSettings(),
      profile: await profileInfo(),
    };
  };
  const settingsPage = async () => docPage({ title: 'Settings', trail: 'Houston › Settings', body: settingsBody(await settingsData(), escapeHtml) });

  /** The acc://runlog/<id> page. @param {string} url */
  const runLog = (url) => {
    const id = runIdFromUrl(url);
    const r = id === null ? undefined : runs.get(id);
    if (!r) throw new Error('No run has this address. Only the last 50 are kept.');
    const raw = r.state === 'running' ? terminals.read(r.terminal)?.raw ?? '' : r.output ?? '';
    const ms = runInfo(r).durationMs;
    return runLogPage({
      run: r.run,
      command: r.command,
      cwd: r.cwd,
      state: runStateText(r),
      started: new Date(r.startedAt).toLocaleString(),
      took: ms === null ? null : `${(ms / 1000).toFixed(1)} s`,
      changed: r.changed,
      output: cleanOutput(raw).trimEnd(),
    });
  };
  terminals.onExit = (id, code) => runEnded(runs.end(id, code, terminals.read(id)?.raw ?? undefined));

  // Workspaces (workspaces.json): switching swaps the tabs and the conversation, and shows
  // that workspace's terminals. Terminals keep running while hidden; a workspace's saved
  // folders open as fresh shells, so a switch never re-runs a command.
  let spaces = store.workspaces();
  /** Workspaces shown this run: their saved terminal folders follow the live ones. */
  const visited = new Set([spaces.active]);
  const current = () => spaces.list.find((w) => w.id === spaces.active) ?? spaces.list[0];
  // The smoke run neither restores nor saves, so it can't disturb the real profile.
  const persistSpaces = () => { if (!process.env.ACC_SMOKE_DIR) store.saveWorkspaces(spaces); };
  persistSpaces();
  /** Fold the open tabs and this run's terminal folders into the saved state. */
  const snapshot = () => {
    const { urls, active } = tabs.snapshot();
    const kept = cleanSavedTabs(urls);
    // Dropped entries (blank pages) shift the index; point it at the same URL if kept.
    spaces = saveWorkspace(spaces, spaces.active, { tabs: kept, activeTab: active >= 0 ? kept.indexOf(urls[active]) : -1 });
    for (const id of visited) spaces = saveWorkspace(spaces, id, { terminals: terminals.folders(id) });
  };
  /** @param {import('../shared/workspaces.js').Workspace} w */
  const openTabs = (w) => {
    const created = w.tabs.map((url) => tabs.create(url, { activate: false }));
    const i = savedActiveIndex(w.activeTab, created.length);
    if (i >= 0) tabs.activate(created[i].id);
  };
  /** What the shell gets: the list, and the active one's folder and terminal folders. */
  const workspaceInfo = () => {
    const w = current();
    return { ...workspaceSummary(spaces), folder: w.folder, terminals: w.terminals, live: terminals.folders(w.id).length > 0 };
  };
  /** @param {string} id */
  const switchTo = (id) => {
    if (id === spaces.active) return workspaceInfo();
    if (!spaces.list.some((w) => w.id === id)) throw new Error(`No workspace ${id}`);
    if (conversation.busy) throw new Error('Wait for the chat to answer, or press Stop, before switching.');
    snapshot();
    spaces = { ...spaces, active: id };
    visited.add(id);
    persistSpaces();
    tabs.closeAll();
    openTabs(current());
    convs = store.conversations(id);
    conversation.reload();
    const out = workspaceInfo();
    send('workspace:changed', out);
    return out;
  };
  handle('workspace:info', () => workspaceInfo());
  handle('profile:info', () => profileInfo());
  // Switching relaunches: every file, the browser partition and every Core query start over in the new profile.
  handle('profile:switch', async (id) => {
    const want = String(id);
    if (want === activeProfile()) return false;
    const known = await core.call('profile.list').catch(() => []);
    if (!known.some((/** @type {any} */ p) => p.id === want)) throw new Error(`The Core has no profile ${want}. Make one with npm run ctl -- profile.create.`);
    setNextProfile(want);
    app.relaunch();
    app.quit();
    return true;
  });
  handle('workspace:switch', (id) => switchTo(String(id)));
  handle('workspace:add', (input) => {
    const { folder, name, hubId } = input && typeof input === 'object' ? input : {};
    const dir = drivePath(folder);
    if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${folder}`);
    const added = addWorkspace(spaces, { folder: dir, name, hubId });
    spaces = added.state;
    persistSpaces();
    return switchTo(added.id);
  });
  handle('workspace:remove', (id) => {
    const target = String(id);
    if (target === spaces.active) switchTo(spaces.list[0].id);
    spaces = removeWorkspace(spaces, target);
    visited.delete(target);
    store.removeChats(target);
    persistSpaces();
    const out = workspaceInfo();
    send('workspace:changed', out);
    return out;
  });

  /** @param {string} id @param {'code' | 'reveal' | 'default'} how @param {string} label */
  const openInHub = async (id, how, label) => {
    await hub.open(id, how);
    send('recent:changed', store.addRecent({ type: 'file', target: id, label }));
  };

  // terminal_run, cron_run, tab_click and tab_fill: the shell shows the command, the task's
  // name or the page action and answers yes or no. What runs and where stays here; the
  // answer can't change it.
  /** @type {Confirmations<boolean>} */
  const confirmations = new Confirmations({
    show: (ask) => send('mcp:confirm', ask),
    cancel: (id) => send('mcp:cancel', id),
    timeoutMs: CONFIRM_TIMEOUT_MS,
  });
  /**
   * Ask on the bar, and track the ask in the activity list. True only for Run.
   * @param {{ kind: import('../shared/activity.js').WorkKind, asked: string, target: string }} work
   * @param {Record<string, unknown>} payload what the bar shows
   * @param {AbortSignal | undefined} signal
   */
  const askFor = async (work, payload, signal) => {
    const w = activity.ask(work);
    workChanged();
    const answer = await confirmations.ask(payload, signal);
    activity.answered(w.id, answer, Boolean(signal?.aborted));
    workChanged();
    return answer === true ? w : null;
  };
  /** @param {number} id @param {'started' | 'succeeded' | 'failed'} state @param {unknown} [err] */
  const workEnded = (id, state, err) => {
    activity.settle(id, state, err === undefined ? null : err instanceof Error ? err.message : String(err));
    workChanged();
  };

  // The MCP server starts once there are tabs for its tools to look at.
  /** @type {import('../shared/tools.js').Sources} */
  const sources = {
    listTabs: () => tabs.list(),
    readTab: (id) => tabs.text(id),
    scan: () => hub.scan(),
    bookmarks: () => {
      const source = store.layout().bookmarkSource;
      return source === HUB_FAVORITES ? hub.favorites() : hub.webmarks(source || undefined);
    },
    recent: () => store.recent(),
    listTerminals: () => terminals.listSessions(),
    readTerminal: (id) => terminals.read(id),
    openTab: (url, activate) => tabs.create(url, { activate }),
    openFile: (id, how) => openInHub(id, how, id.split('/').pop() || id),
    // The command and folder are fixed here, before the bar shows them. On Run this opens
    // the run's own PowerShell session there, which runs exactly that and ends; the shell
    // only attaches a tab to it.
    runCommand: async (command, cwd, signal) => {
      const dir = cwd ?? terminals.defaultFolder(current().folder);
      if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cwd is not a folder: ${dir}`);
      const w = await askFor({ kind: 'command', asked: command, target: dir }, { command, cwd: dir }, signal);
      if (!w) return null;
      // Read git status before the command can touch anything, to list what it changed.
      const before = gitFiles(dir);
      await before;
      let t;
      try {
        t = terminals.create({ cwd: dir, ws: spaces.active, run: command });
      } catch (err) {
        workEnded(w.id, 'failed', err);
        throw err;
      }
      const r = runs.start({ terminal: t.id, command, cwd: t.cwd });
      beforeRun.set(r.run, before);
      saveRuns();
      activity.ranAs(w.id, r.run);
      workChanged();
      send('term:opened', t);
      return { run: r.run, terminal: t.id, cwd: t.cwd };
    },
    // While it runs, its output is the terminal's; once it ends, what the run kept.
    runStatus: (id) => {
      const r = runs.get(id);
      return r && { info: runInfo(r), raw: r.state === 'running' ? terminals.read(r.terminal)?.raw ?? '' : r.output ?? '' };
    },
    listCronTasks: () => cron.tasks(),
    runCronTask: async (id, signal) => {
      const task = (await cron.tasks()).find((t) => t.id === id);
      if (!task) throw new Error(`Cronsole has no task with id ${id}`);
      const w = await askFor({ kind: 'task', asked: task.name, target: id }, { task: task.name }, signal);
      if (!w) return null;
      try {
        const out = await cron.run(id);
        workEnded(w.id, 'started');
        return out;
      } catch (err) {
        workEnded(w.id, 'failed', err);
        throw err;
      }
    },
    tabElements: () => tabs.elements(),
    tabScreenshot: () => tabs.screenshot(),
    // The element, the text and the host are fixed here from the last list, before the bar shows them.
    tabAct: async (ref, text, signal) => {
      const { el, url } = tabs.listedElement(ref);
      if (text !== undefined && !el.fillable) throw new Error(`Element ${ref} is a ${elementLine(el)}, which doesn't take text`);
      const action = text === undefined ? `click ${elementLine(el)}` : `type "${text}" into ${elementLine(el)}`;
      const host = pageHost(url);
      const w = await askFor({ kind: 'page', asked: action, target: host }, { action, page: host }, signal);
      if (!w) return null;
      try {
        const out = await tabs.act(el, text);
        workEnded(w.id, 'succeeded');
        return out;
      } catch (err) {
        workEnded(w.id, 'failed', err);
        throw err;
      }
    },
  };
  // The Core's gateway serves this server to sessions (core.js offerMcp); a Core that starts after the app is told at its next Connections check.
  let mcpOffered = false;
  const offerMcp = () => { if (mcp && !mcpOffered) core.offerMcp(mcp).then((ok) => { mcpOffered = ok; }); };
  const callLog = mcpLog(send);
  handle('mcp:log', () => callLog.entries);
  handle('activity:list', () => activityRows(activity.list));
  handle('runs:list', (query) => runRows(runs.list, typeof query === 'string' ? query.slice(0, 200) : ''));
  // Terminals get the address and token, so `claude` in one can reach the app (README,
  // "Drive the app from Claude Code"). The shell loads after this, so even the first has them.
  const mcpReady = startMcp(allTools(sources), (e) => callLog.add(e))
    .then((m) => {
      mcp = m;
      terminals.env = { ACC_MCP_URL: m.url, ACC_MCP_TOKEN: m.token };
      console.log(`[mcp] listening on ${m.url}`);
      offerMcp();
    })
    .catch((err) => console.error('[mcp] failed to start; the app runs without it:', err));

  // The chat panel: Claude with this app's MCP server as its tools. Each workspace has
  // its own conversations (shared/conversations.js); `convs.active` is the open one,
  // null for a new one until its first message.
  convs = store.conversations(spaces.active);
  const conversation = chat({
    mcp: () => mcp,
    send,
    load: () => store.chat(spaces.active, convs.active),
    save: (m) => {
      if (!m.length) return;
      convs = touchConversation(convs, m, Date.now());
      store.saveChat(spaces.active, /** @type {string} */ (convs.active), m);
      store.saveConversations(spaces.active, convs);
    },
  });
  /** The Chat tab's list, every word of `query` matched against names and text. @param {unknown} query */
  const conversationList = (query) => {
    const q = typeof query === 'string' ? query.slice(0, 200) : '';
    const items = convs.list.map((e) => ({ ...e, text: q.trim() ? conversationText(store.chat(spaces.active, e.id)) : '' }));
    return { active: convs.active, name: convs.list.find((e) => e.id === convs.active)?.name ?? '', list: searchConversations(items, q) };
  };
  /** Change which conversation is open, then load it; never while Claude is answering. @param {(ix: typeof convs) => typeof convs} change */
  const switchConversation = (change) => {
    if (conversation.busy) throw new Error('Wait for the answer to the last message, or press Stop.');
    convs = change(convs);
    store.saveConversations(spaces.active, convs);
    conversation.reload();
    return conversationList('');
  };
  handle('chat:info', () => conversation.info());
  handle('chat:attach', (kind) => conversation.attach(kind));
  handle('chat:send', (text, ids) => conversation.send(text, ids));
  handle('chat:stop', () => conversation.stop());
  handle('chat:list', (query) => conversationList(query));
  handle('chat:new', () => switchConversation((ix) => ({ ...ix, active: null })));
  handle('chat:open', (id) => switchConversation((ix) => {
    if (!ix.list.some((e) => e.id === id)) throw new Error('No such conversation.');
    return { ...ix, active: /** @type {string} */ (id) };
  }));
  handle('chat:rename', (id, name) => {
    convs = renameConversation(convs, id, name, isConversationId(id) ? titleFrom(store.chat(spaces.active, String(id))) : '');
    store.saveConversations(spaces.active, convs);
    return conversationList('');
  });
  handle('chat:delete', (id) => {
    const out = switchConversation((ix) => removeConversation(ix, id));
    store.deleteChat(spaces.active, String(id));
    return out;
  });

  // Cronsole: its task list through its own MCP server, its UI in a pinned tab.
  handle('cronsole:info', () => cron.info());
  handle('cronsole:tasks', () => cron.tasks());
  handle('cronsole:history', (taskId) => cron.history(taskId));
  // The identity and standing grant a task runs under (H4): its command's --grant, then the Core's record of it.
  handle('cronsole:grant', async (taskId) => {
    const id = await cron.grant(taskId);
    if (!id) return null;
    try {
      return { id, standing: await core.call('standing.get', { id }) };
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      return { id, error: code === 'not_found' ? 'the Core has no standing grant by that name' : code === 'ENOENT' ? 'the Houston Core is not running' : code === 'unknown_method' ? 'the Core runs older code: restart it' : /** @type {Error} */ (e).message };
    }
  });

  // The Git tab: the active workspace's repo, read-only (src/main/git.js).
  handle('git:status', () => gitStatus(current().folder));

  // The Dev tab: servers started from the active workspace's package.json scripts
  // (src/main/devservers.js). The folder is always the workspace's; the renderer names a script.
  handle('dev:info', () => ({ folder: current().folder, ...devs.scripts(current().folder), servers: devs.list() }));
  handle('dev:start', (script) => devs.start(current().folder, String(script)));
  handle('dev:stop', (id) => devs.stop(Number(id)));
  handle('dev:restart', (id) => devs.restart(Number(id)));

  // The Connections view: the Core, Hub, Cronsole, each shell, the chat model and the MCP server.
  // Given a row's id it checks that one again (Retry), given a group ('shells') every row in it, and with none, all of them.
  /**
   * The Connections rows. Given a row's id it checks that one again (Retry), given a group ('shells') every row in it, and with none, all of them.
   * @param {string} [id]
   */
  const connectionRows = async (id) => {
    const want = (/** @type {string} */ key) => !id || id === key || (key === 'shells' && String(id).startsWith('shell:'));
    const cronRow = async () => {
      const info = cron.info();
      if (!info.configured) return cronsoleRow(info, null);
      try {
        return cronsoleRow(info, { count: (await cron.tasks()).length });
      } catch (err) {
        return cronsoleRow(info, { error: err instanceof Error ? err.message : String(err) });
      }
    };
    const groups = await Promise.all([
      want('core') ? core.status().then((s) => { if (s && !('error' in s)) offerMcp(); return [coreRow(s)]; }) : [],
      want('hub') ? hub.health().then((h) => [hubRow(hub.url, h, hub.token)]) : [],
      want('cronsole') ? cronRow().then((r) => [r]) : [],
      want('shells') ? shellRows(terminals.rescanShells()) : [],
      want('chat') ? [chatRow(conversation.info())] : [],
      want('mcp') ? [mcpRow(mcp)] : [],
    ]);
    return groups.flat().filter((r) => !id || r.id === id || (id === 'shells' && r.id.startsWith('shell:')));
  };
  handle('connections:check', (id) => connectionRows(id));

  // The health screen (acc://health/) and the diagnostics bundle: the Connections rows, the Core's own checks, the versions.
  const LOG_LINES = 200;
  /** @param {number} [log] core.log lines to ask the Core for */
  const coreHealth = (log = 0) => (process.platform !== 'win32' ? Promise.resolve(null)
    : core.call('core.health', { log }, 30_000).catch((/** @type {Error & { code?: string }} */ e) => ({ error: e.message, code: e.code })));
  /** @param {number} [log] */
  const healthSnapshot = async (log = 0) => {
    const [rows, h] = await Promise.all([connectionRows(), coreHealth(log)]);
    const info = {
      Houston: app.getVersion(), Electron: process.versions.electron, Chromium: process.versions.chrome, Node: process.versions.node,
      Windows: `${os.version()} (${os.release()})`, Profile: activeProfile(), 'Data folder': app.getPath('userData'),
    };
    return { app: info, rows: [...rows, ...coreHealthRows(h)], core: h };
  };
  saveDiagnostics = async () => {
    const now = new Date();
    const { app: info, rows, core: h } = await healthSnapshot(LOG_LINES);
    const text = diagnosticsBundle({
      created: now.toISOString(), app: info, rows, core: h, appLog: tailLines(path.join(app.getPath('userData'), 'logs', 'app.log'), LOG_LINES),
    }, { home: os.homedir(), secrets: appSecretValues() });
    const dir = path.join(app.getPath('userData'), 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, bundleName(now));
    fs.writeFileSync(file, text);
    return file;
  };

  handle('app:info', () => ({
    hubUrl: hub.url,
    quickLinks: store.settings().quickLinks,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    shell: terminals.shell,
    shells: terminals.list(),
    layout,
    browsePartition: BROWSE_PARTITION,
  }));
  handle('layout:save', (patch) => store.saveLayout(patch));

  handle('hub:health', () => hub.health());
  handle('hub:scan', (fresh) => hub.scan(Boolean(fresh)));
  handle('hub:webmarks', (source) => hub.webmarks(typeof source === 'string' ? source : undefined));
  handle('hub:favorites', () => hub.favorites());
  handle('hub:favorite', (url, name) => hub.favorite(String(url || ''), String(name || url || '')));
  handle('hub:open', (id, how, label) => openInHub(String(id), how === 'reveal' ? 'reveal' : how === 'default' ? 'default' : 'code', String(label || id)));

  // The News tab: each source settings.json lists, fetched or read here, never named by the renderer.
  handle('feed:list', () => feed.list());
  handle('feed:bookmark', (id) => feed.bookmark(id));
  handle('feed:discover', (id) => feed.discover(id));
  handle('news:list', async () => {
    const sources = store.settings().newsSources;
    const results = await Promise.all(sources.map(async (s) => {
      try {
        return { label: s.label, items: parseNews(await readNewsSource(s.url), s.label) };
      } catch (err) {
        return { label: s.label, items: [], error: err instanceof Error ? err.message : String(err) };
      }
    }));
    return {
      sources: results.map(({ label, items, error }) => ({ label, count: items.length, error })),
      items: mergeNews(results.map((r) => r.items)),
    };
  });

  handle('tabs:create', (input) => tabs.create(toUrl(String(input || 'about:blank'))).id);
  handle('tabs:activate', (id) => tabs.activate(Number(id)));
  handle('tabs:close', (id) => tabs.close(Number(id)));
  handle('tabs:navigate', (input) => tabs.navigate(toUrl(String(input))));
  handle('tabs:command', (action) => tabs.command(action));
  // Electron's findNext means "start a new session": true as the text changes, false to step.
  handle('tabs:find', (text, forward, newSession) => tabs.find(String(text).slice(0, 1000), { forward: forward !== false, findNext: Boolean(newSession) }));
  handle('tabs:stopFind', () => tabs.stopFind());
  on('tabs:bounds', (rect) => tabs.setBounds(rect));
  on('tabs:hidden', (hidden) => tabs.setHidden(Boolean(hidden)));
  // The shell asks once its tab listeners are wired. The smoke run neither restores
  // nor saves, so it can't disturb the real profile's tabs.
  let restored = Boolean(process.env.ACC_SMOKE_DIR);
  handle('tabs:restore', () => {
    if (restored) return;
    restored = true;
    // Settings › Startup: the start page instead of the last session's tabs.
    if (store.layout().startTab === 'start') { tabs.create('acc://start/'); return; }
    openTabs(current());
    // Nothing to restore: the start page (H6).
    if (!current().tabs.length) tabs.create('acc://start/');
  });
  handle('tabs:openExternal', (url) => {
    const u = String(url);
    if (/^https?:/i.test(u)) return shell.openExternal(u);
  });

  handle('term:create', (opts) => {
    const t = terminals.create({ ...opts, shell: opts?.shell ?? store.layout().defaultShell, ws: spaces.active });
    send('recent:changed', store.addRecent({ type: 'terminal', target: t.cwd, label: t.cwd }));
    return t;
  });
  on('term:write', (id, data) => terminals.write(Number(id), data));
  on('term:active', (id) => { terminals.activeId = Number.isInteger(id) ? id : null; });
  on('term:resize', (id, cols, rows) => terminals.resize(Number(id), cols, rows));
  // Closing a run's terminal before it ends is its Cancel.
  handle('term:kill', (id) => {
    runEnded(runs.cancel(Number(id), terminals.read(Number(id))?.raw ?? undefined));
    terminals.kill(Number(id));
  });

  // The Agents tab: the renderer names an identity or a session; the Core decides (agents.js).
  const agents = createAgents({ terminals, send, workspace: () => ({ id: spaces.active, folder: current().folder }) });
  handle('agents:info', () => agents.info());
  handle('agents:start', (identity) => agents.start(identity));
  handle('agents:open', (session) => agents.open(session));
  handle('agents:stop', (session) => agents.stop(session));
  handle('agents:lifecycle', (identity, action) => agents.lifecycle(identity, action));
  handle('agents:stopAll', () => stopAllSessions());
  handle('logs:query', (filter) => agents.logs(filter));
  handle('integrations:info', () => integrations.info());
  handle('integrations:install', (name) => integrations.install(name));
  handle('integrations:pin', (name, hash) => integrations.pin(name, hash));
  handle('integrations:disable', (name) => integrations.disable(name));
  handle('integrations:pauseGrant', (id) => integrations.pauseGrant(id));
  handle('integrations:resumeGrant', (id) => integrations.resumeGrant(id));
  handle('integrations:reviewMemory', (id, decision) => integrations.reviewMemory(id, decision));
  // The Core's approval inbox: what's waiting, and the operator's answer (approvals.js).
  const approvals = watchApprovals(send);
  handle('approvals:list', () => approvals.list());
  handle('approvals:decide', (id, answer) => approvals.decide(id, answer));

  handle('mcp:answer', (id, answer) => confirmations.settle(Number(id), answer === true));

  // A native menu, so it draws over the browser view instead of under it.
  handle('menu:popup', (items) => new Promise((resolve) => {
    const template = menuItems(items).map((i) => (i === '-'
      ? { type: /** @type {const} */ ('separator') }
      : { label: i.label, click: () => resolve(i.id) }));
    // ponytail: on Windows the close callback can fire before the click, so give the
    // click a moment to win; a picked item always resolves first if it fires at all.
    Menu.buildFromTemplate(template).popup({ callback: () => setTimeout(() => resolve(null), 100) });
  }));

  handle('recent:list', () => store.recent());
  handle('recent:add', (item) => store.addRecent(item));

  handle('ext:list', () => listExtensions(browseSession));

  win.on('close', (e) => {
    snapshot();
    persistSpaces();
    // Hidden, not closed: terminals, dev servers and the MCP server keep running.
    if (!quitting && tray && store.layout().closeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    terminals.killAll();
    devs.stopAll();
    win = null;
    shellView = null;
  });

  // Extensions before the shell loads, so <browser-action-list> finds them on first paint.
  try {
    await setupExtensions({ browseSession, shellSession: shellView.webContents.session, window: win, tabs });
  } catch (err) {
    console.error('[extensions] setup failed; browsing still works without them:', err);
  }

  /** @type {import('@ghostery/adblocker-electron').ElectronBlocker | null} */
  let blocker = null;
  const window = win;
  /** @returns {Electron.MenuItemConstructorOptions} */
  const adBlockItem = () => ({
    label: blocker ? 'Block ads and trackers' : 'Block ads and trackers (loading lists…)',
    type: 'checkbox',
    checked: store.layout().adBlock,
    enabled: blocker !== null,
    click: (/** @type {Electron.MenuItem} */ mi) => {
      store.saveLayout({ adBlock: mi.checked });
      if (mi.checked) blocker?.enableBlockingInSession(browseSession);
      else blocker?.disableBlockingInSession(browseSession);
    },
  });
  // A tick later: during 'extension-unloaded' the extension is still in the list.
  const rebuild = () => setImmediate(() => buildMenu([adBlockItem(), { type: 'separator' }, ...extensionsMenu(browseSession, tabs, window)]));
  rebuild();
  // Installs from the Web Store and removals change the list.
  browseSession.extensions.on('extension-loaded', rebuild);
  browseSession.extensions.on('extension-unloaded', rebuild);
  // In the background: a first run downloads the lists, and browsing shouldn't wait for that.
  loadBlocker().then((b) => {
    blocker = b;
    if (store.layout().adBlock) b.enableBlockingInSession(browseSession);
    rebuild();
  }, (err) => console.error('[adblock] filter lists failed to load; browsing without blocking:', err));

  // The Settings pane (src/renderer/prefs.js): the app's preferences, each change checked by
  // prefChange() and applied here; the agent and security controls come back read-only.
  const prefs = async () => {
    const l = store.layout();
    const raw = store.rawSettings();
    const s = store.settings();
    return {
      closeToTray: l.closeToTray, adBlock: l.adBlock, theme: l.theme, startTab: l.startTab, startTerminal: l.startTerminal, tabLabels: l.tabLabels,
      defaultShell: terminals.list().some((t) => t.id === l.defaultShell) ? l.defaultShell : terminals.list()[0]?.id ?? '',
      shells: terminals.list(),
      hubUrl: typeof raw.hubUrl === 'string' ? raw.hubUrl : '', hubDefault: DEFAULT_HUB_URL, hubFromEnv: Boolean(env.ACC_HUB_URL), hubNow: hub.url,
      quickLinks: Array.isArray(raw.quickLinks) ? s.quickLinks : [],
      newsSources: s.newsSources,
      feedIndex: s.feedIndex ?? '',
      readOnly: controls(await settingsData()).filter((c) => !PANE_ROWS.has(c.label)),
    };
  };
  handle('prefs:get', prefs);
  handle('prefs:set', async (key, value) => {
    const c = prefChange(String(key), value, { shells: terminals.list().map((t) => t.id), remoteHub: env.ACC_HUB_REMOTE === '1' });
    if (c.file === 'settings') store.saveSetting(c.key, c.value);
    else if (c.key === 'closeToTray') setCloseToTray(Boolean(c.value));
    else store.saveLayout({ [c.key]: c.value });
    if (c.key === 'theme') nativeTheme.themeSource = store.layout().theme;
    if (c.key === 'adBlock') {
      if (c.value) blocker?.enableBlockingInSession(browseSession);
      else blocker?.disableBlockingInSession(browseSession);
      rebuild();
    }
    return prefs();
  });
  // A new Project Hub address is read at start (src/main/hub.js), so the pane offers a restart.
  handle('prefs:restart', () => { app.relaunch(); app.quit(); });

  if (process.env.ACC_SMOKE_DIR) smoke(process.env.ACC_SMOKE_DIR, shellView.webContents, tabs, terminals, browseSession, saveDiagnostics);
  await mcpReady;
  await shellView.webContents.loadURL('acc://shell/index.html');
}

app.on('second-instance', (_e, argv) => { if (argv.includes('--quit')) app.quit(); else showWindow(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  // Every terminal was killed as the window closed (win 'closed'). Exiting while node-pty
  // still has their ConPTY output threads running throws in conpty.node during teardown
  // (0xC0000409 or 0xE06D7363), so hold the quit until they've stopped, then quit again.
  const ms = ptyDrainMs();
  if (ms > 0) { e.preventDefault(); setTimeout(() => app.quit(), ms); }
});

logCrashes();
app.whenReady().then(() => {
  nativeTheme.themeSource = store.layout().theme;
  serveShell();
  buildMenu();
  createTray().catch((err) => logError('tray', err));
  return createWindow();
}).catch((err) => {
  logError('startup', err);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());

// node-pty's ConPTY output reader runs on a worker thread that outlives its session, so
// the process reaches 'quit' and then never exits. Every window is closed and every
// terminal killed by this point (win 'closed'), and will-quit waited for their threads, so exit explicitly.
app.on('quit', () => {
  tray?.destroy();
  mcp?.close();
  cron.close();
  stopEvents?.();
  // process.exitCode: the smoke run's verdict; 0 otherwise.
  setImmediate(() => app.exit(Number(process.exitCode ?? 0)));
});
