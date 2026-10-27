// Shell UI entry point: wires the sidebar, the browser tab strip and address bar, and
// the terminal panel, and keeps the main process told where the browser pane sits.

import { Sidebar, toast } from './sidebar.js';
import { startChat } from './chat.js';
import { TerminalPanel } from './terminal.js';
import { createPalette } from './palette.js';
import { createConnections } from './connections.js';
import { defaultAction, search } from './shared/tree.js';
import { docUrl, isDocUrl } from './shared/docs.js';
import { cycleTab, pickTab } from './shared/session.js';
import { isCronsoleUrl } from './shared/cronsole.js';
import { isFavorite } from './shared/favorites.js';

/** @type {any} */
const api = /** @type {any} */ (window).acc;
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const info = await api.info();
const cron = await api.cronsole.info();
/** @typedef {{ active: string, list: { id: string, name: string, folder: string, hubId: string }[], folder: string, terminals: string[], live: boolean }} SpaceInfo */
/** @type {SpaceInfo} */
let space = await api.workspace.info();
const layout = info.layout;
const appEl = $('app');
const mainEl = $('main');
const content = $('content');
const address = /** @type {HTMLInputElement} */ ($('address'));
const star = /** @type {HTMLButtonElement} */ ($('star'));
/** Hub's favorites, for the address-bar star; refreshed on load and after each toggle. */
let favorites = /** @type {any[]} */ ([]);

// ---- layout ----------------------------------------------------------------

document.documentElement.style.setProperty('--sidebar-w', `${layout.sidebarWidth}px`);
document.documentElement.style.setProperty('--term-h', `${layout.terminalHeight}px`);
mainEl.classList.toggle('no-terminal', !layout.terminalOpen);
document.documentElement.style.setProperty('--chat-w', `${layout.chatWidth}px`);
appEl.classList.toggle('no-chat', !layout.chatOpen);
$('chat-toggle').setAttribute('aria-pressed', String(layout.chatOpen));

function reportBounds() {
  const r = content.getBoundingClientRect();
  api.tabs.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(reportBounds).observe(content);
window.addEventListener('resize', reportBounds);

/**
 * Drag a splitter. The browser pane is a separate view that swallows mouse events, so
 * it's hidden for the length of the drag.
 * @param {HTMLElement} handle
 * @param {(e: PointerEvent) => void} move
 * @param {() => void} done
 */
function dragSplitter(handle, move, done) {
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    api.tabs.setHidden(true);
    const onMove = (/** @type {PointerEvent} */ ev) => move(ev);
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      api.tabs.setHidden(false);
      reportBounds();
      terminals.fitActive();
      done();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
  });
}

dragSplitter($('side-split'), (e) => {
  layout.sidebarWidth = Math.min(600, Math.max(200, e.clientX));
  document.documentElement.style.setProperty('--sidebar-w', `${layout.sidebarWidth}px`);
}, () => api.saveLayout({ sidebarWidth: layout.sidebarWidth }));

dragSplitter($('term-split'), (e) => {
  layout.terminalHeight = Math.min(window.innerHeight - 200, Math.max(120, window.innerHeight - e.clientY));
  document.documentElement.style.setProperty('--term-h', `${layout.terminalHeight}px`);
}, () => api.saveLayout({ terminalHeight: layout.terminalHeight }));

// The chat pane on the right; its width leaves the browser at least 320 px.
dragSplitter($('chat-split'), (e) => {
  const room = window.innerWidth - (appEl.classList.contains('no-sidebar') ? 0 : layout.sidebarWidth) - 320;
  layout.chatWidth = Math.max(260, Math.min(800, room, window.innerWidth - e.clientX));
  document.documentElement.style.setProperty('--chat-w', `${layout.chatWidth}px`);
}, () => api.saveLayout({ chatWidth: layout.chatWidth }));

/** Show or hide the chat pane, and remember it. @param {boolean} open */
function setChatOpen(open) {
  appEl.classList.toggle('no-chat', !open);
  layout.chatOpen = open;
  $('chat-toggle').setAttribute('aria-pressed', String(open));
  api.saveLayout({ chatOpen: open });
  requestAnimationFrame(() => { reportBounds(); terminals.fitActive(); });
  if (open) $('chat-input').focus();
}
$('chat-toggle').addEventListener('click', () => setChatOpen(appEl.classList.contains('no-chat')));
$('chat-hide').addEventListener('click', () => setChatOpen(false));

