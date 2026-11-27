// Chrome extension support for the browse session: electron-chrome-extensions for the
// chrome.* APIs, electron-chrome-web-store so the Web Store's "Add to Chrome" button
// installs into this app. See docs/decisions/adr-001-electron-shell.md for the licence
// choice and what's known not to work.

import { app, dialog, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './applog.js';
import { manifestIconPath } from '../shared/extensionicon.js';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import { installChromeWebStore, uninstallExtension, updateExtensions } from 'electron-chrome-web-store';

/**
 * @param {{
 *   browseSession: import('electron').Session,
 *   shellSession: import('electron').Session,
 *   window: import('electron').BaseWindow,
 *   tabs: import('./tabs.js').Tabs,
 * }} opts
 */
export async function setupExtensions({ browseSession, shellSession, window, tabs }) {
  const extensions = new ElectronChromeExtensions({
    // Personal, unpublished tool: GPL-3.0 terms apply. Anything distributed later needs
    // either a GPL-compatible licence for this repo or the patron licence.
    license: 'GPL-3.0',
    session: browseSession,
    async createTab(details) {
      const tab = tabs.create(details.url || 'about:blank', { activate: details.active !== false });
      return [tab.view.webContents, /** @type {any} */ (window)];
    },
    selectTab(wc) {
      tabs.activate(wc.id);
    },
    removeTab(wc) {
      tabs.close(wc.id);
    },
    async createWindow(details) {
      // One window by design: extension "windows" open as tabs.
      const urls = Array.isArray(details.url) ? details.url : [details.url || 'about:blank'];
      for (const u of urls) tabs.create(u);
      return /** @type {any} */ (window);
    },
  });
  tabs.attachExtensions(extensions);

  // After the library's preloads (which the constructor registers), so `chrome` is filled in.
  const aliasBrowser = fileURLToPath(new URL('../preload/extension-browser.cjs', import.meta.url));
  browseSession.registerPreloadScript({ id: 'acc-browser-alias-sw', type: 'service-worker', filePath: aliasBrowser });
  browseSession.registerPreloadScript({ id: 'acc-browser-alias-frame', type: 'frame', filePath: aliasBrowser });

  // Errors from extension workers and pages (popups, options) go to logs/extensions.log.
  // A popup that spins or a worker that stalls shows nothing anywhere else.
  const log = (/** @type {string} */ where, /** @type {unknown} */ msg) =>
    appendLog('extensions.log', `${new Date().toISOString()} ${where} ${String(msg).slice(0, 500).replace(/\r?\n/g, ' ')}\n`);
  browseSession.serviceWorkers.on('console-message', (_e, d) => {
    if (d.level === 3) log(d.sourceUrl, d.message);
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (e) => {
      if (e.level === 'error' && wc.getURL().startsWith('chrome-extension://')) log(wc.getURL(), e.message);
    });
  });

  // The shell's <browser-action-list> loads extension icons over crx://, from the library.
  // An MV3 extension that sets its icon from image data (Rakuten and AdBlock do) leaves it
  // with no image ("not yet supported"), and the button showed a grey letter with its badge
  // hanging off it; serve that extension's manifest icon instead.
  shellSession.protocol.handle('crx', async (req) => {
    const res = await extensions.api.browserAction.handleCRXRequest(req);
    if (res.ok) return res;
    const url = new URL(req.url);
    const [, id, size] = url.pathname.split('/');
    const ext = url.hostname === 'extension-icon' ? (browseSession.extensions ?? browseSession).getExtension(id) : null;
    const rel = ext && manifestIconPath(ext.manifest, Number(size) || 32);
    const file = ext && rel ? path.join(ext.path, rel) : '';
    if (!ext || !file.startsWith(ext.path + path.sep)) return res;
    const img = nativeImage.createFromPath(file);
    return img.isEmpty() ? res : new Response(img.toPNG(), { headers: { 'content-type': 'image/png' } });
  });

  // Loads everything previously installed from the Web Store, and makes the store's
  // install button work inside a tab.
  await installChromeWebStore({ session: browseSession });
  updateExtensions(browseSession).catch((err) => console.error('[extensions] update check failed:', err));

  return extensions;
}

const WEB_STORE = 'https://chromewebstore.google.com';

/**
 * The app menu's Extensions submenu: a way to the Web Store, then each installed
 * extension with its options page, store page and Remove. The toolbar's own right-click
 * menu can't remove one (electron-chrome-extensions shows Remove only in development).
 * @param {import('electron').Session} browseSession
 * @param {import('./tabs.js').Tabs} tabs
 * @param {import('electron').BaseWindow} window
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function extensionsMenu(browseSession, tabs, window) {
  const installed = browseSession.extensions.getAllExtensions().sort((a, b) => a.name.localeCompare(b.name));
  return [
    { label: 'Get extensions…', click: () => tabs.create(WEB_STORE) },
    { type: 'separator' },
    ...(installed.length ? installed.map((ext) => {
      const options = ext.manifest.options_ui?.page || ext.manifest.options_page;
      return {
        label: `${ext.name} ${ext.version}`,
        submenu: [
          { label: 'Options', enabled: Boolean(options), click: () => tabs.create(`${ext.url}${options}`) },
          { label: 'Web Store page', click: () => tabs.create(`${WEB_STORE}/detail/${ext.id}`) },
          { type: 'separator' },
          { label: 'Remove…', click: () => removeExtension(browseSession, window, ext) },
        ],
      };
    }) : [{ label: 'None installed', enabled: false }]),
  ];
}

/**
 * @param {import('electron').Session} browseSession
 * @param {import('electron').BaseWindow} window
 * @param {import('electron').Extension} ext
 */
async function removeExtension(browseSession, window, ext) {
  const { response } = await dialog.showMessageBox(/** @type {any} */ (window), {
    type: 'question',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Remove ${ext.name}?`,
    detail: 'It is uninstalled from Houston. You can add it again from the Web Store.',
  });
  if (response !== 0) return;
  try {
    // Deletes it from Extensions/ as well as unloading it, so it doesn't come back at start.
    await uninstallExtension(ext.id, { session: browseSession });
  } catch (err) {
    console.error(`[extensions] removing ${ext.id} failed:`, err);
    dialog.showErrorBox('Couldn’t remove the extension', err instanceof Error ? err.message : String(err));
  }
}

/** @param {import('electron').Session} browseSession */
export function listExtensions(browseSession) {
  return browseSession.extensions.getAllExtensions().map((e) => ({ id: e.id, name: e.name, version: e.version }));
}
