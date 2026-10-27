// Browser tabs. Each tab is a WebContentsView in the browse session, stacked above
// the shell view and sized to the rectangle the shell renderer reports for the
// content area. Only the active tab is visible.

import { Menu, WebContentsView, clipboard, shell } from 'electron';
import { isAllowedNavigation } from '../shared/url.js';
import { cleanSavedTabs } from '../shared/session.js';
import { AGENT_WORLD, ELEMENTS_MAX, cleanElements, listScript, prepareScript } from '../shared/pageactions.js';

const MAX_CLOSED = 10;

/**
 * Navigation and pop-up rules for a page in a tab or in a pop-up it opened. Checks are
 * page-initiated, so the page's own URL goes along: a web page can't open acc://doc.
 * Links and plain window.open become tabs. A real pop-up (window.open with window
 * features, as "Sign in with Google" uses) opens as its own window, because the login
 * hands its result back through window.opener, which a tab wouldn't have. It inherits
 * the opener's sandboxed webPreferences and gets these same rules.
 * @param {Electron.WebContents} wc
 * @param {(url: string) => void} openTab
 */
function guardPage(wc, openTab) {
  // A page that hasn't committed a URL yet (a pop-up from window.open('')) still asks as
  // a page: an empty `from` would read as the app and let it reach file: or acc://.
  const from = () => wc.getURL() || 'about:blank';
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!isAllowedNavigation(url, from())) return { action: 'deny' };
    if (disposition === 'new-window') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    openTab(url);
    return { action: 'deny' };
  });
  wc.on('did-create-window', (win) => guardPage(win.webContents, openTab));
  wc.on('will-navigate', (e, target) => {
    if (!isAllowedNavigation(target, from())) e.preventDefault();
  });
  wc.on('will-redirect', (e, target) => {
    if (!isAllowedNavigation(target, from())) e.preventDefault();
  });
}

