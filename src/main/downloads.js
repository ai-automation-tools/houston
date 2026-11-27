// Downloads and Save page as, for the browse session. A download goes to the Downloads
// folder under a name that overwrites nothing; a saved page goes where the Save dialog says.
// Each keeps Windows' mark of the web and lands in Recent. Nothing here opens or runs a
// file: Show in folder only selects it in Explorer, and only for a file Recent got from here.

import { app, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { store } from './store.js';
import { downloadName, zoneIdentifier } from '../shared/downloads.js';

/** @type {(channel: string, ...args: unknown[]) => void} */
let send = () => {};
/** Names given out but not yet on disk, so two downloads at once don't pick the same one. */
const pending = new Set();

/** @param {string} dir @param {string} suggested */
function freePath(dir, suggested) {
  const name = downloadName(suggested, (n) => pending.has(path.join(dir, n).toLowerCase()) || fs.existsSync(path.join(dir, n)));
  return path.join(dir, name);
}

/**
 * The Zone.Identifier stream, unless Chromium already wrote one. A failure leaves the
 * file unmarked rather than losing it (a FAT32 or network drive has no streams).
 * @param {string} file @param {string} url
 */
function markOfTheWeb(file, url) {
  const zone = zoneIdentifier(url);
  if (!zone) return;
  try {
    fs.readFileSync(`${file}:Zone.Identifier`);
  } catch {
    try { fs.writeFileSync(`${file}:Zone.Identifier`, zone); } catch { /* no alternate streams here */ }
  }
}

/** A finished file: into Recent, and the toast with Show in folder. @param {string} file */
function finished(file) {
  send('recent:changed', store.addRecent({ type: 'download', target: file, label: path.basename(file) }));
  send('downloads:event', { state: 'completed', name: path.basename(file), file });
}

/**
 * @param {{ session: import('electron').Session, send: (channel: string, ...args: unknown[]) => void }} opts
 */
export function setupDownloads(opts) {
  send = opts.send;
  opts.session.on('will-download', (_e, item) => {
    // Save page as names its own file and reports it itself (savePage below).
    if (item.getSavePath()) return;
    const file = freePath(app.getPath('downloads'), item.getFilename());
    pending.add(file.toLowerCase());
    item.setSavePath(file);
    send('downloads:event', { state: 'started', name: path.basename(file) });
    item.once('done', (_d, state) => {
      pending.delete(file.toLowerCase());
      if (state === 'completed') {
        markOfTheWeb(file, item.getURLChain().at(-1) || item.getURL());
        finished(file);
      } else {
        send('downloads:event', { state, name: path.basename(file) });
      }
    });
  });
}

/**
 * Save page as: the Save dialog, then the whole page (its HTML and a folder of what it
 * loads). For http(s) pages only; the app's own pages have nothing worth saving.
 * @param {import('electron').BaseWindow} window
 * @param {import('electron').WebContents} wc
 * @param {string} [to] where to save without asking: the smoke run only
 */
export async function savePage(window, wc, to) {
  const url = wc.getURL();
  if (!/^https?:/i.test(url)) return;
  const dir = app.getPath('downloads');
  const { canceled, filePath } = to ? { canceled: false, filePath: to } : await dialog.showSaveDialog(window, {
    title: 'Save page as',
    defaultPath: freePath(dir, `${wc.getTitle() || 'page'}.html`),
    filters: [{ name: 'Webpage, complete', extensions: ['html', 'htm'] }],
  });
  if (canceled || !filePath) return;
  send('downloads:event', { state: 'started', name: path.basename(filePath) });
  try {
    await wc.savePage(filePath, 'HTMLComplete');
  } catch (err) {
    send('downloads:event', { state: 'interrupted', name: path.basename(filePath), error: err instanceof Error ? err.message : String(err) });
    return;
  }
  markOfTheWeb(filePath, url);
  finished(filePath);
}

/**
 * Show in folder, for a file Recent has as a download: the renderer can't name any other path.
 * @param {unknown} file
 */
export function showDownload(file) {
  const known = typeof file === 'string' && store.recent().some((r) => r.type === 'download' && r.target === file);
  if (!known) throw new Error('That is not a download Houston saved.');
  if (!fs.existsSync(file)) throw new Error(`${path.basename(file)} has been moved or deleted.`);
  shell.showItemInFolder(file);
}
