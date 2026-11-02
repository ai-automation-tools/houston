// The News tab: headlines from the RSS, Atom or Markdown sources settings.json lists.
// Pure; src/main/main.js fetches each source and the sidebar shows the merged list.
// A source's text is untrusted: only a title (plain text, clipped) and an http(s) link
// come out of it, and the sidebar sets the title as text, never as HTML.

const MAX_TITLE = 200;
const MAX_PER_SOURCE = 50;
export const MAX_ITEMS = 100;

/** @typedef {{ title: string, url: string, at: number, source: string }} NewsItem */

const ENTITIES = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

/** XML text to plain text: CDATA unwrapped, tags dropped, entities decoded, spaces collapsed. @param {string} s */
function plain(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An http(s) URL, or ''. @param {string} s */
function webUrl(s) {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/** The first `<tag>` element's inner text in an XML fragment, or ''. @param {string} xml @param {string} tag */
function inner(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

/** @param {string} s */
function time(s) {
  const t = Date.parse(plain(s));
  return Number.isFinite(t) ? t : 0;
}

/** Whether a source's text is a feed rather than Markdown. @param {string} text */
export function isFeed(text) {
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(text);
}

/**
 * RSS 2.0 or RSS 1.0 `<item>`s and Atom `<entry>`s.
 * @param {string} xml
 * @param {string} source
 * @returns {NewsItem[]}
 */
function feedItems(xml, source) {
  /** @type {NewsItem[]} */
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const body = m[2];
    // Atom: the alternate link (or one with no rel); RSS: <link>text</link>.
    const links = [...body.matchAll(/<link\b([^>]*?)\/?>/gi)].map((l) => l[1]);
    const atom = links.find((a) => /href=/i.test(a) && (!/rel=/i.test(a) || /rel=["']alternate["']/i.test(a)));
    const href = atom?.match(/href=["']([^"']+)["']/i)?.[1];
    const url = webUrl(plain(href ?? (inner(body, 'link') || inner(body, 'guid'))));
    const title = plain(inner(body, 'title')).slice(0, MAX_TITLE);
    if (!url || !title) continue;
    const at = time(inner(body, 'pubDate') || inner(body, 'published') || inner(body, 'updated') || inner(body, 'dc:date'));
    out.push({ title, url, at, source });
  }
  return out;
}

/**
 * Markdown links, `[text](https://…)` and `<https://…>`; a bare URL on a line uses the
 * line's text as its title. A date heading (`## 2026-10-30`) dates the links below it.
 * @param {string} md
 * @param {string} source
 * @returns {NewsItem[]}
 */
function markdownItems(md, source) {
  /** @type {NewsItem[]} */
  const out = [];
  let at = 0;
  for (const line of md.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      const d = heading[1].match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (d) at = time(d[1]);
    }
    let found = false;
    for (const m of line.matchAll(/!?\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^\s>]+)>/gi)) {
      found = true;
      if (m[0].startsWith('!')) continue;
      const url = webUrl(m[2] || m[3]);
      const title = plain((m[1] || '').replace(/[*_`]/g, '')).slice(0, MAX_TITLE) || url;
      if (url) out.push({ title, url, at, source });
    }
    if (found || heading) continue;
    const bare = line.match(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/i);
    if (bare) {
      const url = webUrl(bare[0]);
      const rest = plain(line.replace(bare[0], '').replace(/^\s*([-*+]|\d+\.)\s+/, '').replace(/[*_`]/g, '').replace(/[\s:.,;–—-]+$/, ''));
      if (url) out.push({ title: (rest || url).slice(0, MAX_TITLE), url, at, source });
    }
  }
  return out;
}

/**
 * One source's headlines: a feed's items, or a Markdown file's links, the first 50.
 * @param {unknown} text
 * @param {string} source the label settings.json gives the source
 * @returns {NewsItem[]}
 */
export function parseNews(text, source) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const items = isFeed(text) ? feedItems(text, source) : markdownItems(text, source);
  return items.slice(0, MAX_PER_SOURCE);
}

/**
 * Every source's headlines in one list: newest first (undated ones after, in source
 * order), each link once, capped.
 * @param {NewsItem[][]} lists
 * @param {number} [max]
 * @returns {NewsItem[]}
 */
export function mergeNews(lists, max = MAX_ITEMS) {
  const seen = new Set();
  /** @type {(NewsItem & { i: number })[]} */
  const all = [];
  for (const item of lists.flat()) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    all.push({ ...item, i: all.length });
  }
  all.sort((a, b) => (b.at - a.at) || (a.i - b.i));
  return all.slice(0, max).map(({ i, ...item }) => item);
}