/**
 * @typedef {{ id: number, view: WebContentsView }} Tab
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

export class Tabs {
  /**
   * @param {{
   *   window: import('electron').BaseWindow,
   *   session: import('electron').Session,
   *   send: (channel: string, ...args: unknown[]) => void,
   *   onVisit: (url: string, title: string) => void,
   * }} opts
   */
  constructor({ window, session, send, onVisit }) {
    this.window = window;
    this.session = session;
    this.send = send;
    this.onVisit = onVisit;
    /** @type {Map<number, Tab>} */
    this.tabs = new Map();
    /** @type {number | null} */
    this.activeId = null;
    /** @type {Rect} */
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    /** @type {import('electron-chrome-extensions').ElectronChromeExtensions | null} */
    this.extensions = null;
    /** URLs of tabs the user closed, oldest first, for Reopen closed tab. */
    /** @type {string[]} */
    this.closed = [];
    /** The tab the user attached for agents (tab_elements, tab_click, tab_fill), if any. @type {number | null} */
    this.agentId = null;
    /** The last tab_elements list, which tab_click and tab_fill refs point into. @type {{ tab: number, url: string, elements: import('../shared/pageactions.js').PageElement[] } | null} */
    this.listed = null;
  }

  /** @param {import('electron-chrome-extensions').ElectronChromeExtensions} ext */
  attachExtensions(ext) {
    this.extensions = ext;
  }

  /**
   * @param {string} url
   * @param {{ activate?: boolean }} [opts]
   * @returns {Tab}
   */
  create(url, { activate = true } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const wc = view.webContents;
    const tab = { id: wc.id, view };
    this.tabs.set(tab.id, tab);
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    this.extensions?.addTab(wc, /** @type {any} */ (this.window));

    guardPage(wc, (target) => this.create(target));

    const report = () => this.send('tab:update', this.describe(tab));
    wc.on('page-title-updated', report);
    wc.on('did-start-loading', report);
    wc.on('did-stop-loading', () => {
      report();
      const u = wc.getURL();
      if (/^(https?|file):/i.test(u)) this.onVisit(u, wc.getTitle());
    });
    wc.on('did-navigate', report);
    wc.on('did-navigate-in-page', report);
    wc.on('page-favicon-updated', (_e, favicons) => this.send('tab:update', { ...this.describe(tab), favicon: favicons[0] || '' }));
    wc.on('context-menu', (_e, params) => this.contextMenu(tab, params));
    wc.on('found-in-page', (_e, r) => this.send('tab:found', tab.id, { active: r.activeMatchOrdinal, total: r.matches, done: r.finalUpdate }));
    // Browser shortcuts that the app menu can't own because the terminal needs them.
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.shift) return;
      const key = input.key.toLowerCase();
      if (key === 'l') { e.preventDefault(); this.send('shortcut', 'focus-address'); }
      if (key === 'r') { e.preventDefault(); wc.reload(); }
    });
    wc.on('destroyed', () => this.forget(tab.id));

    this.send('tab:created', this.describe(tab));
    wc.loadURL(url).catch(() => { /* surfaced by did-fail-load in the page itself */ });
    if (activate) this.activate(tab.id);
    return tab;
  }

  /** @param {Tab} tab */
  describe(tab) {
    const wc = tab.view.webContents;
    if (!wc || wc.isDestroyed()) return { id: tab.id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, agent: false };
    return {
      id: tab.id,
      agent: tab.id === this.agentId,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  /** Every open tab, oldest first, for the `list_tabs` MCP tool. */
  list() {
    return [...this.tabs.values()].map((t) => {
      const { id, url, title, loading, agent } = this.describe(t);
      return { id, url, title, loading, active: t.id === this.activeId, agent };
    });
  }

  /** @param {number} id */
  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    for (const t of this.tabs.values()) t.view.setVisible(t.id === id);
    this.activeId = id;
    tab.view.setBounds(this.bounds);
    this.extensions?.selectTab(tab.view.webContents);
    this.send('tab:activated', id);
  }

  /** Close every tab without adding them to Reopen closed tab: a workspace switch. */
  closeAll() {
    const n = this.closed.length;
    for (const id of [...this.tabs.keys()]) this.close(id);
    this.closed.length = n;
  }

  /** @param {number} id */
  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // electron-chrome-extensions calls this from the page's 'destroyed' event too,
    // e.g. while the window is closing, when the window is gone and the view's
    // webContents is already undefined.
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    const wc = tab.view.webContents;
    if (wc && !wc.isDestroyed()) {
      this.closed.push(...cleanSavedTabs([wc.getURL()]));
      this.closed.splice(0, Math.max(0, this.closed.length - MAX_CLOSED));
      wc.close();
    }
    this.forget(id);
  }

  /**
   * Find in the active page; results arrive as 'tab:found' events.
   * @param {string} text
   * @param {{ forward: boolean, findNext: boolean }} opts
   */
  find(text, opts) {
    const wc = this.active()?.view.webContents;
    if (wc && text) wc.findInPage(text, opts);
  }

  stopFind() {
    this.active()?.view.webContents.stopFindInPage('clearSelection');
  }

  /** Reopen the last tab the user closed, if any. */
  reopen() {
    const url = this.closed.pop();
    if (url) this.create(url);
  }

  /** @param {number} id */
  forget(id) {
    if (!this.tabs.delete(id)) return;
    if (this.agentId === id) this.agentId = null;
    if (this.listed?.tab === id) this.listed = null;
    this.send('tab:closed', id);
    if (this.activeId === id) {
      const next = [...this.tabs.keys()].pop();
      this.activeId = null;
      if (next !== undefined && !this.window.isDestroyed()) this.activate(next);
    }
  }

  /** @param {Rect} rect */
  setBounds(rect) {
    const r = {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)),
    };
    this.bounds = r;
    const tab = this.activeId !== null ? this.tabs.get(this.activeId) : null;
    tab?.view.setBounds(r);
  }

  /** Hide the active tab while the shell shows something over the content area. */
  /** @param {boolean} hidden */
  setHidden(hidden) {
    const tab = this.activeId !== null ? this.tabs.get(this.activeId) : null;
    tab?.view.setVisible(!hidden);
  }

  /** URLs of the open tabs in creation order, and the index of the active one. */
  snapshot() {
    const tabs = [...this.tabs.values()];
    return {
      urls: tabs.map((t) => (t.view.webContents && !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : '')),
      active: tabs.findIndex((t) => t.id === this.activeId),
    };
  }

  active() {
    return this.activeId !== null ? this.tabs.get(this.activeId) ?? null : null;
  }

  /**
   * The visible text of a tab, for read_tab: the one asked for, else the active one.
   * Runs in the page's sandboxed renderer and can't reach anything but the page.
   * @param {number} [id]
   */
  async text(id) {
    const tab = id === undefined ? this.active() : this.tabs.get(id) ?? null;
    if (!tab) throw new Error(id === undefined ? 'No tab is open' : `No tab with id ${id}`);
    const wc = tab.view.webContents;
    const text = await Promise.race([
      wc.executeJavaScript('document.body ? document.body.innerText : ""', false),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The page did not answer within 5 s')), 5000)),
    ]);
    return { id: tab.id, url: wc.getURL(), title: wc.getTitle(), text: String(text ?? '') };
  }

  /**
   * Attach a tab for agents, or none; one at a time. The strip marks it.
   * @param {number | null} id
   */
  setAgentTab(id) {
    const before = this.agentId;
    this.agentId = id !== null && this.tabs.has(id) ? id : null;
    this.listed = null;
    for (const t of [before, this.agentId]) {
      const tab = t !== null ? this.tabs.get(t) : undefined;
      if (tab) this.send('tab:update', this.describe(tab));
    }
  }

  /** The attached tab, while it shows a web page. */
  agentTab() {
    const tab = this.agentId !== null ? this.tabs.get(this.agentId) : undefined;
    const wc = tab?.view.webContents;
    if (!tab || !wc || wc.isDestroyed()) throw new Error("No tab is attached for agents. The user attaches one with 'Let agents click and type here' in the page's right-click menu.");
    if (!/^https?:/i.test(wc.getURL())) throw new Error('The attached tab is not showing a web page');
    return tab;
  }

  /** @param {Tab} tab @param {string} code */
  inPage(tab, code) {
    return Promise.race([
      tab.view.webContents.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }], false),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The page did not answer within 5 s')), 5000)),
    ]);
  }

  /** tab_elements: what can be clicked or typed into on the attached tab. Replaces the last list. */
  async elements() {
    const tab = this.agentTab();
    const wc = tab.view.webContents;
    const got = cleanElements(await this.inPage(tab, listScript(ELEMENTS_MAX)));
    this.listed = { tab: tab.id, url: wc.getURL(), elements: got.elements };
    return { tab: tab.id, url: wc.getURL(), title: wc.getTitle(), ...got };
  }

  /** tab_screenshot: the attached tab as a PNG, base64, at most 1280 px wide. */
  async screenshot() {
    const tab = this.agentTab();
    const wc = tab.view.webContents;
    let img = await wc.capturePage();
    if (img.getSize().width > 1280) img = img.resize({ width: 1280 });
    return { tab: tab.id, url: wc.getURL(), png: img.toPNG().toString('base64') };
  }

  /**
   * An element from the last tab_elements list, while the attached tab still shows that page.
   * @param {number} ref
   */
  listedElement(ref) {
    const tab = this.agentTab();
    const url = tab.view.webContents.getURL();
    if (!this.listed || this.listed.tab !== tab.id) throw new Error('Call tab_elements first');
    if (this.listed.url !== url) throw new Error('The page has changed since tab_elements; call it again');
    const el = this.listed.elements.find((e) => e.ref === ref);
    if (!el) throw new Error(`No element ${ref} in the last tab_elements list`);
    return { tab, el, url };
  }

  /**
   * After the click on Run: a real mouse click on the element, or real typing into it
   * (replacing its text; no Enter). The tab comes to the front first, so the user sees it.
   * @param {import('../shared/pageactions.js').PageElement} el the element the bar named
   * @param {string} [text] typing for a fill
   */
  async act(el, text) {
    const { tab } = this.listedElement(el.ref);
    const wc = tab.view.webContents;
    this.activate(tab.id);
    const at = /** @type {{ x?: number, y?: number, error?: string }} */ (await this.inPage(tab, prepareScript(el, text !== undefined)));
    if (at?.error) throw new Error(at.error);
    if (typeof at?.x !== 'number' || typeof at.y !== 'number') throw new Error('The page did not say where the element is');
    if (text !== undefined) {
      await wc.insertText(text);
    } else {
      const zoom = wc.getZoomFactor();
      const x = Math.round(at.x * zoom);
      const y = Math.round(at.y * zoom);
      wc.focus();
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }
    return { tab: tab.id, url: wc.getURL() };
  }

  /** @param {'back' | 'forward' | 'reload' | 'stop' | 'devtools' | 'reopen' | 'zoom-in' | 'zoom-out' | 'zoom-reset'} action */
  command(action) {
    if (action === 'reopen') return this.reopen();
    const wc = this.active()?.view.webContents;
    if (!wc) return;
    // One zoom level is about 20%, like Chrome; zoom is remembered per site by the session.
    if (action === 'zoom-in') wc.setZoomLevel(Math.min(9, wc.getZoomLevel() + 1));
    if (action === 'zoom-out') wc.setZoomLevel(Math.max(-7, wc.getZoomLevel() - 1));
    if (action === 'zoom-reset') wc.setZoomLevel(0);
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    if (action === 'stop') wc.stop();
    if (action === 'devtools') wc.toggleDevTools();
  }

  /** @param {string} url */
  navigate(url) {
    if (!isAllowedNavigation(url)) return;
    const tab = this.active();
    if (tab) tab.view.webContents.loadURL(url).catch(() => {});
    else this.create(url);
  }

  /**
   * @param {Tab} tab
   * @param {Electron.ContextMenuParams} params
   */
  contextMenu(tab, params) {
    const wc = tab.view.webContents;
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const items = [];
    if (params.linkURL) {
      items.push(
        { label: 'Open link in new tab', enabled: isAllowedNavigation(params.linkURL, wc.getURL()), click: () => this.create(params.linkURL, { activate: false }) },
        // http and https only: openExternal on file: or ms-*: links would launch programs.
        { label: 'Open link in default browser', enabled: /^https?:/i.test(params.linkURL), click: () => shell.openExternal(params.linkURL) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
    else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' });
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
    );
    const extItems = this.extensions?.getContextMenuItems(wc, params) ?? [];
    if (extItems.length) items.push({ type: 'separator' }, ...extItems);
    items.push(
      { type: 'separator' },
      // Web pages only: an agent acting on an app page (a document, a run's output) gains nothing and could reach more.
      { label: 'Let agents click and type here', type: 'checkbox', checked: tab.id === this.agentId, enabled: tab.id === this.agentId || /^https?:/i.test(wc.getURL()), click: () => this.setAgentTab(tab.id === this.agentId ? null : tab.id) },
      { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) },
    );
    Menu.buildFromTemplate(items).popup();
  }
}
