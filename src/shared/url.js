// Address-bar input → a URL the browser pane can load. Pure, tested in tests/url.test.js.

const SEARCH = 'https://www.google.com/search?q=';

/**
 * @param {string} input
 * @returns {string}
 */
export function toUrl(input) {
  const text = input.trim();
  if (!text) return 'about:blank';

  // Already a URL with a scheme we allow.
  if (/^(https?|file|chrome-extension):\/\//i.test(text) || /^about:/i.test(text) || /^acc:\/\/(doc|run|runlog|git|dev|transcript|settings|identities|start|health)\//i.test(text)) return text;

  // A Windows path: D:\x\y.html or D:/x/y.html
  if (/^[a-z]:[\\/]/i.test(text)) return `file:///${text.replace(/\\/g, '/')}`;

  // localhost and loopback, with or without a port.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;

  // Something that looks like a host: no spaces and a dot in the first segment.
  if (!/\s/.test(text) && /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(text)) return `https://${text}`;

  return SEARCH + encodeURIComponent(text);
}

/**
 * Schemes a tab may be sent to. Everything else (javascript:, data:, custom protocol
 * handlers, the shell's acc://shell) is refused before it reaches the browser pane.
 * Houston's document pages (acc://doc) open from the app itself, with no `from`,
 * or from another document page; a web page can't navigate to one. A Cronsole run's
 * output (acc://run), a terminal_run run's (acc://runlog), a Git diff (acc://git), a dev server's log (acc://dev) a contained session's transcript (acc://transcript), Settings (acc://settings), the Identity Center (acc://identities) and Health (acc://health) open from
 * the app only. A local file (file:) opens from the app (the address bar, a restored
 * tab) or from another local file, never from a web or extension page, and only on a
 * drive of this machine (isLocalFileUrl).
 * @param {string} url
 * @param {string} [from] URL of the page asking, when a page asks
 */
export function isAllowedNavigation(url, from = '') {
  if (/^acc:\/\/doc\//i.test(url)) return !from || /^acc:\/\/doc\//i.test(from);
  if (/^acc:\/\/(run|runlog|git|dev|transcript|settings|identities|start|health)\//i.test(url)) return !from;
  if (/^file:/i.test(url)) return isLocalFileUrl(url) && (!from || /^file:/i.test(from));
  return /^(https?|chrome-extension|about):/i.test(url);
}

/**
 * Whether a file: URL is a path on a drive of this machine (file:///C:/…), with no host.
 * One with a host (file://server/share, however it's spelled) makes Windows sign in to that
 * server over SMB, which sends the user's NTLM hash, so the browse session refuses every
 * such request, a page's image as much as a navigation (2026-11-27 security call).
 * @param {string} url
 */
export function isLocalFileUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'file:' && u.host === '' && /^\/[a-z]:\//i.test(u.pathname);
}

/** @param {string} s */
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A local folder as a plain page of links (the browse session's file: handler serves it,
 * since Chromium's own listing doesn't come through that handler). Folders first, by name.
 * @param {string} url the folder's file: URL
 * @param {{ name: string, dir: boolean }[]} entries
 */
export function fileListing(url, entries) {
  const base = url.endsWith('/') ? url : `${url}/`;
  const title = escapeHtml(decodeURIComponent(new URL(base).pathname.slice(1)));
  const rows = [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .map((e) => `<li><a href="${escapeHtml(base + encodeURIComponent(e.name) + (e.dir ? '/' : ''))}">${escapeHtml(e.name)}${e.dir ? '/' : ''}</a></li>`);
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><ul><li><a href="../">../</a></li>${rows.join('')}</ul>`;
}
