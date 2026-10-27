import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAVED_TABS_MAX, chromeUserAgent, cleanSavedTabs, cycleTab, pickTab, savedActiveIndex } from '../src/shared/session.js';

test('cleanSavedTabs keeps allowed URLs in order and drops the rest', () => {
  assert.deepEqual(
    cleanSavedTabs(['https://a.com', 'about:blank', '', 'javascript:alert(1)', 5, null, 'file:///D:/x.html', 'data:text/html,x']),
    ['https://a.com', 'file:///D:/x.html'],
  );
});

test('cleanSavedTabs returns [] for anything that is not an array', () => {
  assert.deepEqual(cleanSavedTabs(undefined), []);
  assert.deepEqual(cleanSavedTabs('https://a.com'), []);
});

test('cleanSavedTabs caps the list', () => {
  const many = Array.from({ length: SAVED_TABS_MAX + 5 }, (_, i) => `https://x.com/${i}`);
  assert.equal(cleanSavedTabs(many).length, SAVED_TABS_MAX);
});

test('savedActiveIndex falls back to the last tab when the index is bad', () => {
  assert.equal(savedActiveIndex(1, 3), 1);
  assert.equal(savedActiveIndex(3, 3), 2);
  assert.equal(savedActiveIndex(-1, 3), 2);
  assert.equal(savedActiveIndex('1', 3), 2);
  assert.equal(savedActiveIndex(undefined, 0), -1);
});

test('cycleTab wraps round the strip and starts from an end when nothing is active', () => {
  assert.equal(cycleTab([7, 3, 9], 3, 1), 9);
  assert.equal(cycleTab([7, 3, 9], 9, 1), 7);
  assert.equal(cycleTab([7, 3, 9], 7, -1), 9);
  assert.equal(cycleTab([7, 3, 9], null, 1), 7);
  assert.equal(cycleTab([7, 3, 9], null, -1), 9);
  assert.equal(cycleTab([7, 3, 9], 42, 1), 7);
  assert.equal(cycleTab([], 1, 1), null);
});

test('pickTab follows Chrome: 1 to 8 pick that tab, 9 the last, out of range nothing', () => {
  const order = [7, 3, 9];
  assert.equal(pickTab(order, 1), 7);
  assert.equal(pickTab(order, 3), 9);
  assert.equal(pickTab(order, 4), null);
  assert.equal(pickTab(order, 9), 9);
  assert.equal(pickTab([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 8), 8);
  assert.equal(pickTab([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 9), 10);
  assert.equal(pickTab(order, 0), null);
  assert.equal(pickTab([], 9), null);
});

test('chromeUserAgent drops the Electron and app tokens and keeps the rest', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36';
  assert.equal(chromeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ai-command-center/0.1.0 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36'), chrome);
  assert.equal(chromeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36'), chrome);
  assert.equal(chromeUserAgent(chrome), chrome);
});
