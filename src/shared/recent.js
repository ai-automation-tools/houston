// The Recent list: files, folders, URLs and terminal sessions, newest first. Pure;
// the main process owns persistence (src/main/store.js).

export const RECENT_MAX = 50;

/**
 * @typedef {{ type: 'file' | 'folder' | 'url' | 'terminal' | 'download', target: string, label: string, at: number }} RecentItem
 */

/**
 * Add an item to the front, dropping any older entry with the same type and target.
 * @param {RecentItem[]} list
 * @param {Omit<RecentItem, 'at'>} item
 * @param {number} [now]
 * @returns {RecentItem[]}
 */
export function pushRecent(list, item, now = Date.now()) {
  const rest = list.filter((r) => !(r.type === item.type && r.target === item.target));
  return [{ ...item, at: now }, ...rest].slice(0, RECENT_MAX);
}

/**
 * Keep only well-formed entries. The file on disk is user-editable, so trust nothing.
 * @param {unknown} raw
 * @returns {RecentItem[]}
 */
export function cleanRecent(raw) {
  if (!Array.isArray(raw)) return [];
  const types = new Set(['file', 'folder', 'url', 'terminal', 'download']);
  return raw
    .filter((r) => r && types.has(r.type) && typeof r.target === 'string' && typeof r.label === 'string' && Number.isFinite(r.at))
    .slice(0, RECENT_MAX);
}
