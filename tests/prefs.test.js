import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutPrefs, prefChange } from '../src/shared/prefs.js';

const ctx = { shells: ['pwsh', 'cmd'], remoteHub: false };

test('layoutPrefs falls back to the defaults for missing or hand-broken values', () => {
  assert.deepEqual(layoutPrefs({}), { theme: 'system', startTab: 'restore', startTerminal: true, defaultShell: '', tabLabels: 'both' });
  assert.deepEqual(layoutPrefs({ theme: 'dark', startTab: 'start', startTerminal: false, defaultShell: 'cmd', tabLabels: 'both' }), { theme: 'dark', startTab: 'start', startTerminal: false, defaultShell: 'cmd', tabLabels: 'both' });
  assert.deepEqual(layoutPrefs({ theme: 'neon', startTab: 'x', startTerminal: 'no', defaultShell: 3, tabLabels: 'big' }), { theme: 'system', startTab: 'restore', startTerminal: true, defaultShell: '', tabLabels: 'both' });
});

test('prefChange sends each window choice to layout.json, checked', () => {
  assert.deepEqual(prefChange('closeToTray', false, ctx), { file: 'layout', key: 'closeToTray', value: false });
  assert.deepEqual(prefChange('theme', 'light', ctx), { file: 'layout', key: 'theme', value: 'light' });
  assert.deepEqual(prefChange('defaultShell', 'cmd', ctx), { file: 'layout', key: 'defaultShell', value: 'cmd' });
  assert.deepEqual(prefChange('tabLabels', 'names', ctx), { file: 'layout', key: 'tabLabels', value: 'names' });
  assert.throws(() => prefChange('tabLabels', 'huge', ctx), /icons, names, both/);
  assert.throws(() => prefChange('adBlock', 'yes', ctx), /on or off/);
  assert.throws(() => prefChange('theme', 'neon', ctx), /system, light, dark/);
  assert.throws(() => prefChange('startTab', 'blank', ctx), /restore, start/);
  assert.throws(() => prefChange('defaultShell', 'C:\\Windows\\evil.exe', ctx), /Not a shell/);
});

test('prefChange checks sources the way settings.json is read, and empty means the default', () => {
  assert.deepEqual(prefChange('hubUrl', 'http://localhost:4300/', ctx), { file: 'settings', key: 'hubUrl', value: 'http://localhost:4300' });
  assert.deepEqual(prefChange('hubUrl', '', ctx), { file: 'settings', key: 'hubUrl', value: undefined });
  assert.throws(() => prefChange('hubUrl', 'http://hub.example.com', ctx), /this machine/);
  assert.equal(prefChange('hubUrl', 'https://hub.example.com', { ...ctx, remoteHub: true }).value, 'https://hub.example.com');
  assert.throws(() => prefChange('hubUrl', 'file:///C:/x', ctx), /http or https/);

  assert.deepEqual(prefChange('quickLinks', [{ label: ' Docs ', url: 'https://example.com/docs/' }], ctx).value, [{ label: 'Docs', url: 'https://example.com/docs' }]);
  assert.throws(() => prefChange('quickLinks', [{ label: 'x', url: 'javascript:alert(1)' }], ctx), /Row 1's address/);
  assert.throws(() => prefChange('quickLinks', [{ label: '', url: 'https://example.com' }], ctx), /Row 1 needs a name/);
  assert.throws(() => prefChange('quickLinks', Array(13).fill({ label: 'a', url: 'https://example.com' }), ctx), /At most 12/);
  assert.throws(() => prefChange('quickLinks', 'https://example.com', ctx), /must be a list/);

  assert.deepEqual(prefChange('newsSources', [{ label: 'Digest', url: 'D:\\notes\\digest.md' }], ctx).value, [{ label: 'Digest', url: 'D:\\notes\\digest.md' }]);
  assert.throws(() => prefChange('newsSources', [{ label: 'x', url: 'D:\\notes\\..\\secret.md' }], ctx), /Row 1's address/);

  assert.equal(prefChange('feedIndex', 'D:\\feeds\\index.json', ctx).value, 'D:\\feeds\\index.json');
  assert.equal(prefChange('feedIndex', '', ctx).value, undefined);
  assert.throws(() => prefChange('feedIndex', 'index.json', ctx), /absolute path/);
});

test('prefChange refuses anything that is not a preference', () => {
  for (const key of ['grants', 'hardDenies', 'stopAll', 'mcpUrl', 'chatKey', '__proto__', 'layout']) {
    assert.throws(() => prefChange(key, true, ctx), /can't be changed from Settings/, key);
  }
});
