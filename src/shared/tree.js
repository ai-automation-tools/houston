// Pure helpers over Project Hub's /api/scan tree. No Electron, no DOM, so they run
// under `node --test` as-is.

/** Kinds Project Hub uses for nodes that hold other nodes. */
const CONTAINER_KINDS = new Set([
  'projects', 'root', 'section', 'cli', 'folder', 'repo', 'group', 'draft', 'docroot', 'userroot',
]);

/**
 * @typedef {{ id: string, name: string, kind: string, children?: HubNode[], desc?: string, size?: number }} HubNode
 */

/** @param {HubNode} node */
export function isContainer(node) {
  return Array.isArray(node.children) || CONTAINER_KINDS.has(node.kind);
}

/**
 * Turn a Hub node id into an absolute Windows-style path with forward slashes.
 * Ids are relative to the scan's `base`, except `~/...`, which is the home folder,
 * and `@...`, which is a virtual grouping with no path at all.
 * @param {string} id
 * @param {{ base: string, home: string }} scan
 * @returns {string | null}
 */
export function absPath(id, scan) {
  if (!id || id.startsWith('@')) return null;
  if (id === '~') return scan.home;
  if (id.startsWith('~/')) return `${scan.home}/${id.slice(2)}`;
  return `${scan.base}/${id}`;
}

/** @param {HubNode} node */
const isHtml = (node) => node.kind === 'html' || /\.html?$/i.test(node.name);

/**
 * What a click on a node should do. Folders expand; HTML opens in a browser tab;
 * everything else opens as a document page (acc://doc, src/shared/docs.js) in a tab.
 * @param {HubNode} node
 * @returns {'expand' | 'browse' | 'view'}
 */
export function defaultAction(node) {
  if (isContainer(node)) return 'expand';
  if (isHtml(node)) return 'browse';
  return 'view';
}

/** @typedef {'view' | 'browse' | 'code' | 'reveal' | 'terminal' | 'workspace' | 'copy-path' | 'copy-id'} FileAction */

/**
 * The right-click menu for a Files row, as `{ id, label }` items and '-' separators.
 * Virtual `@` nodes have no path, so they get nothing.
 * @param {HubNode} node
 * @returns {({ id: FileAction, label: string } | '-')[]}
 */
export function fileMenu(node) {
  if (!node.id || node.id.startsWith('@')) return [];
  const folder = isContainer(node);
  return [
    { id: 'view', label: folder ? 'View folder here' : 'View here' },
    ...(folder ? [] : [{ id: /** @type {const} */ ('browse'), label: isHtml(node) ? 'Open page in a tab' : 'Open raw file in a tab' }]),
    { id: 'code', label: 'Open in VS Code' },
    { id: 'reveal', label: 'Reveal in Explorer' },
    { id: 'terminal', label: folder ? 'Terminal here' : 'Terminal in this folder' },
    ...(folder ? [{ id: /** @type {const} */ ('workspace'), label: 'Open as workspace' }] : []),
    '-',
    { id: 'copy-path', label: 'Copy path' },
    { id: 'copy-id', label: 'Copy Project Hub id' },
  ];
}

/**
 * The folder a terminal should start in for this node: the node itself when it's a
 * container, otherwise its parent.
 * @param {HubNode} node
 * @param {{ base: string, home: string }} scan
 */
export function terminalDir(node, scan) {
  const p = absPath(node.id, scan);
  if (!p) return null;
  return isContainer(node) ? p : p.slice(0, p.lastIndexOf('/'));
}

/**
 * Flatten a tree into search entries. Iterative, so a 35k-node scan can't blow the stack.
 * @param {HubNode[]} roots
 * @returns {{ node: HubNode, path: string }[]}
 */
export function flatten(roots) {
  /** @type {{ node: HubNode, path: string }[]} */
  const out = [];
  /** @type {{ node: HubNode, trail: string }[]} */
  const stack = roots.map((node) => ({ node, trail: '' })).reverse();
  while (stack.length) {
    const { node, trail } = /** @type {{ node: HubNode, trail: string }} */ (stack.pop());
    const path = trail ? `${trail} / ${node.name}` : node.name;
    out.push({ node, path });
    const kids = node.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], trail: path });
  }
  return out;
}

