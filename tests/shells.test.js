import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickShell, shellProfiles } from '../src/shared/shells.js';
import { menuItems, pasteLabel } from '../src/shared/menu.js';

const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };

test('shellProfiles lists installed shells, PowerShell 7 first, with fixed arguments', () => {
  const all = shellProfiles(env, () => true);
  assert.deepEqual(all.map((s) => s.id), ['pwsh', 'powershell', 'cmd', 'git-bash']);
  assert.equal(all[0].file, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.deepEqual(all[0].args, ['-NoLogo']);
  assert.deepEqual(all.filter((s) => s.powershell).map((s) => s.id), ['pwsh', 'powershell']);
});

test('shellProfiles skips missing shells and finds a per-user Git install', () => {
  const have = new Set(['C:\\Windows\\System32\\cmd.exe', 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe']);
  const found = shellProfiles(env, (f) => have.has(f));
  assert.deepEqual(found.map((s) => s.id), ['cmd', 'git-bash']);
  assert.equal(found[1].file, 'C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
});

test('shellProfiles falls back to powershell.exe on PATH when nothing is found', () => {
  assert.deepEqual(shellProfiles({}, () => false).map((s) => [s.id, s.file]), [['powershell', 'powershell.exe']]);
});

test('pickShell takes a known id and gives the default for anything else', () => {
  const all = shellProfiles(env, () => true);
  assert.equal(pickShell(all, 'cmd').id, 'cmd');
  for (const bad of [undefined, '', 'C:\\evil.exe', 'pwsh -Command x', 5, {}]) assert.equal(pickShell(all, bad).id, 'pwsh');
});

test('menuItems keeps ids, labels and separators, and refuses anything else', () => {
  assert.deepEqual(menuItems([{ id: 'a', label: 'A', click: 'x' }, '-']), [{ id: 'a', label: 'A' }, '-']);
  for (const bad of [null, 'x', [{}], [{ id: 1, label: 'A' }], [{ id: 'a', label: '' }], [{ id: 'a', label: 'x'.repeat(201) }], Array(41).fill('-')]) {
    assert.throws(() => menuItems(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('menuItems doubles & so a Windows menu shows it instead of a mnemonic', () => {
  assert.deepEqual(menuItems([{ id: 'a', label: 'R&D' }]), [{ id: 'a', label: 'R&&D' }]);
});

test('pasteLabel previews the first line, clipped, with the line count, and nothing for an empty clipboard', () => {
  assert.equal(pasteLabel('Get-ChildItem'), 'Paste: Get-ChildItem');
  assert.equal(pasteLabel('Get-ChildItem\r\n'), 'Paste: Get-ChildItem');
  assert.equal(pasteLabel('cd ..\nrm -r x\n'), 'Paste 2 lines: cd ..');
  assert.equal(pasteLabel('x'.repeat(50)), `Paste: ${'x'.repeat(40)}…`);
  assert.equal(pasteLabel('a\u001b[31mb\u200bc\tz'), 'Paste: a[31mbcz');
  for (const empty of ['', '  ', '\r\n\n', undefined]) assert.equal(pasteLabel(/** @type {any} */ (empty)), '');
});
