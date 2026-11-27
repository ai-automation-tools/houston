import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadName, zoneIdentifier } from '../src/shared/downloads.js';

test('downloadName keeps a plain name and numbers it when taken', () => {
  const taken = new Set(['report.pdf', 'report (1).pdf', 'notes']);
  const has = (/** @type {string} */ n) => taken.has(n);
  assert.equal(downloadName('data.csv', has), 'data.csv');
  assert.equal(downloadName('report.pdf', has), 'report (2).pdf');
  assert.equal(downloadName('notes', has), 'notes (1)');
});

test('downloadName drops folders, characters Windows refuses, device names and trailing dots', () => {
  const none = () => false;
  assert.equal(downloadName('..\\..\\Windows\\evil.exe', none), 'evil.exe');
  assert.equal(downloadName('a/b/c.txt', none), 'c.txt');
  assert.equal(downloadName('what?<is>:"this"|*.txt', none), 'what__is___this___.txt');
  assert.equal(downloadName('a\u202eexe.txt', none), 'a_exe.txt');
  assert.equal(downloadName('CON.txt', none), '_CON.txt');
  assert.equal(downloadName('nul', none), '_nul');
  assert.equal(downloadName('page. . .', none), 'page');
  for (const empty of ['', '...', '   ', '/']) assert.equal(downloadName(empty, none), 'download');
});

test('zoneIdentifier marks web downloads as internet, without credentials, and nothing from this machine', () => {
  assert.equal(zoneIdentifier('https://user:pw@example.com/f.zip'),
    '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/f.zip\r\n');
  assert.equal(zoneIdentifier('blob:https://example.com/1234'), '[ZoneTransfer]\r\nZoneId=3\r\n');
  assert.equal(zoneIdentifier('file:///C:/x.txt'), '');
});