/**
 * Case-insensitive search over flattened entries. Every word in the query has to
 * appear in the name or the trail. Name matches rank ahead of trail-only matches,
 * then shorter names first.
 * @param {{ node: HubNode, path: string }[]} entries
 * @param {string} query
 * @param {number} [limit]
 */
export function search(entries, query, limit = 50) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const e of entries) {
    const name = e.node.name.toLowerCase();
    const hay = e.path.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const score = (words.every((w) => name.includes(w)) ? 0 : 1000) + name.length;
    hits.push({ ...e, score });
  }
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, limit);
}

/**
 * Flatten a browser bookmark tree (Hub's /api/webmarks or /api/favorites shape:
 * folders are `{ name, children }`, links are `{ name, url }`) into search entries.
 * @param {{ name: string, url?: string, children?: any[] }[]} roots
 */
export function flattenBookmarks(roots) {
  /** @type {{ name: string, url: string, path: string }[]} */
  const out = [];
  const stack = roots.map((n) => ({ n, trail: '' }));
  while (stack.length) {
    const { n, trail } = /** @type {{ n: any, trail: string }} */ (stack.pop());
    const path = trail ? `${trail} / ${n.name}` : n.name;
    if (n.url) out.push({ name: n.name || n.url, url: n.url, path });
    for (const c of n.children || []) stack.push({ n: c, trail: path });
  }
  return out;
}

/**
 * Icons to try for an http(s) bookmark, best first: the one a tab showed for that
 * site (`known`, origin -> icon URL, from the tab strip), then the site's root
 * `/favicon.ico`. Empty for anything else (javascript:, file:, chrome:).
 * @param {string} url
 * @param {Record<string, string>} [known]
 */
export function faviconUrls(url, known = {}) {
  let u;
  try { u = new URL(url); } catch { return []; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return [];
  const root = `${u.origin}/favicon.ico`;
  const seen = Object.hasOwn(known, u.origin) ? known[u.origin] : '';
  return seen && seen !== root ? [seen, root] : [root];
}

/**
 * The origin -> icon pair to remember when a tab reports its favicon, or null when
 * either isn't worth keeping (not an http(s) page, or an icon that isn't http(s) or a
 * small data: image).
 * @param {string} pageUrl
 * @param {string} icon
 * @returns {[string, string] | null}
 */
export function faviconEntry(pageUrl, icon) {
  let u;
  try { u = new URL(pageUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const ok = /^https?:\/\//i.test(icon) || (/^data:image\//i.test(icon) && icon.length <= 16384);
  return ok ? [u.origin, icon] : null;
}

/** Bookmark source id for Project Hub's own favorites rather than a browser profile. */
export const HUB_FAVORITES = '@hub-favorites';

/**
 * The sidebar's one search box, and the `sidebar_search` MCP tool: every word must
 * appear in a file's name or trail, a bookmark's name, URL or folder, or a recent
 * item's label or target.
 * @template {{ label: string, target: string }} R
 * @param {{ files: ReturnType<typeof flatten>, bookmarks: ReturnType<typeof flattenBookmarks>, recent: R[] }} index
 * @param {string} query
 * @param {{ files: number, bookmarks: number, recent: number }} [limits]
 */
export function searchAll(index, query, limits = { files: 40, bookmarks: 25, recent: 15 }) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (/** @type {string} */ s) => words.length > 0 && words.every((w) => s.toLowerCase().includes(w));
  return {
    files: search(index.files, query, limits.files),
    bookmarks: index.bookmarks.filter((b) => match(`${b.name} ${b.url} ${b.path}`)).slice(0, limits.bookmarks),
    recent: index.recent.filter((r) => match(`${r.label} ${r.target}`)).slice(0, limits.recent),
  };
}
