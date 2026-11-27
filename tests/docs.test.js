import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_HEADERS, docIdFromUrl, docPage, docUrl, escapeHtml, folderBody, imageType, gitDiffPage, isDocUrl, runPage } from '../src/shared/docs.js';
import { isContainer } from '../src/shared/tree.js';
import { isAllowedNavigation, toUrl } from '../src/shared/url.js';

test('docUrl mirrors the Hub id as a path, so relative links resolve beside the file', () => {
  const url = docUrl('Projects/Lab/README.md');
  assert.equal(url, 'acc://doc/Projects/Lab/README.md');
  assert.equal(new URL('docs/guide.md', url).href, 'acc://doc/Projects/Lab/docs/guide.md');
  assert.equal(docIdFromUrl(new URL('img/logo.png', url).href), 'Projects/Lab/img/logo.png');
});

test('docUrl and docIdFromUrl round-trip ids with spaces, #, ? and home ids', () => {
  for (const id of ['Projects/My Lab/a#b?.md', '~/notes/todo.md', '~', 'app']) assert.equal(docIdFromUrl(docUrl(id)), id);
  assert.equal(docIdFromUrl('acc://doc/Projects/Lab/'), 'Projects/Lab');
});

test('docIdFromUrl refuses other hosts, schemes, virtual ids and bad encoding', () => {
  for (const bad of ['acc://shell/index.html', 'https://doc/x', 'acc://doc/@favorites', 'acc://doc/', 'acc://doc/a%ZZb', 'acc://doc/a%00b']) {
    assert.throws(() => docIdFromUrl(bad), undefined, bad);
  }
  // The URL parser collapses .. before the id is read, so it can't climb above the root.
  assert.equal(docIdFromUrl('acc://doc/Projects/../../secret.md'), 'secret.md');
});

test('isAllowedNavigation: documents open from the app or a document, never from a web page', () => {
  assert.equal(isAllowedNavigation('acc://doc/a.md'), true);
  assert.equal(isAllowedNavigation('acc://doc/a.md', 'acc://doc/b.md'), true);
  assert.equal(isAllowedNavigation('acc://doc/a.md', 'https://evil.example/'), false);
  assert.equal(isAllowedNavigation('acc://shell/index.html'), false);
  assert.equal(isAllowedNavigation('https://example.com', 'acc://doc/a.md'), true);
  assert.equal(toUrl('acc://doc/Projects/Lab/README.md'), 'acc://doc/Projects/Lab/README.md');
  assert.equal(isDocUrl('ACC://doc/x'), true);
});

test('imageType knows common images and nothing else', () => {
  assert.equal(imageType('logo.PNG'), 'image/png');
  assert.equal(imageType('a.svg'), 'image/svg+xml');
  for (const n of ['README.md', 'run.ps1', 'png', 'x.png.exe']) assert.equal(imageType(n), null, n);
});

test('folderBody lists folders first, links each child, and escapes names', () => {
  const body = folderBody({ id: 'p', name: 'p', kind: 'folder', children: [
    { id: 'p/z.md', name: 'z.md', kind: 'md' },
    { id: 'p/<b>', name: '<b>', kind: 'folder', children: [] },
  ] }, isContainer);
  assert.ok(body.indexOf('&lt;b&gt;') < body.indexOf('z.md'));
  assert.match(body, /href="acc:\/\/doc\/p\/%3Cb%3E"/);
  assert.match(folderBody({ id: 'e', name: 'e', kind: 'folder', children: [] }, isContainer), /empty/);
});

test('docPage escapes the title and trail; headers forbid scripts, frames and forms', () => {
  const page = docPage({ title: '</title><script>x()</script>', trail: 'a & b', body: '<p>hi</p>' });
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /a &amp; b/);
  assert.match(page, /<p>hi<\/p>/);
  const csp = DOC_HEADERS['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.match(csp, /frame-ancestors 'none'/);
  // A web page that asks for one with no referrer never gets the answer delivered.
  assert.equal(DOC_HEADERS['cross-origin-resource-policy'], 'same-origin');
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('isAllowedNavigation: a Cronsole run page opens from the app only', () => {
  assert.equal(isAllowedNavigation('acc://run/t1/e1'), true);
  assert.equal(isAllowedNavigation('acc://run/t1/e1', 'https://evil.example/'), false);
  assert.equal(isAllowedNavigation('acc://run/t1/e1', 'acc://doc/a.md'), false);
  assert.equal(isAllowedNavigation('acc://run/t1/e1', 'acc://run/t1/e2'), false);
  assert.equal(toUrl('acc://run/t1/e1'), 'acc://run/t1/e1');
});

test('runPage shows the output as escaped text, says when there is none, and why a fetch failed', () => {
  const run = { id: 'e1', status: 'FAILURE', triggeredAt: '2026-10-04T02:00:00.000Z', durationMs: 4200, log: null, platformRunId: 'p1' };
  const html = runPage({ task: 'Backup <x>', run, output: '<script>alert(1)</script>' });
  assert.match(html, /<pre>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/pre>/);
  assert.doesNotMatch(html, /<script>|<x>/);
  assert.match(html, /FAILURE · 2026-10-04T02:00:00.000Z · 4200 ms/);
  const empty = runPage({ task: 'Backup', run: { ...run, triggeredAt: null, durationMs: null }, output: null, error: 'timed out' });
  assert.match(empty, /recorded no output/);
  assert.match(empty, /Couldn't get the platform's output: timed out/);
  assert.match(empty, /Cronsole › Backup › e1/);
});

test('a Git diff page opens from the app only, and shows the diff as escaped, classed text', () => {
  assert.equal(isAllowedNavigation('acc://git/a.js?area=staged'), true);
  assert.equal(isAllowedNavigation('acc://git/a.js?area=staged', 'https://evil.example/'), false);
  assert.equal(isAllowedNavigation('acc://git/a.js?area=staged', 'acc://doc/a.md'), false);
  assert.equal(isAllowedNavigation('acc://git/a.js?area=staged', 'acc://git/b.js?area=staged'), false);
  assert.equal(toUrl('acc://git/a.js?area=staged'), 'acc://git/a.js?area=staged');
  const file = { path: 'src/<b>.js', from: 'old.js', staged: 'R', unstaged: null, kind: /** @type {const} */ ('renamed') };
  const html = gitDiffPage({ repo: 'D:\\work\\acme', branch: 'main', file, area: 'staged', lines: [{ cls: 'hunk', text: '@@ -1 +1 @@' }, { cls: 'add', text: '+<script>alert(1)</script>' }, { cls: 'ctx', text: '' }], truncated: true });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<span class="add">\+&lt;script&gt;/);
  assert.match(html, /<span class="ctx"> <\/span>/);
  assert.match(html, /Git › acme › src\/&lt;b&gt;\.js/);
  assert.match(html, /Staged changes · renamed from old\.js · on main/);
  assert.match(html, /Cut off after 5,000 lines/);
  assert.match(gitDiffPage({ repo: 'r', branch: '', file, area: 'unstaged', lines: [], truncated: false }), /No textual difference/);
});
