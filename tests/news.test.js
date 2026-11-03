import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ITEMS, isFeed, mergeNews, parseNews } from '../src/shared/news.js';

test('parseNews reads RSS items: CDATA, entities, tags in titles, dates', () => {
  const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title><link>https://example.com/</link>
<item><title><![CDATA[Models <b>&amp;</b> agents]]></title><link>https://example.com/a</link><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Caf&#233; &#x2014; &quot;news&quot;</title><guid>https://example.com/b</guid></item>
<item><title>No link</title></item>
<item><title></title><link>https://example.com/empty</link></item>
<item><title>Script link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
  assert.ok(isFeed(rss));
  assert.deepEqual(parseNews(rss, 'Feed'), [
    { title: 'Models & agents', url: 'https://example.com/a', at: Date.parse('2026-10-30T10:00:00Z'), source: 'Feed' },
    { title: 'Café — "news"', url: 'https://example.com/b', at: 0, source: 'Feed' },
  ]);
});

test('parseNews reads Atom entries and picks the alternate link', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title type="html">One</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/1"/><updated>2026-10-29T08:00:00Z</updated></entry>
<entry><title>Two</title><link href="https://example.com/2" /><published>2026-10-28T08:00:00Z</published></entry>
</feed>`;
  const items = parseNews(atom, 'A');
  assert.deepEqual(items.map((i) => [i.title, i.url]), [['One', 'https://example.com/1'], ['Two', 'https://example.com/2']]);
  assert.equal(items[1].at, Date.parse('2026-10-28T08:00:00Z'));
});

test('parseNews reads Markdown links, bare URLs and date headings', () => {
  const md = [
    '# Weekly AI digest',
    '## 2026-10-30',
    '- [**New model** out](https://example.com/model "title")',
    '- ![a picture](https://example.com/img.png)',
    '- See <https://example.com/auto>',
    '## Links',
    '1. Agent evals: https://example.com/evals.',
    '- [file](file:///C:/x) and [rel](./x.md)',
    'plain text',
  ].join('\r\n');
  assert.equal(isFeed(md), false);
  const items = parseNews(md, 'Digest');
  assert.deepEqual(items.map((i) => [i.title, i.url]), [
    ['New model out', 'https://example.com/model'],
    ['https://example.com/auto', 'https://example.com/auto'],
    ['Agent evals', 'https://example.com/evals'],
  ]);
  assert.equal(items[0].at, Date.parse('2026-10-30'));
});

test('parseNews takes nothing from empty or odd input, and caps a source', () => {
  assert.deepEqual(parseNews('', 'x'), []);
  assert.deepEqual(parseNews(null, 'x'), []);
  assert.deepEqual(parseNews('<html><body>not a feed</body></html>', 'x'), []);
  const many = Array.from({ length: 80 }, (_, i) => `- [n${i}](https://example.com/${i})`).join('\n');
  assert.equal(parseNews(many, 'x').length, 50);
  const long = parseNews(`[${'a'.repeat(500)}](https://example.com/)`, 'x');
  assert.equal(long[0].title.length, 200);
  // Control and invisible characters don't reach a title.
  assert.equal(parseNews('<rss><item><title>a\u202eb\u0007c</title><link>https://example.com/</link></item></rss>', 'x')[0].title, 'a b c');
});

test('mergeNews sorts newest first, keeps undated in order, drops repeats and caps', () => {
  const a = [
    { title: 'old', url: 'https://example.com/1', at: 1, source: 'a' },
    { title: 'undated', url: 'https://example.com/2', at: 0, source: 'a' },
  ];
  const b = [
    { title: 'new', url: 'https://example.com/3', at: 5, source: 'b' },
    { title: 'dupe', url: 'https://example.com/1', at: 9, source: 'b' },
    { title: 'undated b', url: 'https://example.com/4', at: 0, source: 'b' },
  ];
  assert.deepEqual(mergeNews([a, b]).map((i) => i.title), ['new', 'old', 'undated', 'undated b']);
  assert.equal(mergeNews([a, b], 2).length, 2);
  const lots = [Array.from({ length: 150 }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, at: i, source: 's' }))];
  assert.equal(mergeNews(lots).length, MAX_ITEMS);
  assert.deepEqual(mergeNews([]), []);
});
