// The Feed and the start page (H6). The feed is a local index.json that a scheduled job writes
// (settings.json `feedIndex`): categories, each with the definition of what belongs in it, and
// items. Houston only reads it. An item can be bookmarked, and an item that names an MCP server
// can be added to the Core as *discovered*: registered, nothing run (installing and pinning stay
// the operator's steps in the Integrations tab). An item with an advisory names the tool it's
// about; the start page shows the advisories for tools installed here. Pure; main.js reads files.
//
// index.json:
//   { "generated": "<ISO time>",
//     "categories": [{ "id": "ai-repos", "name": "AI repositories", "definition": "What belongs here" }],
//     "items": [{ "id": "…", "category": "ai-repos", "title": "…", "url": "https://…", "summary": "…",
//                 "date": "<ISO>", "highlight": true,
//                 "mcp": { "name": "github", "command": "…", "transport": "container" },
//                 "advisory": { "tool": "codex", "severity": "high", "summary": "…" } }] }

export const MAX_ITEMS = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

/** @param {unknown} v @param {number} max */
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\0\r\n]+/g, ' ').slice(0, max) : null);
/** @param {unknown} v */
const web = (v) => { const u = text(v, 2000); return u && /^https?:\/\//i.test(u) ? u : null; };

/**
 * @typedef {{ id: string, name: string, definition: string }} Category
 * @typedef {{ id: string, category: string, title: string, url: string, summary: string, date: string | null, highlight: boolean,
 *   mcp: { name: string, command: string, transport: string } | null, advisory: { tool: string, severity: string, summary: string } | null }} Item
 * @typedef {{ generated: string | null, categories: Category[], items: Item[], dropped: number }} Feed
 */

/**
 * The index, cleaned: categories with an id, name and definition; items in a known category with a
 * title and an http(s) URL. Anything else is dropped and counted.
 * @param {string} raw the file's text
 * @returns {Feed}
 */
export function parseFeed(raw) {
  let d;
  try { d = JSON.parse(raw); } catch { throw new Error('The feed index is not JSON.'); }
  if (!d || typeof d !== 'object' || !Array.isArray(d.categories) || !Array.isArray(d.items)) throw new Error('The feed index needs "categories" and "items" lists.');
  /** @type {Category[]} */
  const categories = [];
  for (const c of d.categories) {
    const id = text(c?.id, 60);
    const name = text(c?.name, 80);
    const definition = text(c?.definition, 500);
    if (id && name && definition && !categories.some((x) => x.id === id)) categories.push({ id, name, definition });
  }
  /** @type {Item[]} */
  const items = [];
  let dropped = 0;
  for (const i of d.items.slice(0, MAX_ITEMS)) {
    const id = text(i?.id, 120);
    const title = text(i?.title, 200);
    const url = web(i?.url);
    const category = categories.find((c) => c.id === i?.category)?.id;
    if (!id || !ID.test(id) || !title || !url || !category || items.some((x) => x.id === id)) { dropped++; continue; }
    const date = text(i.date, 40);
    const m = i.mcp && typeof i.mcp === 'object' ? { name: text(i.mcp.name, 40), command: text(i.mcp.command, 2000), transport: text(i.mcp.transport, 20) ?? 'container' } : null;
    const a = i.advisory && typeof i.advisory === 'object' ? { tool: text(i.advisory.tool, 80), severity: text(i.advisory.severity, 20)?.toLowerCase() ?? 'medium', summary: text(i.advisory.summary, 300) ?? '' } : null;
    items.push({
      id, category, title, url, summary: text(i.summary, 500) ?? '', date: date && !Number.isNaN(Date.parse(date)) ? date : null, highlight: i.highlight === true,
      mcp: m?.name && m.command ? /** @type {Item['mcp']} */ (m) : null,
      advisory: a?.tool ? { tool: a.tool, severity: SEVERITIES.includes(a.severity) ? a.severity : 'medium', summary: a.summary } : null,
    });
  }
  dropped += Math.max(0, d.items.length - MAX_ITEMS);
  return { generated: text(d.generated, 40), categories, items, dropped };
}

/** Newest first; undated last. @param {Item[]} items */
const newest = (items) => [...items].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

/**
 * What the Feed tab shows: bookmarked items first, then each category with its definition and items, newest first.
 * @param {Feed} feed @param {string[]} bookmarks item ids
 */
export function feedView(feed, bookmarks) {
  const marked = new Set(bookmarks);
  const row = (/** @type {Item} */ i) => ({ ...i, bookmarked: marked.has(i.id) });
  return {
    bookmarked: newest(feed.items.filter((i) => marked.has(i.id))).map(row),
    categories: feed.categories.map((c) => ({ ...c, items: newest(feed.items.filter((i) => i.category === c.id)).map(row) })),
  };
}

/**
 * Advisories about tools installed here: an MCP server registered in the profile, an agent backend,
 * an installed skill or a local runtime, by name, case-insensitively. Worst first.
 * @param {Feed} feed @param {string[]} installed
 */
export function advisoriesFor(feed, installed) {
  const have = new Set(installed.map((n) => n.toLowerCase()));
  return feed.items.filter((i) => i.advisory && have.has(i.advisory.tool.toLowerCase()))
    .sort((a, b) => SEVERITIES.indexOf(/** @type {any} */ (b.advisory).severity) - SEVERITIES.indexOf(/** @type {any} */ (a.advisory).severity) || (b.date ?? '').localeCompare(a.date ?? ''));
}

/** Toggle one id in the bookmark list. @param {string[]} list @param {string} id */
export const toggleBookmark = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** The start page's cards, in the order they show: id and title. Settings › Start and new tab turns each on or off. */
export const START_CARDS = /** @type {const} */ ([
  ['advisories', 'Advisories for installed tools'],
  ['approvals', 'Approvals waiting'],
  ['runs', 'Overnight runs'],
  ['highlights', 'Feed highlights'],
]);

/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The start page's body: the cards `cards` names (every one when it's left out), in START_CARDS'
 * order. Script-free, like every acc:// page; links open as tabs.
 * @param {{
 *   runs: { identity: string, grant: string, startedAt: string, status: string, end: string | null }[] | null,
 *   approvals: { id: string, identity: string, action: string, resource: string }[] | null,
 *   highlights: Item[] | null, advisories: Item[] | null, feedError: string | null, since: string, core: string | null,
 *   cards?: string[],
 * }} d core: why the Core's cards are empty (it isn't running), or null
 */
