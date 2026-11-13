// The quarantine profile preset (H5): a profile for trying an MCP server you don't trust yet.
// `profile.create ... preset=quarantine` makes it with a work folder of its own, quarantine\<id> beside
// the sessions folder (C:\ProgramData\houston-core by default), and the Core then holds everything in it to:
//   - MCP servers run in their own containers only: no host or http transport
//   - no secrets: an untrusted server gets no real credential to leak
//   - file grants only inside the work folder; net grants name one host each, no wildcards
//   - no broad-access (unconfined) identities, and no standing grants: nothing runs unattended
// What the server can then reach is the work folder, the hosts granted one by one, and its own home.

import path from 'node:path';
import { pathKey } from './paths.js';

export const QUARANTINE = 'quarantine';
export const PRESETS = [QUARANTINE];

/**
 * Beside the sessions folder, outside the user profile: a container is denied C:\Users, and Node, resolving a
 * script's real path, reads every folder above it, so a server couldn't run from inside the profile.
 * @param {string} tempRoot the sessions folder (main.js sessionTemp)
 */
export const quarantineRoot = (tempRoot) => path.join(path.dirname(tempRoot), 'quarantine');

/** @param {import('node:sqlite').DatabaseSync} db @param {unknown} profile */
export const presetOf = (db, profile) => /** @type {any} */ (db.prepare('SELECT preset FROM profiles WHERE id = ?').get(typeof profile === 'string' ? profile : 'default'))?.preset ?? null;

/** @param {import('node:sqlite').DatabaseSync} db @param {string} identity */
export const quarantined = (db, identity) => /** @type {any} */ (db.prepare('SELECT p.preset FROM identities i JOIN profiles p ON p.id = i.profile_id WHERE i.id = ?').get(identity))?.preset === QUARANTINE;

/**
 * Why a grant can't be given in a quarantine profile, or null when it can.
 * @param {string} resource '<type>:<pattern>' @param {string | null} folder the profile's work folder; null when there is none (off Windows)
 */
export function quarantineGrantRefusal(resource, folder) {
  const type = resource.slice(0, resource.indexOf(':'));
  const pattern = resource.slice(type.length + 1);
  if (type === 'secret') return 'a quarantine profile holds no secrets';
  if (type === 'net' && pattern.includes('*')) return 'in a quarantine profile a net grant names one host and port, no wildcards';
  if (type === 'file') {
    if (!folder) return 'this Core has no quarantine work folder';
    // The literal part before any wildcard, cut back to a whole folder name.
    const star = pattern.indexOf('*');
    const fixed = star < 0 ? pattern : pattern.slice(0, Math.max(pattern.lastIndexOf('/', star), 0));
    let inside = false;
    try { const p = pathKey(fixed); const f = pathKey(folder); inside = p === f || p.startsWith(`${f}/`); } catch { inside = false; }
    if (!inside) return `in a quarantine profile file grants stay inside its work folder, ${folder}`;
  }
  return null;
}