// ---- terminals ---------------------------------------------------------------

const terminals = new TerminalPanel({ host: $('term-host'), tabs: $('term-tabs'), api, openLink: (url) => openUrl(url) });

/** @param {boolean} open */
function setTerminalOpen(open) {
  mainEl.classList.toggle('no-terminal', !open);
  layout.terminalOpen = open;
  api.saveLayout({ terminalOpen: open });
  requestAnimationFrame(() => { reportBounds(); terminals.fitActive(); });
}

/** @param {string} [cwd] the workspace's folder when left out @param {string} [shell] */
async function openTerminal(cwd, shell) {
  setTerminalOpen(true);
  cwd ||= space.folder || undefined;
  try {
    return await terminals.open(cwd, shell);
  } catch (err) {
    toast(`Couldn't start a terminal: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

$('term-new').addEventListener('click', () => openTerminal());
$('term-shells').addEventListener('click', async () => {
  const picked = await api.menu(info.shells.map((/** @type {{ id: string, label: string }} */ s) => ({ id: s.id, label: s.label })));
  if (picked) openTerminal(undefined, picked);
});

// ---- terminal_run, cron_run, tab_click and tab_fill confirmations ------------
// One bar at a time over the terminal; the rest wait their turn. Main holds the
// command and folder; Run answers true, and main opens the run's own terminal, which
// arrives here through term:opened.

/** @type {{ id: number, command?: string, cwd?: string, task?: string, action?: string, page?: string }[]} */
const asks = [];

function showAsk() {
  const ask = asks[0];
  $('confirm-bar').hidden = !ask;
  if (!ask) return;
  if (mainEl.classList.contains('no-terminal')) setTerminalOpen(true);
  // A command names the terminal it goes to; a Cronsole task (cron_run) names Cronsole; a
  // click or typing (tab_click, tab_fill) names the attached tab's host.
  $('confirm-cmd').textContent = ask.task ?? ask.action ?? ask.command ?? '';
  $('confirm-where').textContent = ask.task !== undefined ? 'Cronsole'
    : ask.page !== undefined ? `the tab attached for agents, at ${ask.page}`
      : `its own PowerShell terminal in ${ask.cwd ?? 'your home folder'}, which ends with the command`;
  // Deny takes focus, so an Enter meant for the terminal can't run the command.
  $('confirm-deny').focus();
}

/** @param {boolean} run */
async function answerAsk(run) {
  const ask = asks.shift();
  if (!ask) return;
  $('confirm-bar').hidden = true;
  await api.mcp.answer(ask.id, run ? true : null);
  showAsk();
}

// A run's terminal, opened by main on Run: shown and brought forward.
api.term.onOpened((/** @type {any} */ t) => {
  setTerminalOpen(true);
  terminals.activate(terminals.attach(t));
});

$('confirm-run').addEventListener('click', () => answerAsk(true));
$('confirm-deny').addEventListener('click', () => answerAsk(false));
api.mcp.onConfirm((/** @type {{ id: number, command?: string, task?: string }} */ ask) => {
  asks.push(ask);
  if (asks.length === 1) showAsk();
});
api.mcp.onCancel((/** @type {number} */ id) => {
  const i = asks.findIndex((a) => a.id === id);
  if (i < 0) return;
  asks.splice(i, 1);
  if (i === 0) showAsk();
});
$('term-toggle').addEventListener('click', () => setTerminalOpen(false));

// ---- browser tabs ------------------------------------------------------------

// Extension toolbar buttons (LastPass, Rakuten, …) from electron-chrome-extensions.
/** @type {HTMLElement | null} */
let actions = null;
if (customElements.get('browser-action-list')) {
  actions = document.createElement('browser-action-list');
  actions.setAttribute('partition', info.browsePartition);
  actions.setAttribute('alignment', 'bottom left');
  $('actions-host').append(actions);
}

/** @type {Map<number, HTMLElement>} */
const tabEls = new Map();
/** @type {Map<number, { url: string, title: string, loading: boolean, canGoBack: boolean, canGoForward: boolean }>} */
const tabState = new Map();
/** @type {number | null} */
let activeTab = null;

/** @param {string} url @param {{ background?: boolean }} [opts] */
async function openUrl(url, opts = {}) {
  const prev = activeTab;
  const id = await api.tabs.create(url);
  if (opts.background && prev !== null) api.tabs.activate(prev);
  return id;
}

/**
 * Show a Hub file or folder as a document page (acc://doc). Reuses a tab already
 * showing one, so clicking through files moves one tab along; Ctrl+click opens another.
 * @param {string} id
 * @param {{ newTab?: boolean }} [opts]
 */
async function viewDoc(id, opts = {}) {
  const url = docUrl(id);
  const docTab = opts.newTab ? undefined : [...tabState].find(([, t]) => t.url && isDocUrl(t.url))?.[0];
  if (docTab === undefined) return openUrl(url);
  await api.tabs.activate(docTab);
  await api.tabs.navigate(url);
}

api.tabs.onCreated((/** @type {any} */ t) => {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = String(t.id);
  el.setAttribute('role', 'tab');
  el.innerHTML = '<img alt="" hidden><span class="title">New tab</span><button class="close" aria-label="Close tab">×</button>';
  el.addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('.close')) api.tabs.close(t.id);
    else api.tabs.activate(t.id);
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1 && !el.classList.contains('pinned')) api.tabs.close(t.id); });
  $('tab-list').append(el);
  tabEls.set(t.id, el);
  updateTab(t);
  $('empty').hidden = true;
});

api.tabs.onUpdate(updateTab);

/** Cronsole's UI: the pinned tab if there is one, else a new tab that becomes it. */
function openCronsole() {
  const pinned = [...tabEls].find(([, el]) => el.classList.contains('pinned'))?.[0];
  if (pinned === undefined) openUrl(cron.ui);
  else api.tabs.activate(pinned);
}

/** @param {any} t */
function updateTab(t) {
  const el = tabEls.get(t.id);
  if (!el) return;
  tabState.set(t.id, { ...(tabState.get(t.id) || {}), ...t });
  const title = t.title || t.url || 'New tab';
  /** @type {HTMLElement} */ (el.querySelector('.title')).textContent = title;
  el.title = `${title}\n${t.url}${t.agent ? '\nAttached for agents: they can ask to click and type here' : ''}`;
  el.classList.toggle('loading', Boolean(t.loading));
  el.classList.toggle('agent', Boolean(t.agent));
  // A tab showing Cronsole's UI is the pinned one: first in the strip, no close button.
  const pinned = Boolean(t.url) && isCronsoleUrl(t.url, cron.ui);
  el.classList.toggle('pinned', pinned);
  if (pinned && el.parentElement?.firstElementChild !== el) $('tab-list').prepend(el);
  if (t.favicon !== undefined) {
    const img = /** @type {HTMLImageElement} */ (el.querySelector('img'));
    img.hidden = !t.favicon;
    if (t.favicon) img.src = t.favicon;
  }
  if (t.id === activeTab) syncNavbar();
}

api.tabs.onActivated((/** @type {number} */ id) => {
  if (id !== activeTab && !findForm.hidden) closeFind();
  activeTab = id;
  for (const [tid, el] of tabEls) {
    el.classList.toggle('active', tid === id);
    el.setAttribute('aria-selected', String(tid === id));
  }
  tabEls.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  actions?.setAttribute('tab', String(id));
  syncNavbar();
});

api.tabs.onClosed((/** @type {number} */ id) => {
  tabEls.get(id)?.remove();
  tabEls.delete(id);
  tabState.delete(id);
  if (activeTab === id) activeTab = null;
  if (!tabEls.size) {
    $('empty').hidden = false;
    address.value = '';
    syncNavbar();
  }
});

/** Tab ids in the order the strip shows them (the pinned tab first). */
const tabOrder = () => [...$('tab-list').querySelectorAll('.tab')].map((el) => Number(/** @type {HTMLElement} */ (el).dataset.id));

function syncNavbar() {
  const s = activeTab !== null ? tabState.get(activeTab) : null;
  if (document.activeElement !== address) address.value = s?.url && s.url !== 'about:blank' ? s.url : '';
  /** @type {HTMLButtonElement} */ (document.querySelector('[data-cmd="back"]')).disabled = !s?.canGoBack;
  /** @type {HTMLButtonElement} */ (document.querySelector('[data-cmd="forward"]')).disabled = !s?.canGoForward;
  syncStar();
}

/** The address-bar ☆: only a web page can be starred, and it shows filled when it is. */
function syncStar() {
  const s = activeTab !== null ? tabState.get(activeTab) : null;
  const url = s?.url;
  const starrable = Boolean(url) && /^https?:/i.test(url);
  star.hidden = !starrable;
  if (!starrable) return;
  const on = isFavorite(favorites, url);
  star.textContent = on ? '★' : '☆';
  star.classList.toggle('starred', on);
  star.setAttribute('aria-pressed', String(on));
  star.title = on ? 'Remove from Project Hub favorites' : 'Add to Project Hub favorites';
}

star.addEventListener('click', async () => {
  const s = activeTab !== null ? tabState.get(activeTab) : null;
  const url = s?.url;
  if (!url || !/^https?:/i.test(url)) return;
  try {
    const out = await api.hub.favorite(url, s?.title || url);
    favorites = out.roots || [];
    toast(out.starred ? `Added to Hub favorites: ${url}` : `Removed from Hub favorites: ${url}`);
    syncStar();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
});

$('address-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = address.value.trim();
  if (!text) return;
  if (activeTab === null) api.tabs.create(text);
  else api.tabs.navigate(text);
  address.blur();
});
address.addEventListener('focus', () => address.select());
for (const btn of document.querySelectorAll('[data-cmd]')) {
  btn.addEventListener('click', () => api.tabs.command(/** @type {HTMLElement} */ (btn).dataset.cmd));
}
$('new-tab').addEventListener('click', newTab);
$('open-external').addEventListener('click', () => {
  const s = activeTab !== null ? tabState.get(activeTab) : null;
  if (s?.url) api.tabs.openExternal(s.url);
});

function newTab() {
  address.value = '';
  address.focus();
  activeTab = null;
  for (const el of tabEls.values()) el.classList.remove('active');
  api.tabs.setHidden(true);
  $('empty').hidden = false;
}
address.addEventListener('blur', () => {
  // Leaving the address bar without navigating returns to the tab that was showing.
  setTimeout(() => {
    if (activeTab === null && tabEls.size && document.activeElement !== address) {
      api.tabs.activate([...tabEls.keys()].pop());
      $('empty').hidden = true;
    }
  }, 150);
});

// From settings.json (src/shared/settings.js); Project Hub and the Web Store by default.
for (const { label, url } of info.quickLinks) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = url;
  b.addEventListener('click', () => openUrl(url));
  $('quick-links').append(b);
}

// ---- find in page --------------------------------------------------------------

const findForm = $('find-form');
const findInput = /** @type {HTMLInputElement} */ ($('find-input'));

function openFind() {
  findForm.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) api.tabs.find(findInput.value, true, true);
}
function closeFind() {
  findForm.hidden = true;
  $('find-count').textContent = '';
  api.tabs.stopFind();
}
findInput.addEventListener('input', () => {
  if (findInput.value) api.tabs.find(findInput.value, true, true);
  else { $('find-count').textContent = ''; api.tabs.stopFind(); }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (findInput.value) api.tabs.find(findInput.value, !e.shiftKey, false); }
  if (e.key === 'Escape') closeFind();
});
$('find-next').addEventListener('click', () => findInput.value && api.tabs.find(findInput.value, true, false));
$('find-prev').addEventListener('click', () => findInput.value && api.tabs.find(findInput.value, false, false));
$('find-close').addEventListener('click', closeFind);
api.tabs.onFound((/** @type {number} */ id, /** @type {{ active: number, total: number }} */ r) => {
  if (id === activeTab && !findForm.hidden) $('find-count').textContent = r.total ? `${r.active}/${r.total}` : '0/0';
});

// ---- sidebar -----------------------------------------------------------------

const sidebar = new Sidebar({ api, layout, openUrl, openTerminal: (cwd) => openTerminal(cwd), viewDoc, openCronsole });

// ---- workspaces --------------------------------------------------------------

const spaceBtn = $('workspace');

/**
 * Show a workspace: its name, its Files folder and its terminals. Main has already
 * swapped the tabs and the conversation. A workspace with no terminals running yet
 * opens fresh shells in its saved folders; nothing is typed into them.
 * @param {SpaceInfo} w
 */
async function showSpace(w) {
  space = w;
  const cur = w.list.find((x) => x.id === w.active);
  spaceBtn.textContent = `🧭 ${cur && w.active !== 'default' ? cur.name : 'Houston'}`;
  spaceBtn.title = `Workspace: ${cur?.name || 'Default'}${w.folder ? ` (${w.folder})` : ''}. Click to switch; right-click a folder in Files to add one.`;
  sidebar.setRoot(cur?.hubId || '');
  terminals.showWorkspace(w.active);
  if (w.live || !layout.terminalOpen) return;
  for (const dir of w.terminals.length ? w.terminals : [w.folder]) await openTerminal(dir || undefined);
}
api.workspace.onChanged((/** @type {SpaceInfo} */ w) => showSpace(w));

spaceBtn.addEventListener('click', async () => {
  const cur = space.list.find((x) => x.id === space.active);
  const picked = await api.menu([
    ...space.list.map((w) => ({ id: `go:${w.id}`, label: `${w.id === space.active ? '✓ ' : '    '}${w.name}` })),
    '-',
    ...(cur && cur.id !== 'default' ? [{ id: 'remove', label: `Remove "${cur.name}" (its folder stays)` }] : []),
    { id: 'add', label: 'Add a workspace: right-click a folder in Files…' },
  ]);
  try {
    if (picked?.startsWith('go:')) await api.workspace.switch(picked.slice(3));
    if (picked === 'remove') await api.workspace.remove(space.active);
    if (picked === 'add') sidebar.show('files');
  } catch (err) {
    toast(errText(err));
  }
});

// ---- shortcuts and the command palette -------------------------------------------

/** What the palette lists as actions: label, shortcut, and the action runAction takes. */
const ACTIONS = [
  ['New tab', 'Ctrl+T', 'new-tab'],
  ['Close tab', 'Ctrl+W', 'close-tab'],
  ['Reopen closed tab', 'Ctrl+Shift+T', 'reopen-tab'],
  ['Focus address bar', 'Alt+D', 'focus-address'],
  ['Reload page', 'F5', 'reload'],
  ['Find in page', 'Ctrl+F', 'find'],
  ['Zoom in', 'Ctrl+=', 'zoom-in'],
  ['Zoom out', 'Ctrl+-', 'zoom-out'],
  ['Reset zoom', 'Ctrl+0', 'zoom-reset'],
  ['Page developer tools', 'F12', 'devtools'],
  ['New terminal', 'Ctrl+Shift+`', 'new-terminal'],
  ['Toggle terminal', 'Ctrl+`', 'toggle-terminal'],
  ['Toggle sidebar', 'Ctrl+B', 'toggle-sidebar'],
  ['Toggle chat', 'Ctrl+Shift+L', 'toggle-chat'],
  ['Search everything', 'Ctrl+Shift+F', 'focus-search'],
  ['Open Cronsole', 'pinned tab', 'open-cronsole'],
  ['Connections', 'Hub, Cronsole, shells, chat, MCP', 'connections'],
  ...['Files', 'Bookmarks', 'Recent', 'MCP', 'Cron', 'Git', 'Dev'].map((p) => [`Show ${p}`, 'sidebar', `panel-${p.toLowerCase()}`]),
];

const palette = createPalette({
  items: () => [
    // An empty box lists what's open first, then the actions.
    ...space.list.map((w) => ({
      kind: /** @type {const} */ ('workspace'),
      label: `Workspace: ${w.name}`,
      detail: `${w.folder || 'the whole Project Hub tree'}${w.id === space.active ? ' · current' : ''}`,
      run: () => api.workspace.switch(w.id).catch((/** @type {unknown} */ err) => toast(errText(err))),
    })),
    ...[...tabEls.keys()].map((id) => {
      const t = tabState.get(id) || {};
      return { kind: /** @type {const} */ ('tab'), label: t.title || t.url || 'New tab', detail: t.url || '', run: () => api.tabs.activate(id) };
    }),
    ...terminals.list().map((t) => ({
      kind: /** @type {const} */ ('terminal'),
      label: t.title,
      detail: t.cwd,
      run: () => { setTerminalOpen(true); terminals.activate(t.id); },
    })),
    ...ACTIONS.map(([label, keys, action]) => ({ kind: /** @type {const} */ ('action'), label, detail: keys, run: () => runAction(action) })),
  ],
  // Folders view as a listing; everything else does what a click in Files does.
  files: (q) => search(sidebar.fileIndex, q, 20).map(({ node, path }) => ({
    kind: /** @type {const} */ ('file'),
    label: node.name,
    detail: path,
    run: () => { const a = defaultAction(node); sidebar.fileAction(node, a === 'expand' ? 'view' : a); },
  })),
  onOpen: () => api.tabs.setHidden(true),
  // The empty new-tab page keeps the tab view hidden.
  onClose: () => { if (activeTab !== null) api.tabs.setHidden(false); },
});

const connections = createConnections({
  api,
  onOpen: () => api.tabs.setHidden(true),
  onClose: () => { if (activeTab !== null) api.tabs.setHidden(false); },
  // Hub answering again: the status dot and, if it was down, the Files tree catch up.
  onChecked: (rows) => {
    const h = rows.find((r) => r.id === 'hub');
    if (!h) return;
    if (h.state === 'ok' && sidebar.el.status.classList.contains('bad')) sidebar.loadFiles();
    sidebar.checkHub();
  },
});
sidebar.el.status.addEventListener('click', () => connections.open());
sidebar.el.status.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); connections.open(); } });

