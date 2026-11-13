// The window's side of profiles (H5): which one is active, where its files and browser storage
// live, and what the 🧭 menu offers. The Core owns the list (profile.list); the window keeps
// only which one it runs as, in profile.json. Switching relaunches the app, so every file, the
// browser partition and every Core query start over in the new profile. No Node imports: the
// browser demo loads it too.

export const DEFAULT_PROFILE = 'default';
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** @param {unknown} v @returns {string} */
export function profileId(v) {
  if (typeof v !== 'string' || !PROFILE_ID.test(v)) throw new Error('a profile id is lower-case letters, digits, - and _, up to 40');
  return v;
}

/** The active profile from profile.json's contents; the default for anything else. @param {unknown} json */
export function activeFrom(json) {
  const a = json && typeof json === 'object' ? /** @type {any} */ (json).active : undefined;
  return typeof a === 'string' && PROFILE_ID.test(a) ? a : DEFAULT_PROFILE;
}

/**
 * Where a profile's window files live, as path parts under the app's userData folder. The
 * default's are where they always were, so nothing moves.
 * @param {string} id
 */
export const profileParts = (id) => (id === DEFAULT_PROFILE ? [] : ['profiles', profileId(id)]);

/** The browser storage (cookies, sign-ins, cache) for a profile: never shared with another. @param {string} id */
export const browsePartition = (id) => (id === DEFAULT_PROFILE ? 'persist:browse' : `persist:browse-${profileId(id)}`);

/**
 * The profile part of the 🧭 menu: each profile, the active one checked, then how to make one.
 * @param {{ id: string, displayName: string }[]} list the Core's, or just the active one when the Core is down
 * @param {string} active
 */
export function profileMenu(list, active) {
  const all = list.some((p) => p.id === active) ? list : [{ id: active, displayName: active }, ...list];
  return [
    ...all.map((p) => ({ id: `profile:${p.id}`, label: `${p.id === active ? '✓ ' : '    '}Profile: ${p.displayName}${/** @type {any} */ (p).preset === 'quarantine' ? ' 🧪 quarantine' : ''}${p.id === active ? '' : ' (restarts Houston)'}` })),
    { id: 'profile-new', label: 'New profile: npm run ctl -- profile.create id=… displayName=… (preset=quarantine to try an untrusted MCP server)' },
  ];
}
