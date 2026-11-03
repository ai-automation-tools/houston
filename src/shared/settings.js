// settings.json in the app's userData folder: the few things that differ from one
// machine to the next. Missing or broken values fall back to neutral defaults, so a
// fresh install needs no file at all. Pure; src/main/store.js reads the file.

export const DEFAULT_HUB_URL = 'http://127.0.0.1:4273';
export const PROJECT_HUB_REPO = 'https://github.com/ai-automation-tools/project-hub';
const MAX_LINKS = 12;
const MAX_LABEL = 40;

/** @typedef {{ hubUrl: string, quickLinks: { label: string, url: string }[], newsSources: { label: string, url: string }[] }} Settings */

/**
 * A News source: an http(s) feed or Markdown address, or an absolute path to a local
 * `.md` file (only settings.json can name one; the renderer never does). Null otherwise.
 * @param {unknown} value
 */
function newsSource(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^[a-z]:[\\/][^\0]*\.md$/i.test(v) && !/(^|[\\/])\.\.([\\/]|$)/.test(v)) return v;
  // Not httpUrl(): a feed's trailing slash can matter.
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * An http(s) URL with no trailing slash, or null.
 * @param {unknown} value
 */
function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Hub's address: on this machine only, unless ACC_HUB_REMOTE=1 says a remote Hub is
 * meant. The app sends Hub file ids and favorites and opens what it answers, so a
 * typo'd or planted remote address shouldn't be enough.
 * @param {unknown} value
 * @param {boolean} remoteOk
 */
function hubAddress(value, remoteOk) {
  const url = httpUrl(value);
  if (!url) return null;
  return remoteOk || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(new URL(url).origin) ? url : null;
}

/**
 * @param {unknown} raw the parsed file, or anything else
 * @param {Record<string, string | undefined>} [env] ACC_HUB_URL wins over the file; ACC_HUB_REMOTE=1 allows a non-loopback Hub
 * @returns {Settings}
 */
export function settingsFrom(raw, env = {}) {
  const d = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  const remoteOk = env.ACC_HUB_REMOTE === '1';
  const hubUrl = hubAddress(env.ACC_HUB_URL, remoteOk) || hubAddress(d.hubUrl, remoteOk) || DEFAULT_HUB_URL;
  /** @type {{ label: string, url: string }[]} */
  const quickLinks = [];
  for (const l of Array.isArray(d.quickLinks) ? d.quickLinks : []) {
    const url = httpUrl(l?.url);
    const label = typeof l?.label === 'string' ? l.label.trim().slice(0, MAX_LABEL) : '';
    if (url && label) quickLinks.push({ label, url });
    if (quickLinks.length === MAX_LINKS) break;
  }
  /** @type {{ label: string, url: string }[]} */
  const newsSources = [];
  for (const n of Array.isArray(d.newsSources) ? d.newsSources : []) {
    const url = newsSource(n?.url);
    const label = typeof n?.label === 'string' ? n.label.trim().slice(0, MAX_LABEL) : '';
    if (url && label) newsSources.push({ label, url });
    if (newsSources.length === MAX_LINKS) break;
  }
  return {
    hubUrl,
    newsSources,
    quickLinks: quickLinks.length ? quickLinks : [
      { label: 'Project Hub', url: hubUrl },
      { label: 'Chrome Web Store', url: 'https://chromewebstore.google.com' },
    ],
  };
}
