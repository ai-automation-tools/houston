// The icon an extension's toolbar button falls back to when electron-chrome-extensions has
// none: an MV3 extension that sets its icon from image data (Rakuten and AdBlock do) is
// "not yet supported" there, and the button showed a grey letter. Main resolves the path.

/**
 * @param {Record<string, string> | undefined} set icons by size in px
 * @param {number} size
 */
function pickSize(set, size) {
  if (!set || typeof set !== 'object') return null;
  const sizes = Object.keys(set).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const best = sizes.find((n) => n >= size) ?? sizes.at(-1);
  return best === undefined ? null : set[String(best)];
}

/**
 * The manifest's toolbar icon, else its app icon: the smallest at least `size` px, else the
 * largest. A relative path inside the extension, or null; never absolute or climbing out.
 * @param {any} manifest
 * @param {number} [size]
 * @returns {string | null}
 */
export function manifestIconPath(manifest, size = 32) {
  const action = manifest?.action ?? manifest?.browser_action;
  for (const set of [action?.default_icon, manifest?.icons]) {
    const p = typeof set === 'string' ? set : pickSize(set, size);
    if (typeof p !== 'string' || !p) continue;
    const rel = p.replace(/^[/\\]+/, '');
    if (/^[a-z]+:|(^|[/\\])\.\.([/\\]|$)/i.test(rel)) return null;
    return rel;
  }
  return null;
}
