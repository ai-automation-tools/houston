// The browser tabs saved in layout.json so they reopen after a restart. Pure; the main
// process owns persistence (src/main/store.js) and the tabs themselves (src/main/tabs.js).

import { isAllowedNavigation } from './url.js';

export const SAVED_TABS_MAX = 30;

/**
 * Keep only URLs worth reopening: allowed schemes, no blank pages, capped. The file on
 * disk is user-editable, so trust nothing.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function cleanSavedTabs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((u) => typeof u === 'string' && u !== '' && !/^about:/i.test(u) && isAllowedNavigation(u))
    .slice(0, SAVED_TABS_MAX);
}

/**
 * Which saved tab to activate: the stored index if it still points at a tab, else the last.
 * @param {unknown} index
 * @param {number} count
 * @returns {number}
 */
/**
 * The tab `delta` steps from `active` in the strip's order, wrapping round; the first
 * or last when nothing is active; null when there are no tabs.
 * @param {number[]} order tab ids as the strip shows them
 * @param {number | null} active
 * @param {1 | -1} delta
 */
export function cycleTab(order, active, delta) {
  if (!order.length) return null;
  const i = active === null ? -1 : order.indexOf(active);
  if (i < 0) return order[delta > 0 ? 0 : order.length - 1];
  return order[(i + delta + order.length) % order.length];
}

/**
 * Chrome's rule for Ctrl+1 to Ctrl+9: 1 to 8 pick that tab, 9 the last; null when
 * there's no such tab.
 * @param {number[]} order
 * @param {number} n
 */
export function pickTab(order, n) {
  if (!order.length) return null;
  if (n === 9) return order[order.length - 1];
  return Number.isInteger(n) && n >= 1 && n <= Math.min(8, order.length) ? order[n - 1] : null;
}

export function savedActiveIndex(index, count) {
  return Number.isInteger(index) && /** @type {number} */ (index) >= 0 && /** @type {number} */ (index) < count
    ? /** @type {number} */ (index)
    : count - 1;
}

/**
 * Electron's default user agent as Chrome's: without the `Electron/…` token and the app's
 * own `name/version` before `Chrome/`. LastPass reads "Electron" in it as its own desktop
 * app and runs that code in its service worker, which then dies on `document.cookie`.
 * @param {string} ua
 * @returns {string}
 */
export function chromeUserAgent(ua) {
  return ua.replace(/ Electron\/\S+/, '').replace(/\) \S+\/\S+ Chrome\//, ') Chrome/');
}

/**
 * A browser tab's right-click menu, and the tabs Close other tabs and Close tabs to the
 * right would close. The pinned tab (Cronsole's) is never closed from here.
 * @param {number[]} order tab ids as the strip shows them
 * @param {number} id the tab right-clicked
 * @param {(id: number) => boolean} pinned
 * @param {boolean} hasUrl
 */
export function tabMenu(order, id, pinned, hasUrl) {
  const others = order.filter((t) => t !== id && !pinned(t));
  const right = order.slice(order.indexOf(id) + 1).filter((t) => !pinned(t));
  /** @type {({ id: string, label: string } | '-')[]} */
  const items = [
    { id: 'reload', label: 'Reload' },
    ...(hasUrl ? [{ id: 'duplicate', label: 'Duplicate' }, { id: 'copy', label: 'Copy address' }] : []),
  ];
  const closing = [
    ...(pinned(id) ? [] : [{ id: 'close', label: 'Close' }]),
    ...(others.length ? [{ id: 'others', label: 'Close other tabs' }] : []),
    ...(right.length ? [{ id: 'right', label: 'Close tabs to the right' }] : []),
  ];
  if (closing.length) items.push('-', ...closing);
  return { items, others, right };
}
