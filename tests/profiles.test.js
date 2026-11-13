import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILE, activeFrom, browsePartition, profileId, profileMenu, profileParts } from '../src/shared/profiles.js';
import { controls, settingsBody } from '../src/shared/scopes.js';
import { escapeHtml } from '../src/shared/docs.js';

test('the default profile keeps today\'s files and partition; another gets its own of both', () => {
  assert.deepEqual(profileParts(DEFAULT_PROFILE), []);
  assert.deepEqual(profileParts('lab'), ['profiles', 'lab']);
  assert.equal(browsePartition(DEFAULT_PROFILE), 'persist:browse');
  assert.equal(browsePartition('lab'), 'persist:browse-lab');
  for (const bad of ['../x', 'Lab', '', 'a b', 'x'.repeat(41)]) assert.throws(() => profileParts(bad), /profile id/, bad);
  assert.throws(() => browsePartition('../x'), /profile id/);
  assert.equal(profileId('lab-2'), 'lab-2');
});

test('profile.json: a valid active id, or the default for anything else', () => {
  assert.equal(activeFrom({ active: 'lab' }), 'lab');
  for (const j of [null, 'lab', {}, { active: '../x' }, { active: 3 }]) assert.equal(activeFrom(j), DEFAULT_PROFILE);
});

test('the 🧭 menu lists the profiles with the active one checked, and a missing active one still shows', () => {
  const list = [{ id: 'default', displayName: 'Default' }, { id: 'lab', displayName: 'Lab' }];
  const m = profileMenu(list, 'lab');
  assert.deepEqual(m.map((x) => x.id), ['profile:default', 'profile:lab', 'profile-new']);
  assert.match(m[1].label, /^✓ Profile: Lab$/);
  assert.match(m[0].label, /restarts Houston/);
  assert.deepEqual(profileMenu([], 'lab').map((x) => x.id), ['profile:lab', 'profile-new'], 'the Core is down: the active one alone');
});

test('Settings names the active profile on its table and counts the profiles', () => {
  const s = /** @type {any} */ ({
    hubUrl: 'http://127.0.0.1:4273', hubToken: 'none', quickLinks: 0, newsSources: 0, bookmarkSource: '', adBlock: true, closeToTray: true,
    chat: { model: '', missing: ['K'] }, cronsole: { configured: false, ui: '' }, mcpUrl: '', workspaces: 1,
    workspace: { name: 'w', folder: '', tabs: 0, terminals: 0 }, core: null,
    profile: { active: 'lab', name: 'Lab', list: [{ id: 'default', displayName: 'Default' }, { id: 'lab', displayName: 'Lab' }] },
  });
  assert.equal(controls(s).find((r) => r.label === 'Profiles')?.value, '2 profiles; this window runs as Lab');
  assert.ok(settingsBody(s, escapeHtml).includes('<h2>Profile: Lab</h2>'));
});
