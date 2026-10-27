// Preload for the shell UI only. Exposes a fixed set of calls on window.acc; browser
// tabs get no preload from this app but the extension-API and ad-block ones, so pages on the web never see any of this.

const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

if (location.protocol === 'acc:' && location.host === 'shell') {
  injectBrowserAction();
}

/** @param {string} channel */
const invoke = (channel) => (/** @type {unknown[]} */ ...args) => ipcRenderer.invoke(channel, ...args);

/** @param {string} channel */
const listen = (channel) => (/** @type {(...args: any[]) => void} */ fn) => {
  /** @param {unknown} _e @param {unknown[]} args */
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('acc', {
  info: invoke('app:info'),
  saveLayout: invoke('layout:save'),

  hub: {
    health: invoke('hub:health'),
    scan: invoke('hub:scan'),
    webmarks: invoke('hub:webmarks'),
    favorites: invoke('hub:favorites'),
    favorite: invoke('hub:favorite'),
    open: invoke('hub:open'),
    onChanged: listen('hub:changed'),
  },

  tabs: {
    create: invoke('tabs:create'),
    activate: invoke('tabs:activate'),
    close: invoke('tabs:close'),
    navigate: invoke('tabs:navigate'),
    command: invoke('tabs:command'),
    find: invoke('tabs:find'),
    stopFind: invoke('tabs:stopFind'),
    onFound: listen('tab:found'),
    openExternal: invoke('tabs:openExternal'),
    restore: invoke('tabs:restore'),
    /** @param {{ x: number, y: number, width: number, height: number }} rect */
    setBounds: (rect) => ipcRenderer.send('tabs:bounds', rect),
    /** @param {boolean} hidden */
    setHidden: (hidden) => ipcRenderer.send('tabs:hidden', hidden),
    onCreated: listen('tab:created'),
    onUpdate: listen('tab:update'),
    onActivated: listen('tab:activated'),
    onClosed: listen('tab:closed'),
  },

  term: {
    create: invoke('term:create'),
    kill: invoke('term:kill'),
    /** @param {number} id @param {string} data */
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    /** @param {number | null} id the session the panel shows, for terminal_read's default */
    setActive: (id) => ipcRenderer.send('term:active', id),
    /** @param {number} id @param {number} cols @param {number} rows */
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    onData: listen('term:data'),
    onExit: listen('term:exit'),
    /** A session main opened itself: a terminal_run run, after the user clicked Run. */
    onOpened: listen('term:opened'),
  },

  recent: {
    list: invoke('recent:list'),
    add: invoke('recent:add'),
    onChanged: listen('recent:changed'),
  },

  mcp: {
    answer: invoke('mcp:answer'),
    onConfirm: listen('mcp:confirm'),
    onCancel: listen('mcp:cancel'),
    log: invoke('mcp:log'),
    onLogged: listen('mcp:logged'),
  },

  /** terminal_run and cron_run asks, from the confirm bar to their end. */
  activity: {
    list: invoke('activity:list'),
    onChanged: listen('activity:changed'),
  },

  /** terminal_run's run history, newest first, searched by the text given. */
  runs: {
    list: invoke('runs:list'),
    onChanged: listen('runs:changed'),
  },

  chat: {
    info: invoke('chat:info'),
    attach: invoke('chat:attach'),
    send: invoke('chat:send'),
    list: invoke('chat:list'),
    new: invoke('chat:new'),
    open: invoke('chat:open'),
    rename: invoke('chat:rename'),
    delete: invoke('chat:delete'),
    stop: invoke('chat:stop'),
    onEvent: listen('chat:event'),
  },

  workspace: {
    info: invoke('workspace:info'),
    switch: invoke('workspace:switch'),
    add: invoke('workspace:add'),
    remove: invoke('workspace:remove'),
    onChanged: listen('workspace:changed'),
  },

  cronsole: {
    info: invoke('cronsole:info'),
    tasks: invoke('cronsole:tasks'),
    history: invoke('cronsole:history'),
  },

  connections: { check: invoke('connections:check') },

  git: { status: invoke('git:status') },

  dev: {
    info: invoke('dev:info'),
    start: invoke('dev:start'),
    stop: invoke('dev:stop'),
    restart: invoke('dev:restart'),
    onChanged: listen('dev:changed'),
  },

  /** @type {(items: ({ id: string, label: string } | '-')[]) => Promise<string | null>} */
  menu: invoke('menu:popup'),

  extensions: { list: invoke('ext:list') },
  onShortcut: listen('shortcut'),
});
