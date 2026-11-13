import test from 'node:test';
import assert from 'node:assert/strict';
import { advisoriesFor, feedView, parseFeed, startBody, toggleBookmark } from '../src/shared/feed.js';
import { settingsFrom } from '../src/shared/settings.js';

const INDEX = {
  generated: '2026-11-13T06:00:00Z',
  categories: [
    { id: 'repos', name: 'AI repositories', definition: 'Repositories gaining stars this week.' },
    { id: 'adv', name: 'Advisories', definition: 'Security advisories for tools people install.' },
    { id: 'nodef', name: 'No definition' },
  ],
  items: [
    { id: 'r1', category: 'repos', title: 'Old repo', url: 'https://example.com/old', date: '2026-11-01T00:00:00Z' },
    { id: 'r2', category: 'repos', title: 'New repo', url: 'https://example.com/new', date: '2026-11-12T00:00:00Z', highlight: true, mcp: { name: 'newmcp', command: 'npx -y new-mcp' } },
    { id: 'a1', category: 'adv', title: 'Codex advisory', url: 'https://example.com/a1', date: '2026-11-10T00:00:00Z', advisory: { tool: 'Codex', severity: 'medium' } },
    { id: 'a2', category: 'adv', title: 'Stub <b>critical</b>', url: 'https://example.com/a2', advisory: { tool: 'smoke-stub', severity: 'CRITICAL', summary: 'Pin again' } },
    { id: 'a3', category: 'adv', title: 'Not installed', url: 'https://example.com/a3', advisory: { tool: 'something-else', severity: 'high' } },
    { id: 'bad1', category: 'repos', title: 'No URL scheme', url: 'javascript:alert(1)' },
    { id: 'bad2', category: 'nodef', title: 'Unknown category', url: 'https://example.com/x' },
    { id: 'bad3', category: 'repos', url: 'https://example.com/untitled' },
  ],
};

test('parseFeed keeps defined categories and items with a title, an http(s) URL and a known category; the rest is counted', () => {
  const f = parseFeed(JSON.stringify(INDEX));
  assert.deepEqual(f.categories.map((c) => c.id), ['repos', 'adv']);
  assert.deepEqual(f.items.map((i) => i.id), ['r1', 'r2', 'a1', 'a2', 'a3']);
  assert.equal(f.dropped, 3);
  assert.deepEqual(f.items[1].mcp, { name: 'newmcp', command: 'npx -y new-mcp', transport: 'container' });
  assert.equal(f.items[3].advisory?.severity, 'critical');
  assert.throws(() => parseFeed('nope'), /not JSON/);
  assert.throws(() => parseFeed('{"items":[]}'), /"categories" and "items"/);
});

test('feedView puts bookmarks first and each category newest first; toggleBookmark adds and removes', () => {
  const f = parseFeed(JSON.stringify(INDEX));
  const marks = toggleBookmark(toggleBookmark(toggleBookmark([], 'r1'), 'a1'), 'a1');
  assert.deepEqual(marks, ['r1']);
  const v = feedView(f, marks);
  assert.deepEqual(v.bookmarked.map((i) => i.id), ['r1']);
  assert.deepEqual(v.categories[0].items.map((i) => [i.id, i.bookmarked]), [['r2', false], ['r1', true]]);
  assert.equal(v.categories[0].definition, 'Repositories gaining stars this week.');
});

test('advisories are only for what is installed, matched by name in any case, worst first', () => {
  const f = parseFeed(JSON.stringify(INDEX));
  assert.deepEqual(advisoriesFor(f, ['codex', 'smoke-stub', 'claude-code']).map((i) => i.id), ['a2', 'a1']);
  assert.deepEqual(advisoriesFor(f, []), []);
});

test('the start page shows each card, escapes what the feed says, and says why a card is empty', () => {
  const f = parseFeed(JSON.stringify(INDEX));
  const html = startBody({
    runs: [{ identity: 'local:predictions-daily', grant: 'predictions-daily', startedAt: '2026-11-13T09:00:00Z', status: 'error', end: '1' }],
    approvals: [], highlights: f.items.filter((i) => i.highlight), advisories: advisoriesFor(f, ['smoke-stub']), feedError: null, since: '2026-11-12T18:00:00Z', core: null,
  });
  for (const t of ['Advisories for installed tools', 'Approvals waiting', 'Overnight runs', 'Feed highlights', 'predictions-daily', 'failed (1)', 'Nothing is waiting for you.', 'New repo']) assert.ok(html.includes(t), t);
  assert.ok(html.includes('Stub &#60;b&#62;critical&#60;/b&#62;') && !html.includes('<b>critical</b>'), 'feed text is escaped');
  assert.ok(!html.includes('<script'));
  const down = startBody({ runs: null, approvals: null, highlights: null, advisories: null, feedError: 'No feed yet.', since: '2026-11-12T18:00:00Z', core: 'The Houston Core is not running.' });
  assert.equal(down.split('The Houston Core is not running.').length - 1, 2);
  assert.equal(down.split('No feed yet.').length - 1, 2);
});

test('settings take a feedIndex that is an absolute path to a .json file, nothing else', () => {
  assert.equal(settingsFrom({ feedIndex: 'D:\\feeds\\index.json' }).feedIndex, 'D:\\feeds\\index.json');
  for (const bad of ['index.json', 'D:\\feeds\\..\\x\\index.json', 'D:\\feeds\\index.txt', 'https://example.com/index.json', 7]) assert.equal(settingsFrom({ feedIndex: bad }).feedIndex, null, String(bad));
  assert.equal(settingsFrom({}).feedIndex, null);
});
