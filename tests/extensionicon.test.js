import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestIconPath } from '../src/shared/extensionicon.js';

test('manifestIconPath prefers the toolbar icon nearest above the size, then the app icon', () => {
  // AdBlock's shape: sizes 16 to 40 for the toolbar.
  const adblock = { manifest_version: 3, action: { default_icon: { 16: 'icons/a-16.png', 20: 'icons/a-20.png', 32: 'icons/a-32.png', 40: 'icons/a-40.png' } }, icons: { 128: 'icons/a-128.png' } };
  assert.equal(manifestIconPath(adblock, 32), 'icons/a-32.png');
  assert.equal(manifestIconPath(adblock, 24), 'icons/a-32.png');
  assert.equal(manifestIconPath(adblock, 64), 'icons/a-40.png', 'none big enough: the largest');
  // MV2's browser_action, a string icon, and a leading slash.
  assert.equal(manifestIconPath({ browser_action: { default_icon: '/img/b.png' } }), 'img/b.png');
  // No toolbar icon: the app icons.
  assert.equal(manifestIconPath({ action: {}, icons: { 48: 'i48.png', 128: 'i128.png' } }), 'i48.png');
  assert.equal(manifestIconPath({}), null);
  assert.equal(manifestIconPath(null), null);
});

test('manifestIconPath never leaves the extension folder', () => {
  for (const bad of ['../x.png', 'img/../../x.png', '..\\x.png', 'C:/x.png', 'file:///C:/x.png', 'https://example.com/x.png']) {
    assert.equal(manifestIconPath({ action: { default_icon: bad } }), null, bad);
  }
  assert.equal(manifestIconPath({ action: { default_icon: 'img/..icon.png' } }), 'img/..icon.png');
});
