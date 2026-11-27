// The Feed tab and the start page (H6): src/shared/feed.js over the file settings.json's
// `feedIndex` names, this profile's bookmarks (feed-bookmarks.json beside its settings), and
// the Core: what's installed (for advisories), last night's runs and waiting approvals.

import fs from 'node:fs';
import { advisoriesFor, feedView, parseFeed, startBody, toggleBookmark } from '../shared/feed.js';
import { docPage } from '../shared/docs.js';
import { core } from './core.js';
import { activeProfile } from './profile.js';
import { store } from './store.js';

const MAX_FILE = 5 * 1024 * 1024;

/** The feed as the index file says now, or why there is none (`unset`: no index file named). @returns {{ feed: import('../shared/feed.js').Feed | null, error: string | null, unset?: boolean }} */
function readFeed() {
  const file = store.settings().feedIndex;
  if (!file) return { feed: null, error: 'No feed yet: set the Feed index file in Settings › Sources to the index.json a scheduled job writes.', unset: true };
  try {
    if (fs.statSync(file).size > MAX_FILE) return { feed: null, error: 'The feed index is over 5 MB.' };
    return { feed: parseFeed(fs.readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    return { feed: null, error: /** @type {any} */ (e).code === 'ENOENT' ? `The feed index ${file} doesn't exist yet.` : /** @type {Error} */ (e).message };
  }
}

/** The names of what's installed here, for advisories: the profile's MCP servers and skills, the agent backends, local runtimes. */
async function installed() {
  if (process.platform !== 'win32') return [];
  const profile = activeProfile();
  const [servers, backends, skills, runtimes] = await Promise.all([
    core.call('mcp.list', { profile }).catch(() => []), core.call('backend.list').catch(() => []),
    core.call('skill.list', { profile }).catch(() => []), core.call('runtime.list', {}, 15_000).catch(() => []),
  ]);
  return [...servers.map((/** @type {any} */ s) => s.name), ...backends.filter((/** @type {any} */ b) => b.installed).map((/** @type {any} */ b) => b.name),
    ...skills.map((/** @type {any} */ s) => s.name), ...runtimes.map((/** @type {any} */ r) => r.id)];
}

export const feed = {
  /** What the Feed tab shows. */
  list() {
    const { feed: f, error, unset } = readFeed();
    if (!f) return { error, unset };
    return { generated: f.generated, dropped: f.dropped, ...feedView(f, store.feedBookmarks()) };
  },

  /** @param {unknown} id an item's */
  bookmark(id) {
    if (typeof id !== 'string' || id.length > 120) throw new Error('That is not a feed item.');
    store.saveFeedBookmarks(toggleBookmark(store.feedBookmarks(), id));
    return true;
  },

  /**
   * Register the MCP server an item names with the Core, as discovered: nothing runs until it is
   * installed and pinned in the Integrations tab. The command comes from the file, never the renderer.
   * @param {unknown} id
   */
  async discover(id) {
    const { feed: f, error } = readFeed();
    if (!f) throw new Error(error ?? 'No feed.');
    const item = f.items.find((i) => i.id === id);
    if (!item?.mcp) throw new Error('That item names no MCP server.');
    await core.call('mcp.add', { name: item.mcp.name, command: item.mcp.command, transport: item.mcp.transport, profile: activeProfile() });
    return item.mcp.name;
  },
};

/** The acc://start/ page: advisories for installed tools, approvals waiting, last night's runs, feed highlights. */
export async function startPage() {
  const now = new Date();
  // "Overnight": since 6 pm the day before, or today's 6 pm once it's passed.
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() >= 18 ? 0 : 1), 18).toISOString();
  const { feed: f, error } = readFeed();
  let runs = null;
  let approvals = null;
  let coreDown = process.platform === 'win32' ? null : 'The Core runs on Windows only.';
  if (!coreDown) {
    try {
      const [starts, ends, waiting] = await Promise.all([
        core.call('audit.query', { type: 'session.start', since, limit: 1000 }), core.call('audit.query', { type: 'session.end', since, limit: 1000 }), core.call('approval.list'),
      ]);
      const end = new Map(ends.events.map((/** @type {any} */ e) => [e.session_id, e]));
      runs = starts.events.filter((/** @type {any} */ e) => e.standing_grant && e.decision?.result === 'allow').map((/** @type {any} */ e) => {
        const x = end.get(e.session_id);
        return { identity: e.identity?.subject ?? '?', grant: e.standing_grant, startedAt: e.time, status: x ? x.outcome?.status ?? 'error' : 'running', end: x?.outcome?.error_code ?? null };
      }).reverse();
      approvals = waiting.map((/** @type {any} */ a) => ({ id: a.id, identity: a.identity, action: a.action, resource: `${a.resource?.type ?? ''} ${a.resource?.id ?? ''}`.trim() }));
    } catch (e) {
      coreDown = /** @type {any} */ (e).code === 'ENOENT' ? 'The Houston Core is not running.' : /** @type {Error} */ (e).message;
    }
  }
  const highlights = f ? (f.items.some((i) => i.highlight) ? f.items.filter((i) => i.highlight) : [...f.items].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))).slice(0, 6) : null;
  const body = startBody({ runs, approvals, highlights, advisories: f ? advisoriesFor(f, await installed()) : null, feedError: error, since, core: coreDown });
  return docPage({ title: 'Start', trail: 'Houston › Start', body });
}
