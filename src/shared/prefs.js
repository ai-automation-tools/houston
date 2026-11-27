// The Settings pane's preferences (2026-11-27): the app's own choices, each with the file it's
// saved in and the check a new value must pass. Only these keys change from the window. The
// agent and security controls stay read-only (src/shared/scopes.js): the Core enforces them,
// and a checkbox here would be a toggle pretending to be a control.

import { MAX_LABEL, MAX_LINKS, feedPath, httpUrl, hubAddress, newsSource } from './settings.js';

export const THEMES = /** @type {const} */ (['system', 'light', 'dark']);
export const START_TABS = /** @type {const} */ (['restore', 'start']);
/** The rows of scopes.js's controls() that the pane edits, so its read-only list leaves them out. */
export const PANE_ROWS = new Set(['Close to tray', 'Ad blocking', 'Project Hub', 'Quick links', 'News sources', 'Feed index']);

/** @typedef {{ theme: typeof THEMES[number], startTab: typeof START_TABS[number], startTerminal: boolean, defaultShell: string }} LayoutPrefs */

/**
 * layout.json's preference keys, each checked on read, so a hand-edited file can't break the app.
 * @param {Record<string, any>} d the parsed file
 * @returns {LayoutPrefs}
 */
export function layoutPrefs(d) {
  return {
    theme: THEMES.includes(d.theme) ? d.theme : 'system',
    startTab: START_TABS.includes(d.startTab) ? d.startTab : 'restore',
    startTerminal: d.startTerminal !== false,
    defaultShell: typeof d.defaultShell === 'string' ? d.defaultShell : '',
  };
}

/**
 * A list of { label, url } rows from the pane, each checked; the first bad row throws.
 * @param {unknown} value
 * @param {(url: unknown) => string | null} check
 * @param {string} what
 */
function rows(value, check, what) {
  if (!Array.isArray(value)) throw new Error(`${what} must be a list`);
  if (value.length > MAX_LINKS) throw new Error(`At most ${MAX_LINKS} ${what}`);
  return value.map((r, i) => {
    const label = typeof r?.label === 'string' ? r.label.trim() : '';
    const url = check(r?.url);
    if (!label) throw new Error(`Row ${i + 1} needs a name`);
    if (label.length > MAX_LABEL) throw new Error(`Row ${i + 1}'s name is over ${MAX_LABEL} characters`);
    if (!url) throw new Error(`Row ${i + 1}'s address isn't one ${what} can use`);
    return { label, url };
  });
}

/**
 * One change from the Settings pane, checked. Throws a message the pane shows next to the field.
 * A `value` of undefined means "back to the default": the key is removed from its file.
 * @param {string} key
 * @param {unknown} value
 * @param {{ shells: string[], remoteHub: boolean }} ctx the shells on this machine; whether ACC_HUB_REMOTE allows a remote Hub
 * @returns {{ file: 'layout' | 'settings', key: string, value: unknown }}
 */
export function prefChange(key, value, ctx) {
  /** @param {unknown} v */
  const layout = (v) => ({ file: /** @type {const} */ ('layout'), key, value: v });
  /** @param {unknown} v */
  const settings = (v) => ({ file: /** @type {const} */ ('settings'), key, value: v });
  switch (key) {
    case 'closeToTray':
    case 'adBlock':
    case 'startTerminal':
      if (typeof value !== 'boolean') throw new Error('Expected on or off');
      return layout(value);
    case 'theme':
      if (!THEMES.includes(/** @type {any} */ (value))) throw new Error(`Theme is one of ${THEMES.join(', ')}`);
      return layout(value);
    case 'startTab':
      if (!START_TABS.includes(/** @type {any} */ (value))) throw new Error(`Start with one of ${START_TABS.join(', ')}`);
      return layout(value);
    case 'defaultShell':
      if (typeof value !== 'string' || !ctx.shells.includes(value)) throw new Error('Not a shell found on this machine');
      return layout(value);
    case 'hubUrl': {
      if (value === '' || value === undefined) return settings(undefined);
      const url = hubAddress(value, ctx.remoteHub);
      if (!url) throw new Error(httpUrl(value) ? 'Project Hub must be on this machine (127.0.0.1 or localhost) unless ACC_HUB_REMOTE=1 is set' : 'Not an http or https address');
      return settings(url);
    }
    case 'quickLinks':
      return settings(rows(value, httpUrl, 'quick links'));
    case 'newsSources':
      return settings(rows(value, newsSource, 'News sources'));
    case 'feedIndex': {
      if (value === '' || value === undefined) return settings(undefined);
      const f = feedPath(value);
      if (!f) throw new Error('An absolute path to a .json file, like D:\\feeds\\index.json');
      return settings(f);
    }
    default:
      throw new Error(`${key} can't be changed from Settings`);
  }
}
