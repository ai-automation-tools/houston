// Profiles (H5, CORE-06): the isolation unit for a workstream. Each identity, MCP registration
// (through its identity) and secret belongs to one, and the Core never serves one profile's
// servers or secrets to another's session. Each profile has a folder of its own under
// houston-profiles beside the data folder, for what the window keeps per profile; every
// profile's folder is a global deny (policy.js), so no grant opens one for any session.
// There is always a `default` profile (schema v9). Profiles aren't deleted: an id is never reused.

import fs from 'node:fs';
import path from 'node:path';
import { OPERATOR } from './identities.js';

export const DEFAULT_PROFILE = 'default';
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export class ProfileError extends Error {
  /** @param {string} code bad_request | not_found | conflict @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

/**
 * The folder every profile's folder sits in: beside the data folder.
 * @param {string} dir the Core's data folder
 */
export const profilesRoot = (dir) => path.join(path.dirname(dir), 'houston-profiles');

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, audit: ReturnType<typeof import('./audit.js').openAudit>, root?: string, now?: () => Date }} opts
 *   root: where profile folders go (profilesRoot); without it, none are made (tests, Linux)
 */
export function createProfiles({ db, audit, root, now = () => new Date() }) {
  /** @param {any} r */
  const shape = (r) => ({ id: r.id, displayName: r.display_name, createdAt: r.created_at, folder: root ? path.join(root, r.id) : null });
  const row = (/** @type {string} */ id) => /** @type {any} */ (db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
  // Only the default's at start: another profile's folder is made with it, and one removed by hand stays removed.
  if (root) fs.mkdirSync(path.join(root, DEFAULT_PROFILE), { recursive: true });

  return {
    list: () => /** @type {any[]} */ (db.prepare('SELECT * FROM profiles ORDER BY id = ? DESC, id').all(DEFAULT_PROFILE)).map(shape),

    /** @param {unknown} id */
    get(id) {
      const r = typeof id === 'string' ? row(id) : null;
      if (!r) throw new ProfileError('not_found', `no profile ${String(id)}`);
      return shape(r);
    },

    /** @param {any} spec id, displayName */
    create(spec) {
      const { id, displayName } = spec && typeof spec === 'object' ? spec : /** @type {any} */ ({});
      if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new ProfileError('bad_request', 'id is lower-case letters, digits, - and _, up to 40, e.g. lab');
      if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 80) throw new ProfileError('bad_request', 'displayName is text of 1 to 80 characters');
      if (row(id)) throw new ProfileError('conflict', `${id} exists`);
      db.prepare('INSERT INTO profiles (id, display_name, created_at) VALUES (?, ?, ?)').run(id, displayName, now().toISOString());
      if (root) fs.mkdirSync(path.join(root, id), { recursive: true });
      audit.append({
        type: 'profile.change', action: 'profile.create', identity: { subject: OPERATOR }, session_id: null, resource: { type: 'Profile', id },
        decision: { result: 'allow', policy_version: 'none', reasons: ['made by the operator'] },
      });
      return shape(row(id));
    },
  };
}

/**
 * The profile a name is asked for in: the default when none is given. Throws for a profile that
 * doesn't exist, so a typo never makes rows nobody can see.
 * @param {import('node:sqlite').DatabaseSync} db @param {unknown} profile
 * @param {(code: string, message: string) => Error} fail
 */
export function profileOf(db, profile, fail) {
  if (profile === undefined || profile === null) return DEFAULT_PROFILE;
  if (typeof profile !== 'string' || !PROFILE_ID.test(profile) || !db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profile)) {
    throw fail('bad_request', `profile ${String(profile)} doesn't exist (profile.list)`);
  }
  return profile;
}
