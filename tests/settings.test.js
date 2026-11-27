import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HUB_URL, hubAuth, isHubPage, settingsFrom } from '../src/shared/settings.js';

test('isHubPage matches the Hub address by scheme, port and host, any loopback name for a Hub on this machine', () => {
  const hub = 'http://127.0.0.1:4273';
  for (const url of ['http://127.0.0.1:4273/', 'http://localhost:4273/#/Projects', 'http://[::1]:4273/?q=x']) assert.equal(isHubPage(url, hub), true, url);
  for (const url of ['http://127.0.0.1:4274/', 'https://127.0.0.1:4273/', 'http://example.com:4273/', 'acc://doc/x', 'not a url', '']) assert.equal(isHubPage(url, hub), false, url);
  assert.equal(isHubPage('https://hub.example.com/', 'https://hub.example.com'), true);
  assert.equal(isHubPage('https://localhost/', 'https://hub.example.com'), false);
  assert.equal(isHubPage('http://127.0.0.1:4273/', ''), false);
});

test('settingsFrom gives neutral defaults for no file, junk, or an empty object', () => {
  for (const raw of [undefined, null, 'x', [], {}]) {
    const s = settingsFrom(raw);
    assert.equal(s.hubUrl, DEFAULT_HUB_URL);
    assert.deepEqual(s.quickLinks.map((l) => l.label), ['Project Hub', 'Chrome Web Store']);
    assert.equal(s.quickLinks[0].url, DEFAULT_HUB_URL);
  }
});

test('settingsFrom takes the file hub URL, trimmed, http(s) only, and the environment wins', () => {
  assert.equal(settingsFrom({ hubUrl: ' http://localhost:5000/ ' }).hubUrl, 'http://localhost:5000');
  assert.equal(settingsFrom({ hubUrl: 'file:///C:/hub' }).hubUrl, DEFAULT_HUB_URL);
  assert.equal(settingsFrom({ hubUrl: 'not a url' }).hubUrl, DEFAULT_HUB_URL);
  assert.equal(settingsFrom({ hubUrl: 'http://localhost:5000' }, { ACC_HUB_URL: 'http://127.0.0.1:9/' }).hubUrl, 'http://127.0.0.1:9');
  assert.equal(settingsFrom({ hubUrl: 'http://localhost:5000' }, { ACC_HUB_URL: 'javascript:1' }).hubUrl, 'http://localhost:5000');
});

test('settingsFrom keeps only well-formed quick links, capped, and the default link follows the hub URL', () => {
  const s = settingsFrom({
    hubUrl: 'http://localhost:5000',
    quickLinks: [
      { label: ' Docs ', url: 'https://docs.example/' },
      { label: '', url: 'https://nolabel.example' },
      { label: 'No url' },
      { label: 'Bad scheme', url: 'javascript:alert(1)' },
      'junk',
      { label: 'x'.repeat(100), url: 'http://long.example' },
    ],
  });
  assert.deepEqual(s.quickLinks, [
    { label: 'Docs', url: 'https://docs.example' },
    { label: 'x'.repeat(40), url: 'http://long.example' },
  ]);
  assert.equal(settingsFrom({ hubUrl: 'http://localhost:5000', quickLinks: 'nope' }).quickLinks[0].url, 'http://localhost:5000');
  const many = settingsFrom({ quickLinks: Array.from({ length: 20 }, (_, i) => ({ label: `l${i}`, url: `https://l${i}.example` })) });
  assert.equal(many.quickLinks.length, 12);
});

test('a Hub that is not on this machine needs ACC_HUB_REMOTE=1', () => {
  assert.equal(settingsFrom({ hubUrl: 'https://hub.example:9/' }).hubUrl, DEFAULT_HUB_URL);
  assert.equal(settingsFrom({}, { ACC_HUB_URL: 'http://localhost.evil.example:4273' }).hubUrl, DEFAULT_HUB_URL);
  assert.equal(settingsFrom({}, { ACC_HUB_URL: 'http://192.168.1.5:4273' }).hubUrl, DEFAULT_HUB_URL);
  assert.equal(settingsFrom({ hubUrl: 'https://hub.example:9/' }, { ACC_HUB_REMOTE: '1' }).hubUrl, 'https://hub.example:9');
  assert.equal(settingsFrom({}, { ACC_HUB_URL: 'http://[::1]:4273', ACC_HUB_REMOTE: '0' }).hubUrl, 'http://[::1]:4273');
});

test('settingsFrom keeps news sources that are web addresses or local .md files, none by default', () => {
  assert.deepEqual(settingsFrom({}).newsSources, []);
  assert.deepEqual(settingsFrom({ newsSources: 'nope' }).newsSources, []);
  const s = settingsFrom({
    newsSources: [
      { label: ' Feed ', url: 'https://news.example.com/feed/' },
      { label: 'Digest', url: 'D:/work/notes/ai-digest.md' },
      { label: 'Backslashes', url: 'C:\\Users\\dev\\links.MD' },
      { label: 'Not markdown', url: 'D:/work/notes/secrets.txt' },
      { label: 'Relative', url: 'notes/digest.md' },
      { label: 'Climbs out', url: 'D:/work/../other/digest.md' },
      { label: 'File URL', url: 'file:///D:/work/digest.md' },
      { label: '', url: 'https://nolabel.example.com/' },
      { url: 'https://nolabel.example.com/' },
      null,
    ],
  });
  assert.deepEqual(s.newsSources, [
    { label: 'Feed', url: 'https://news.example.com/feed/' },
    { label: 'Digest', url: 'D:/work/notes/ai-digest.md' },
    { label: 'Backslashes', url: 'C:\\Users\\dev\\links.MD' },
  ]);
  const many = settingsFrom({ newsSources: Array.from({ length: 20 }, (_, i) => ({ label: `n${i}`, url: `https://n${i}.example.com/` })) });
  assert.equal(many.newsSources.length, 12);
});

test('hubAuth sends the token as a bearer header only to a Hub on this machine or over https', () => {
  assert.deepEqual(hubAuth('http://127.0.0.1:4273', ''), { state: 'none', headers: {} });
  assert.deepEqual(hubAuth('http://127.0.0.1:4273', undefined), { state: 'none', headers: {} });
  for (const url of ['http://127.0.0.1:4273', 'http://localhost:4273', 'http://[::1]:4273', 'https://hub.example.com']) {
    assert.deepEqual(hubAuth(url, ' t0k '), { state: 'sent', headers: { authorization: 'Bearer t0k' } }, url);
  }
  // Plain http to another machine would carry it in clear.
  assert.deepEqual(hubAuth('http://hub.example.com:4273', 't0k'), { state: 'withheld', headers: {} });
  assert.deepEqual(hubAuth('not a url', 't0k'), { state: 'withheld', headers: {} });
});
