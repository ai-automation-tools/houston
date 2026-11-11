import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absPath, defaultAction, faviconEntry, faviconUrls, fileMenu, flatten, flattenBookmarks, isContainer, search, terminalDir } from '../src/shared/tree.js';

const scan = { base: 'D:/work', home: 'C:/Users/dev' };

const tree = [
  {
    id: '@projects', name: 'Projects', kind: 'projects', children: [
      {
        id: 'Projects/Lab', name: 'Lab', kind: 'root', children: [
          { id: 'Projects/Lab/README.md', name: 'README.md', kind: 'md' },
          { id: 'Projects/Lab/site/index.html', name: 'index.html', kind: 'html' },
          { id: 'Projects/Lab/empty', name: 'empty', kind: 'folder' },
        ],
      },
    ],
  },
  { id: '~', name: 'User CLIs', kind: 'userroot', children: [{ id: '~/.claude/settings.json', name: 'settings.json', kind: 'config' }] },
];

test('absPath resolves base-relative, home-relative and virtual ids', () => {
  assert.equal(absPath('Projects/Lab/README.md', scan), 'D:/work/Projects/Lab/README.md');
  assert.equal(absPath('~/.claude/settings.json', scan), 'C:/Users/dev/.claude/settings.json');
  assert.equal(absPath('~', scan), 'C:/Users/dev');
  assert.equal(absPath('@projects', scan), null);
  assert.equal(absPath('', scan), null);
});

test('isContainer treats childless folders as containers', () => {
  assert.equal(isContainer({ id: 'x', name: 'empty', kind: 'folder' }), true);
  assert.equal(isContainer({ id: 'x', name: 'a.md', kind: 'md' }), false);
});

test('defaultAction: folders expand, html browses, the rest opens as a document', () => {
  assert.equal(defaultAction(tree[0]), 'expand');
  assert.equal(defaultAction({ id: 'a', name: 'index.html', kind: 'html' }), 'browse');
  assert.equal(defaultAction({ id: 'a', name: 'page.HTM', kind: 'file' }), 'browse');
  assert.equal(defaultAction({ id: 'a', name: 'README.md', kind: 'md' }), 'view');
});

test('fileMenu: folders and files get their own items, virtual nodes get none', () => {
  const ids = (/** @type {ReturnType<typeof fileMenu>} */ m) => m.map((i) => (i === '-' ? '-' : i.id));
  assert.deepEqual(ids(fileMenu({ id: 'Projects/Lab', name: 'Lab', kind: 'root', children: [] })),
    ['view', 'code', 'reveal', 'terminal', 'workspace', '-', 'copy-path', 'copy-id']);
  assert.deepEqual(ids(fileMenu({ id: 'Projects/Lab/README.md', name: 'README.md', kind: 'md' })),
    ['view', 'browse', 'code', 'reveal', 'terminal', '-', 'copy-path', 'copy-id']);
  assert.deepEqual(fileMenu(tree[0]), []);
});

test('terminalDir uses the folder itself, or a file\'s parent', () => {
  assert.equal(terminalDir({ id: 'Projects/Lab', name: 'Lab', kind: 'root', children: [] }, scan), 'D:/work/Projects/Lab');
  assert.equal(terminalDir({ id: 'Projects/Lab/README.md', name: 'README.md', kind: 'md' }, scan), 'D:/work/Projects/Lab');
  assert.equal(terminalDir({ id: '@projects', name: 'Projects', kind: 'projects', children: [] }, scan), null);
});

test('flatten walks every node in order with a readable trail', () => {
  const flat = flatten(tree);
  assert.deepEqual(flat.map((e) => e.node.name), ['Projects', 'Lab', 'README.md', 'index.html', 'empty', 'User CLIs', 'settings.json']);
  assert.equal(flat[2].path, 'Projects / Lab / README.md');
});

test('flatten survives a deep tree without recursion', () => {
  let node = { id: 'leaf', name: 'leaf', kind: 'md' };
  for (let i = 0; i < 20000; i++) node = { id: `d${i}`, name: `d${i}`, kind: 'folder', children: [node] };
  assert.equal(flatten([node]).length, 20001);
});

test('search needs every word, and ranks name hits before trail-only hits', () => {
  const flat = flatten(tree);
  const hits = search(flat, 'lab');
  assert.equal(hits[0].node.name, 'Lab');
  assert.ok(hits.some((h) => h.node.name === 'README.md'), 'trail matches are included');
  assert.deepEqual(search(flat, 'lab index').map((h) => h.node.name), ['index.html']);
  assert.deepEqual(search(flat, '   '), []);
});

test('search respects the limit', () => {
  assert.equal(search(flatten(tree), 'p', 2).length, 2);
});

test('flattenBookmarks keeps links, drops folders, records the trail', () => {
  const marks = flattenBookmarks([
    { name: 'Bar', children: [{ name: 'Docs', url: 'https://docs.example.com' }, { name: 'Sub', children: [{ name: '', url: 'https://x.dev' }] }] },
  ]);
  assert.equal(marks.length, 2);
  const x = marks.find((m) => m.url === 'https://x.dev');
  assert.equal(x?.name, 'https://x.dev', 'unnamed links fall back to their url');
  assert.equal(x?.path, 'Bar / Sub / ');
});

test('faviconUrls tries the icon a tab showed, then the site root, for http(s) only', () => {
  assert.deepEqual(faviconUrls('https://example.com/a?b#c'), ['https://example.com/favicon.ico']);
  assert.deepEqual(faviconUrls('https://example.com/a', { 'https://example.com': 'https://cdn.example.com/i.png' }),
    ['https://cdn.example.com/i.png', 'https://example.com/favicon.ico']);
  assert.deepEqual(faviconUrls('http://example.com:8080/x'), ['http://example.com:8080/favicon.ico']);
  assert.deepEqual(faviconUrls('https://example.com/', { constructor: 'x' }), ['https://example.com/favicon.ico']);
  assert.deepEqual(faviconUrls('javascript:alert(1)'), []);
  assert.deepEqual(faviconUrls('not a url'), []);
});

test('faviconEntry keeps http(s) pages with http(s) or small data: icons', () => {
  assert.deepEqual(faviconEntry('https://example.com/p', 'https://example.com/i.png'), ['https://example.com', 'https://example.com/i.png']);
  assert.deepEqual(faviconEntry('https://example.com/p', 'data:image/png;base64,AAAA'), ['https://example.com', 'data:image/png;base64,AAAA']);
  assert.equal(faviconEntry('https://example.com/p', `data:image/png;base64,${'A'.repeat(20000)}`), null);
  assert.equal(faviconEntry('https://example.com/p', 'chrome-extension://x/i.png'), null);
  assert.equal(faviconEntry('acc://shell/index.html', 'https://example.com/i.png'), null);
  assert.equal(faviconEntry('https://example.com/p', ''), null);
});
