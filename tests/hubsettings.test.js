import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubFolderChange, scanDepthChange } from '../src/shared/hubsettings.js';
import { orderDots } from '../src/shared/tree.js';

test('hubFolderChange adds a folder on a drive, named after it unless named, and removes one by name', () => {
  assert.deepEqual(hubFolderChange({ op: 'add', dir: 'D:\\Work\\Notes\\' }), { method: 'POST', body: { dir: 'D:\\Work\\Notes\\', name: 'Notes', force: false } });
  assert.deepEqual(hubFolderChange({ op: 'add', dir: '"D:/Work/Notes"', name: ' Mine ', force: true }), { method: 'POST', body: { dir: 'D:/Work/Notes', name: 'Mine', force: true } });
  assert.deepEqual(hubFolderChange({ op: 'remove', name: 'Notes' }), { method: 'DELETE', body: { name: 'Notes' } });
});

test('hubFolderChange refuses network, relative, climbing and whole-drive paths, bad names and other requests', () => {
  for (const dir of ['\\\\server\\share', '//server/share', '\\\\?\\C:\\x', 'Work\\Notes', 'D:', 'D:\\', 'D:/', 'D:\\a\\..\\b', 'D:\\a\u202eb', '', 'x'.repeat(5)]) {
    assert.throws(() => hubFolderChange({ op: 'add', dir }), undefined, dir);
  }
  for (const name of ['a/b', 'a\\b', 'x'.repeat(41), '\u200b']) assert.throws(() => hubFolderChange({ op: 'add', dir: 'D:\\Work', name }), undefined, name);
  assert.throws(() => hubFolderChange({ op: 'remove', name: '' }));
  for (const input of [null, 'add', { op: 'rename' }]) assert.throws(() => hubFolderChange(input));
});

test('scanDepthChange takes 1 to 32 for the default or a listed workspace, and null only to put a workspace back', () => {
  const ws = ['Mike_Lab', 'Docs'];
  assert.deepEqual(scanDepthChange({ maxDepth: 12 }, ws), { maxDepth: 12 });
  assert.deepEqual(scanDepthChange({ maxDepth: 1, workspace: 'Docs' }, ws), { maxDepth: 1, workspace: 'Docs' });
  assert.deepEqual(scanDepthChange({ maxDepth: null, workspace: 'Docs' }, ws), { maxDepth: null, workspace: 'Docs' });
  for (const maxDepth of [0, 33, 2.5, '10', null, undefined]) assert.throws(() => scanDepthChange({ maxDepth }, ws), undefined, String(maxDepth));
  assert.throws(() => scanDepthChange({ maxDepth: 5, workspace: '../etc' }, ws));
});

test('orderDots puts dot-folders and dot-files first or last within folders and files, and keeps the rest in order', () => {
  const list = [{ name: 'src', children: [] }, { name: '.claude', children: [] }, { name: 'docs', children: [] }, { name: 'README.md' }, { name: '.env' }, { name: 'a.js' }];
  const names = (/** @type {{ name: string }[]} */ l) => l.map((n) => n.name).join(' ');
  assert.equal(names(orderDots(list, true)), '.claude src docs .env README.md a.js');
  assert.equal(names(orderDots(list, false)), 'src docs .claude README.md a.js .env');
  assert.equal(names(list), 'src .claude docs README.md .env a.js');
});
