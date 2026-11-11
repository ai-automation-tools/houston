// Address-bar suggestions: web pages from Recent and bookmarks that match what's typed,
// and the arrow keys' walk through them. Pure; the list itself is in src/renderer/app.js.

/** @typedef {{ url: string, title: string, kind: 'recent' | 'bookmark' }} Suggestion */

const isWeb = (/** @type {unknown} */ url) => typeof url === 'string' && /^https?:\/\/\S+$/i.test(url);

/** The URL as typed by hand: no scheme, no `www.`. */
const bare = (/** @type {string} */ url) => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();

/**
 * Pages whose title or URL holds every word of the query, at most `limit`, each URL
 * once. A URL that starts with the first word comes first, then a title that does,
 * then Recent (newest first) before bookmarks. Only http(s) pages are suggested.
 * @param {{ recent?: { type: string, target: string, label: string }[], bookmarks?: { name: string, url: string }[] }} sources
 * @param {string} query
 * @param {number} [limit]
 * @returns {Suggestion[]}
 */
export function suggestAddresses(sources, query, limit = 8) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  /** @type {Suggestion[]} */
  const all = [];
  for (const r of Array.isArray(sources.recent) ? sources.recent : []) {
    if (r && r.type === 'url' && isWeb(r.target)) all.push({ url: r.target, title: String(r.label || r.target), kind: 'recent' });
  }
  for (const b of Array.isArray(sources.bookmarks) ? sources.bookmarks : []) {
    if (b && isWeb(b.url)) all.push({ url: b.url, title: String(b.name || b.url), kind: 'bookmark' });
  }
  const seen = new Set();
  /** @type {{ s: Suggestion, score: number }[]} */
  const hits = [];
  for (const s of all) {
    if (seen.has(s.url)) continue;
    const title = s.title.toLowerCase();
    if (!words.every((w) => title.includes(w) || s.url.toLowerCase().includes(w))) continue;
    seen.add(s.url);
    const score = bare(s.url).startsWith(words[0]) ? 0 : title.startsWith(words[0]) ? 1 : 2;
    hits.push({ s, score });
  }
  // Array sort is stable, so equal scores keep Recent's order, then the bookmarks'.
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, limit).map((h) => h.s);
}

/**
 * The highlighted row after an arrow key: -1 is the typed text, then rows 0 to
 * count-1, wrapping both ways so the text can always be reached again.
 * @param {number} sel
 * @param {1 | -1} delta
 * @param {number} count
 */
export function stepSelection(sel, delta, count) {
  if (count <= 0) return -1;
  const n = count + 1;
  return ((sel + 1 + delta) % n + n) % n - 1;
}
