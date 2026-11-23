import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demoApi, commandOutput, TREE } from '../src/demo/acc.js';
import { demoHtml, HOME_URL } from '../src/demo/page.js';
import { flatten } from '../src/shared/tree.js';
import { ABOUT_HTML, WELCOME_ID, WELCOME_URL } from '../src/demo/about.js';

const read = (/** @type {string} */ p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('demoHtml adds the source bar and loads the mock before app.js', () => {
  const html = demoHtml(read('../src/renderer/index.html'));
  assert.ok(html.indexOf('demo/install.js') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('class="src-bar"') < html.indexOf('id="app"'));
  assert.ok(html.includes(`href="${HOME_URL}"`));
  // Every path relative, so the page serves under a Pages subpath.
  assert.doesNotMatch(html, /(src|href)="\/[^/]/);
  assert.throws(() => demoHtml('<html><body></body></html>'), /expected/);
});

test('renderer imports are relative', () => {
  for (const f of ['app.js', 'sidebar.js', 'terminal.js', 'chat.js']) {
    assert.doesNotMatch(read(`../src/renderer/${f}`), /from '\//, f);
  }
});

test('the mock answers every call the preload exposes', () => {
  const preload = read('../src/preload/shell.cjs');
  const block = preload.slice(preload.indexOf("exposeInMainWorld('acc'"));
  const names = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  assert.ok(names.length > 40);
  /** @param {any} o @returns {string[]} */
  const keys = (o) => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? [k, ...keys(v)] : [k]));
  const have = new Set(keys(demoApi()));
  assert.deepEqual(names.filter((n) => !have.has(n)), []);
});

test('the demo makes no network calls', () => {
  for (const f of ['acc.js', 'install.js', 'page.js', 'about.js', 'harness.js']) {
    assert.doesNotMatch(read(`../src/demo/${f}`), /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, f);
  }
});

test('fake terminal echoes, answers npm test and handles unknown commands', async () => {
  const api = demoApi();
  /** @type {string[]} */
  const got = [];
  api.term.onData((/** @type {number} */ _id, /** @type {string} */ d) => got.push(d));
  const t = await api.term.create({ cwd: 'D:/work/x', shell: 'cmd' });
  assert.equal(t.powershell, false);
  api.term.write(t.id, 'npm test\r');
  await new Promise((r) => setTimeout(r, 60));
  const text = got.join('');
  assert.match(text, /D:\\work\\x>/);
  assert.match(text, /pass 3/);
  assert.match(commandOutput('rm -rf /'), /didn't run/);
  assert.equal(commandOutput('   '), '');
});

test('tabs keep history and reopen the last closed one', async () => {
  /** @type {any[]} */
  const shown = [];
  const api = demoApi({ onTab: (t) => shown.push(t) });
  const id = await api.tabs.create('example.com');
  await api.tabs.navigate('https://example.com/b');
  await api.tabs.command('back');
  assert.equal(shown.at(-1).url, 'https://example.com');
  await api.tabs.close(id);
  assert.equal(shown.at(-1), null);
  await api.tabs.command('reopen');
  assert.equal(shown.at(-1).url, 'https://example.com');
});

test('the confirm bar ask runs only after Run', async () => {
  const api = demoApi({ askAfterMs: 0 });
  /** @type {any[]} */
  const asks = [];
  /** @type {any[]} */
  const logged = [];
  api.mcp.onConfirm((/** @type {any} */ a) => asks.push(a));
  api.mcp.onLogged((/** @type {any} */ e) => logged.push(e));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asks[0].command, 'npm test');
  assert.equal((await api.activity.list())[0].label, 'waiting for approval');
  await api.mcp.answer(asks[0].id, null);
  assert.equal(logged[0].ok, false);
  assert.equal((await api.activity.list())[0].state, 'denied');
});

test('fabricated tree has no virtual node with a path and flattens', () => {
  const flat = flatten(TREE);
  assert.ok(flat.length > 10);
  assert.ok(flat.every((f) => !/^[a-z]:/i.test(f.node.id)));
});

test('the demo opens its welcome page first, and the sidebar can reopen it', async () => {
  /** @type {any[]} */
  const shown = [];
  /** @type {any[]} */
  const created = [];
  const api = demoApi({ onTab: (t) => shown.push(t) });
  api.tabs.onCreated((/** @type {any} */ t) => created.push(t));
  await api.tabs.restore();
  assert.equal(shown.at(-1).url, WELCOME_URL);
  assert.equal(shown.at(-1).title, 'README.md');
  await api.tabs.restore();
  assert.equal(created.length, 1, 'restore opens it once');
  assert.ok(flatten(TREE).some((f) => f.node.id === WELCOME_ID));
  assert.doesNotMatch(ABOUT_HTML, /<script|\son\w+=/i);
});

test('the demo harness: start a contained shell, an ask card, its answer, the audit log, Stop All, Settings and the transcript', async () => {
  const api = demoApi();
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  /** @type {any[]} */ const opened = [];
  /** @type {Record<number, string>} */ const data = {};
  /** @type {any[][]} */ const cards = [];
  /** @type {any[]} */ const stopped = [];
  api.term.onOpened((t) => opened.push(t));
  api.term.onData((id, d) => { data[id] = (data[id] ?? '') + d; });
  api.approvals.onChanged((list) => cards.push(list));
  api.agents.onStopped((r) => stopped.push(r));

  const info = await api.agents.info();
  assert.deepEqual(info.rows.map((r) => [r.id, r.canStart, r.sessions.length]), [['local:build-shell', true, 0], ['local:dev-claude', true, 1], ['local:review-codex', false, 0]]);
  await assert.rejects(api.agents.start('local:review-codex'), /isn't active/);

  const { terminal } = await api.agents.start('local:build-shell');
  await pause();
  assert.equal(opened[0].id, terminal);
  assert.equal(opened[0].agent, 'Build shell');
  // An ask grant: the request waits on a card until it's answered.
  api.term.write(terminal, 'curl.exe https://example.com/\r');
  await pause();
  const card = (await api.approvals.list())[0];
  assert.equal(card.identity, 'local:build-shell');
  assert.deepEqual(card.resource, { type: 'Host', id: 'example.com:443' });
  await api.approvals.decide(card.id, 'session');
  await pause();
  assert.match(data[terminal], /Example Domain/);
  assert.deepEqual(await api.approvals.list(), []);
  // No grant at all: refused without asking.
  api.term.write(terminal, 'curl.exe https://pastebin.com/\r');
  await pause();
  assert.match(data[terminal], /response 403/);
  // A secret on screen, only the marker in the transcript.
  api.term.write(terminal, 'type .env\r');
  await pause();
  assert.match(data[terminal], /ANTHROPIC_API_KEY=sk-ant-demo03/);

  const denied = await api.logs.query({ result: 'deny' });
  assert.ok(denied.events.length >= 2 && denied.events.every((e) => e.decision.result === 'deny'));
  const mine = await api.logs.query({ session: opened[0].session });
  assert.deepEqual(mine.events.map((e) => e.type).reverse().slice(0, 3), ['session.start', 'approval.requested', 'approval.decided']);
  await assert.rejects(api.logs.query({ result: 'maybe' }), /allow, ask or deny/);

  const transcript = api.demoPage(`acc://transcript/${opened[0].session}`);
  assert.match(transcript, /\[REDACTED:anthropic-key\]/);
  assert.doesNotMatch(transcript, /sk-ant-demo03/);
  assert.match(api.demoPage('acc://settings/'), /<h2>Global<\/h2>/);
  assert.match(api.demoPage('acc://health/'), /<td>Audit chain<\/td>/);
  assert.equal(api.demoPage('https://example.com/'), null);

  await api.agents.stopAll();
  assert.deepEqual(stopped, [{ stopped: 2 }]);
  assert.ok((await api.agents.info()).rows.every((r) => r.sessions.length === 0));
  assert.equal((await api.logs.query({ identity: 'local:operator' })).events[0].type, 'stop.all');
  assert.ok(cards.length >= 2);
});

test('nothing the window or the demo loads imports a Node module (the browser can\'t)', () => {
  const root = new URL('../src/', import.meta.url);
  const seen = new Set();
  /** @param {URL} file */
  const walk = (file) => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    const text = fs.readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(!spec.startsWith('node:'), `${file.pathname.split('/src/')[1]} imports ${spec}`);
      if (!spec.startsWith('.') || spec.includes('/vendor/')) continue;
      // Served layout: the page's shared/ is src/shared/ (src/main/main.js SERVE, scripts/demo.js).
      walk(new URL(new URL(spec, file).href.replace('/src/renderer/shared/', '/src/shared/').replace('/src/demo/shared/', '/src/shared/')));
    }
  };
  walk(new URL('renderer/app.js', root));
  walk(new URL('demo/install.js', root));
  assert.ok(seen.size > 20);
});
