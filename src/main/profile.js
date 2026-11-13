// The profile this run of the window belongs to (H5). Read once from profile.json in the app's
// userData folder; switching writes it and relaunches, so it never changes under a running app.
// Each profile's window files are under profileBase(); the default's stay in userData itself.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROFILE, activeFrom, profileId, profileParts } from '../shared/profiles.js';

/** Read once per userData folder: main may move it (ACC_USER_DATA) after a module has already asked. @type {{ dir: string, id: string } | null} */
let active = null;
const stateFile = () => path.join(app.getPath('userData'), 'profile.json');

export function activeProfile() {
  const dir = app.getPath('userData');
  if (active?.dir !== dir) {
    let id = DEFAULT_PROFILE;
    try { id = activeFrom(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))); } catch { /* none yet: the default */ }
    active = { dir, id };
  }
  return active.id;
}

/** The folder this profile's window files live in. */
export const profileBase = () => path.join(app.getPath('userData'), ...profileParts(activeProfile()));

/** Make `id` the profile the next start runs as. @param {unknown} id */
export function setNextProfile(id) {
  const next = profileId(id);
  fs.writeFileSync(stateFile(), JSON.stringify({ active: next }, null, 2));
  return next;
}
