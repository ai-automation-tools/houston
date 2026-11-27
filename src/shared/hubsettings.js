// Project Hub's own settings, changed from Houston's Settings pane (owner's call
// 2026-11-27): the folders Hub shows next to Projects and how deep it scans. Hub saves
// them in its hub.config.json and checks them again; these are Houston's checks before a
// request leaves main. Pure; src/main/hub.js sends them.

export const DEPTH_MIN = 1;
export const DEPTH_MAX = 32;
const NAME_MAX = 40;
/** Control, bidi and zero-width characters: a name or path with one isn't what it looks like. */
const HIDDEN = /[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/;

/**
 * A folder name for Hub's sidebar: 1–40 characters, no slashes or hidden characters.
 * @param {unknown} value
 */
function folderName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > NAME_MAX || /[\\/]/.test(name) || HIDDEN.test(name)) {
    throw new Error(`A folder name is 1 to ${NAME_MAX} characters, without slashes`);
  }
  return name;
}

/**
 * A folder to add to Hub, or one to remove, as Hub's /api/roots takes it. A path must be
 * a folder on a drive of this machine (D:\Work\Notes): never a network path, which would
 * have Hub sign in to that server with your Windows account to scan it.
 * @param {unknown} input { op: 'add', dir, name?, force? } or { op: 'remove', name }
 * @returns {{ method: 'POST', body: { dir: string, name: string, force: boolean } } | { method: 'DELETE', body: { name: string } }}
 */
export function hubFolderChange(input) {
  const i = /** @type {Record<string, unknown>} */ (input && typeof input === 'object' ? input : {});
  if (i.op === 'remove') return { method: 'DELETE', body: { name: folderName(i.name) } };
  if (i.op !== 'add') throw new Error('Add or remove a folder');
  const dir = String(i.dir ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!/^[a-z]:[\\/]/i.test(dir) || dir.length > 1024 || HIDDEN.test(dir)) {
    throw new Error('Give the full path to a folder on this machine, like D:\\Work\\Notes');
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(dir)) throw new Error("A folder path can't go up with ..");
  if (/^[a-z]:[\\/]*$/i.test(dir)) throw new Error('A whole drive is too much to scan. Pick a folder on it.');
  const last = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const name = folderName(String(i.name ?? '').trim() || last);
  return { method: 'POST', body: { dir, name, force: i.force === true } };
}

/**
 * A scan depth for Hub's /api/scan-settings: the default for every workspace, or one
 * workspace's own (null puts that workspace back on the default).
 * @param {unknown} input { maxDepth, workspace? }
 * @param {string[]} workspaces the names Hub listed
 * @returns {{ maxDepth: number | null, workspace?: string }}
 */
export function scanDepthChange(input, workspaces) {
  const i = /** @type {Record<string, unknown>} */ (input && typeof input === 'object' ? input : {});
  const workspace = i.workspace === undefined || i.workspace === '' ? undefined : String(i.workspace);
  if (workspace !== undefined && !workspaces.includes(workspace)) throw new Error('Not a workspace Project Hub lists');
  if (workspace !== undefined && i.maxDepth === null) return { maxDepth: null, workspace };
  const depth = i.maxDepth;
  if (!Number.isInteger(depth) || /** @type {number} */ (depth) < DEPTH_MIN || /** @type {number} */ (depth) > DEPTH_MAX) {
    throw new Error(`Scan depth is a whole number from ${DEPTH_MIN} to ${DEPTH_MAX}`);
  }
  return workspace === undefined ? { maxDepth: /** @type {number} */ (depth) } : { maxDepth: /** @type {number} */ (depth), workspace };
}
