import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepSelection, suggestAddresses } from '../src/shared/suggest.js';

const recent = [
  { type: 'url', target: 'https://docs.example.com/guide', label: 'Guide', at: 3 },
  { type: 'file', target: 'D:/work/example.md', label: 'example.md', at: 2 },
  { type: 'url', target: 'https://www.example.com/', label: 'Example home', at: 1 },
];
const bookmarks = [
  { name: 'Example home (bookmark)', url: 'https://www.example.com/', path: 'Bar / Example home' },
  { name: 'Shop', url: 'https://shop.example.org/', path: 'Bar / Shop' },
  { name: 'Local', url: 'file:///D:/work/a.html', path: 'Bar / Local' },
];

test('an empty or blank query suggests nothing', () => {
  assert.deepEqual(suggestAddresses({ recent, bookmarks }, ''), []);
  assert.deepEqual(suggestAddresses({ recent, bookmarks }, '   '), []);
});

test('every word must be in the title or the URL', () => {
  assert.deepEqual(suggestAddresses({ recent, bookmarks }, 'shop example').map((s) => s.url), ['https://shop.example.org/']);
  assert.deepEqual(suggestAddresses({ recent, bookmarks }, 'guide nothing'), []);
});

test('only web pages, each URL once, Recent winning the duplicate', () => {
  const out = suggestAddresses({ recent, bookmarks }, 'example');
  assert.deepEqual(out.map((s) => s.url), ['https://www.example.com/', 'https://docs.example.com/guide', 'https://shop.example.org/']);
  assert.equal(out[0].kind, 'recent');
  assert.equal(out[0].title, 'Example home');
  assert.ok(!out.some((s) => s.url.startsWith('file:')));
});

test('a URL starting with the first word beats a title that does, which beats the rest', () => {
  const out = suggestAddresses({ recent: [], bookmarks: [
    { name: 'Somewhere', url: 'https://example.net/docs' },
    { name: 'Docs hub', url: 'https://example.net/hub' },
    { name: 'Docs', url: 'https://docs.example.net/' },
  ] }, 'docs');
  assert.deepEqual(out.map((s) => s.title), ['Docs', 'Docs hub', 'Somewhere']);
});

test('the limit caps the list', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `Page ${i}`, url: `https://example.com/${i}` }));
  assert.equal(suggestAddresses({ bookmarks: many }, 'page').length, 8);
  assert.equal(suggestAddresses({ bookmarks: many }, 'page', 3).length, 3);
});

test('hand-edited or missing sources are skipped, not thrown on', () => {
  const junk = /** @type {any} */ ({ recent: [null, { type: 'url', target: 42 }, { type: 'url', target: 'javascript:alert(1)', label: 'x' }], bookmarks: 'nope' });
  assert.deepEqual(suggestAddresses(junk, 'x'), []);
  assert.deepEqual(suggestAddresses(/** @type {any} */ ({}), 'x'), []);
  const noTitle = suggestAddresses({ bookmarks: [/** @type {any} */ ({ url: 'https://example.com/a' })] }, 'example');
  assert.equal(noTitle[0].title, 'https://example.com/a');
});

test('arrow keys walk the rows and wrap through the typed text', () => {
  assert.equal(stepSelection(-1, 1, 3), 0);
  assert.equal(stepSelection(2, 1, 3), -1);
  assert.equal(stepSelection(-1, -1, 3), 2);
  assert.equal(stepSelection(0, -1, 3), -1);
  assert.equal(stepSelection(1, 1, 3), 2);
  assert.equal(stepSelection(0, 1, 0), -1);
});