export function startBody(d) {
  const card = (/** @type {string} */ title, /** @type {string} */ body) => `<section class="card"><h2>${esc(title)}</h2>${body}</section>`;
  const none = (/** @type {string} */ t) => `<p class="note">${esc(t)}</p>`;
  const list = (/** @type {string[]} */ rows) => `<ul>${rows.join('')}</ul>`;
  const link = (/** @type {Item} */ i) => `<a href="${esc(i.url)}">${esc(i.title)}</a>`;
  const since = new Date(d.since).toLocaleString();

  const runs = d.core ? none(d.core) : !d.runs?.length ? none(`No scheduled runs since ${since}.`)
    : list(d.runs.map((r) => `<li class="${r.status === 'ok' ? 'ok' : r.status === 'running' ? '' : 'bad'}"><b>${esc(r.grant)}</b> as <code>${esc(r.identity)}</code> · ${esc(new Date(r.startedAt).toLocaleString())} · ${esc(r.status === 'running' ? 'running now' : r.status === 'ok' ? 'finished' : `failed (${r.end ?? 'unknown'})`)}</li>`));
  const approvals = d.core ? none(d.core) : !d.approvals?.length ? none('Nothing is waiting for you.')
    : list(d.approvals.map((a) => `<li><code>${esc(a.identity)}</code> asks to <b>${esc(a.action)}</b> ${esc(a.resource)}</li>`)) + none('Answer them on the cards in the window.');
  const highlights = d.feedError ? none(d.feedError) : !d.highlights?.length ? none('Nothing highlighted in the feed.')
    : list(d.highlights.map((i) => `<li>${link(i)}${i.summary ? ` <span class="note">${esc(i.summary)}</span>` : ''}</li>`));
  const advisories = d.feedError ? none(d.feedError) : !d.advisories?.length ? none('No advisories for anything installed here.')
    : list(d.advisories.map((i) => `<li class="adv ${esc(i.advisory?.severity)}"><b>${esc(i.advisory?.tool)}</b> · ${esc(i.advisory?.severity)} · ${link(i)}${i.advisory?.summary ? ` <span class="note">${esc(i.advisory.summary)}</span>` : ''}</li>`));
  /** @type {Record<string, string>} */
  const bodies = {
    advisories: card('Advisories for installed tools', advisories),
    approvals: card('Approvals waiting', approvals),
    runs: card(`Overnight runs (since ${since})`, runs),
    highlights: card('Feed highlights', highlights),
  };
  const on = d.cards ?? START_CARDS.map(([id]) => id);
  const shown = START_CARDS.filter(([id]) => on.includes(id)).map(([id]) => bodies[id]);
  return `<style>.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.card{border:1px solid #8884;border-radius:8px;padding:4px 16px 12px}.card h2{font-size:1.05em}.card li.bad,.card li.adv.high,.card li.adv.critical{color:#e5534b}.card ul{padding-left:18px}</style>
<h1>Start</h1>
${shown.length ? `<div class="cards">
${shown.join('\n')}
</div>` : none('Every card is turned off. Turn them on in Settings › Start and new tab.')}`;
}