/** @param {unknown} err */
function errText(err) {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

/** A menu shortcut or a palette action. @param {string} action */
function runAction(action) {
  if (action === 'palette') palette.open();
  if (action === 'connections') connections.open();
  if (action === 'open-cronsole') openCronsole();
  if (action.startsWith('panel-')) {
    appEl.classList.remove('no-sidebar');
    requestAnimationFrame(reportBounds);
    sidebar.show(action.slice(6));
  }
  if (action === 'new-tab') newTab();
  if (action === 'close-tab' && activeTab !== null) api.tabs.close(activeTab);
  if (action === 'focus-address') address.focus();
  if (action === 'toggle-terminal') {
    const open = mainEl.classList.contains('no-terminal');
    setTerminalOpen(open);
    if (open && !terminals.size) openTerminal();
    else if (open) terminals.focus();
  }
  if (action === 'new-terminal') openTerminal();
  if (action === 'focus-search') {
    appEl.classList.remove('no-sidebar');
    sidebar.focusSearch();
  }
  if (action === 'toggle-sidebar') {
    appEl.classList.toggle('no-sidebar');
    requestAnimationFrame(reportBounds);
  }
  if (action === 'toggle-chat') setChatOpen(appEl.classList.contains('no-chat'));
  if (action === 'reload') api.tabs.command('reload');
  if (action === 'find') openFind();
  if (action === 'devtools') api.tabs.command('devtools');
  if (action === 'reopen-tab') api.tabs.command('reopen');
  if (action.startsWith('zoom-')) api.tabs.command(action);
  if (action === 'next-tab' || action === 'prev-tab') {
    const id = cycleTab(tabOrder(), activeTab, action === 'next-tab' ? 1 : -1);
    if (id !== null) api.tabs.activate(id);
  }
  if (action.startsWith('tab-')) {
    const id = pickTab(tabOrder(), action === 'tab-last' ? 9 : Number(action.slice(4)));
    if (id !== null) api.tabs.activate(id);
  }
}
api.onShortcut(runAction);

// ---- start -------------------------------------------------------------------

reportBounds();
api.tabs.restore();
showSpace(space);
api.hub.favorites().then((f) => { favorites = f.roots || []; syncStar(); }).catch(() => {});
sidebar.load();
startChat(api);
