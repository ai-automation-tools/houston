import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../src/shared/mcp.js';
import { tabTools } from '../src/shared/tools.js';
import { cleanElements, describeElement, elementLine, fillTextArg, listScript, pageHost, prepareScript, refArg } from '../src/shared/pageactions.js';

/**
 * A stand-in for a DOM element: just what describeElement and the page scripts read.
 * @param {Record<string, any>} p
 */
function fakeEl({ tag, attrs = {}, rect = { left: 10, top: 20, width: 100, height: 30 }, ...rest }) {
  const el = {
    tagName: tag.toUpperCase(),
    getAttribute: (/** @type {string} */ n) => attrs[n] ?? null,
    getBoundingClientRect: () => rect,
    closest: () => null,
    isConnected: true,
    contains: (/** @type {any} */ x) => x === el,
    scrollIntoView() {},
    focus() { globalThis.document.activeElement = el; },
    select() { el.selected = true; },
    innerText: '',
    ...rest,
  };
  return el;
}

/** Runs a page script against fake page globals, the way executeJavaScriptInIsolatedWorld would. @param {string} code @param {any[]} els */
function inFakePage(code, els, { top = /** @type {any} */ (undefined) } = {}) {
  const g = /** @type {any} */ (globalThis);
  g.window ??= {};
  g.document = { querySelectorAll: () => els, elementFromPoint: () => top ?? els[0], activeElement: null, createRange: () => ({ selectNodeContents() {} }) };
  g.getComputedStyle = (/** @type {any} */ el) => ({ visibility: el.hidden ? 'hidden' : 'visible' });
  g.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  g.innerWidth = 800;
  g.innerHeight = 600;
  return (0, eval)(code);
}

test('describeElement names links, buttons and fields by their label, and strips hidden characters', () => {
  assert.deepEqual(describeElement(fakeEl({ tag: 'a', innerText: '  Read\n the docs ', href: 'https://example.com/docs' })),
    { tag: 'a', type: '', role: '', label: 'Read the docs', fillable: false, href: 'https://example.com/docs' });
  assert.equal(describeElement(fakeEl({ tag: 'input', attrs: { type: 'submit' }, value: 'Sign in' })).label, 'Sign in');
  const email = describeElement(fakeEl({ tag: 'input', attrs: { type: 'EMAIL', placeholder: 'you@example.com' } }));
  assert.deepEqual([email.type, email.label, email.fillable], ['email', 'you@example.com', true]);
  assert.equal(describeElement(fakeEl({ tag: 'input', labels: [{ innerText: 'Name' }] })).label, 'Name');
  assert.equal(describeElement(fakeEl({ tag: 'input', attrs: { type: 'checkbox', name: 'agree' } })).fillable, false);
  assert.equal(describeElement(fakeEl({ tag: 'div', attrs: { role: 'button', 'aria-label': 'Pay‮now​' } })).label, 'Pay now');
  assert.equal(describeElement(fakeEl({ tag: 'div', isContentEditable: true })).fillable, true);
  assert.equal(describeElement(fakeEl({ tag: 'button', innerText: 'x'.repeat(500) })).label.length, 120);
});

test('the list script numbers visible elements and skips hidden, disabled and zero-size ones', () => {
  const els = [
    fakeEl({ tag: 'a', innerText: 'Home', href: 'https://example.com/' }),
    fakeEl({ tag: 'button', innerText: 'Off', disabled: true }),
    fakeEl({ tag: 'input', attrs: { type: 'hidden' }, type: 'hidden' }),
    fakeEl({ tag: 'button', innerText: 'Tiny', rect: { left: 0, top: 0, width: 0, height: 0 } }),
    fakeEl({ tag: 'button', innerText: 'Invisible', hidden: true }),
    fakeEl({ tag: 'button', innerText: 'Go' }),
  ];
  const got = inFakePage(listScript(10), els);
  assert.deepEqual(got.elements.map((/** @type {any} */ e) => [e.ref, e.label]), [[1, 'Home'], [2, 'Go']]);
  assert.equal(got.truncated, false);
  assert.equal(inFakePage(listScript(1), els).truncated, true);
});

test('the prepare script acts only on the element the bar named, uncovered, and focuses a field for a fill', () => {
  const go = fakeEl({ tag: 'button', innerText: 'Go' });
  const field = fakeEl({ tag: 'input', attrs: { 'aria-label': 'Search' } });
  const listed = cleanElements(inFakePage(listScript(10), [go, field])).elements;
  assert.deepEqual(inFakePage(prepareScript(listed[0], false), [go, field], { top: go }), { x: 60, y: 35 });
  // Covered by something else at its centre.
  assert.match(inFakePage(prepareScript(listed[0], false), [go, field], { top: fakeEl({ tag: 'div' }) }).error, /covers/);
  // Its label changed since the list, or it left the page.
  go.innerText = 'Delete everything';
  assert.match(inFakePage(prepareScript(listed[0], false), [go, field], { top: go }).error, /changed/);
  go.innerText = 'Go';
  go.isConnected = false;
  assert.match(inFakePage(prepareScript(listed[0], false), [go, field], { top: go }).error, /gone/);
  assert.deepEqual(inFakePage(prepareScript(listed[1], true), [go, field], { top: field }), { x: 60, y: 35 });
  assert.equal(field.selected, true);
  // A ref the page's list doesn't have (it navigated, which empties this world).
  /** @type {any} */ (globalThis).window.__houstonRefs = undefined;
  assert.match(inFakePage(prepareScript(listed[1], true), [], {}).error, /changed since/);
});

test('cleanElements drops off-shape rows and hidden characters', () => {
  const good = { ref: 1, tag: 'a', type: '', role: '', label: 'Docs', fillable: false, href: 'https://example.com/' };
  const got = cleanElements({ elements: [good, { ...good, ref: 0 }, { ...good, label: 5 }, { ...good, href: 1 }, null, { ...good, ref: 2, label: 'a‮b' }], truncated: false });
  assert.deepEqual(got.elements.map((e) => e.ref), [1, 2]);
  assert.equal(got.elements[1].label, 'a b');
  assert.deepEqual(cleanElements('junk'), { elements: [], truncated: false });
  // Key order stays describeElement's, which the prepare script compares against.
  assert.equal(JSON.stringify(got.elements[0]), JSON.stringify(good));
});

test('elementLine, pageHost and the arguments', () => {
  const el = (/** @type {any} */ p) => ({ ref: 1, tag: 'input', type: 'text', role: '', label: '', fillable: true, ...p });
  assert.equal(elementLine(el({ type: 'email', label: 'Email' })), 'email field "Email"');
  assert.equal(elementLine(el({ type: 'submit', label: 'Buy' })), 'button "Buy"');
  assert.equal(elementLine(el({ tag: 'a', type: '', label: 'Docs', href: 'https://example.com/d' })), 'link "Docs" (https://example.com/d)');
  assert.equal(elementLine(el({ tag: 'div', type: '', role: 'tab' })), 'tab (no label)');
  assert.equal(pageHost('https://shop.example.com:8443/cart?x=1'), 'shop.example.com:8443');
  assert.equal(pageHost('not a url'), 'not a url');
  assert.equal(refArg(3), 3);
  for (const bad of [0, -1, 1.5, '1', undefined]) assert.throws(() => refArg(bad), /ref/);
  assert.equal(fillTextArg('hello world'), 'hello world');
  for (const bad of ['', 'a\nb', 'a\tb', 'a‮b', 'x'.repeat(2001), 5]) assert.throws(() => fillTextArg(bad), /text/);
});

/** @param {Partial<import('../src/shared/tools.js').Sources>} src @param {string} name @param {unknown} [args] */
async function call(src, name, args) {
  const res = /** @type {any} */ (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tabTools(/** @type {any} */ (src)), ''));
  return res.result;
}

test('tab tools: elements and a screenshot as an image block; click and fill wait for the bar, and refuse bad input before asking', async () => {
  /** @type {any[]} */
  const asked = [];
  let answer = /** @type {{ tab: number, url: string } | null} */ ({ tab: 4, url: 'https://example.com/next' });
  const src = {
    tabElements: async () => ({ tab: 4, url: 'https://example.com/', title: 'Example', elements: [], truncated: false }),
    tabScreenshot: async () => ({ tab: 4, url: 'https://example.com/', png: 'iVBORw0KGgo=' }),
    tabAct: async (/** @type {number} */ ref, /** @type {string | undefined} */ text) => { asked.push([ref, text]); return answer; },
  };
  assert.equal((await call(src, 'tab_elements')).structuredContent.title, 'Example');
  const shot = await call(src, 'tab_screenshot');
  assert.deepEqual(shot.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  assert.deepEqual(shot.structuredContent, { tab: 4, url: 'https://example.com/' });
  assert.deepEqual((await call(src, 'tab_click', { ref: 2 })).structuredContent, { clicked: true, ref: 2, tab: 4, url: 'https://example.com/next' });
  assert.equal((await call(src, 'tab_fill', { ref: 3, text: 'hi' })).structuredContent.filled, true);
  assert.deepEqual(asked, [[2, undefined], [3, 'hi']]);
  for (const [name, args] of /** @type {const} */ ([['tab_click', { ref: 0 }], ['tab_fill', { ref: 1, text: 'a\nb' }], ['tab_fill', { ref: 1 }]])) {
    assert.equal((await call(src, name, args)).isError, true);
  }
  assert.equal(asked.length, 2);
  answer = null;
  assert.match((await call(src, 'tab_click', { ref: 2 })).content[0].text, /denied/);
  const failing = { ...src, tabElements: async () => { throw new Error('No tab is attached for agents'); } };
  assert.match((await call(failing, 'tab_elements')).content[0].text, /attached/);
  const list = tabTools(/** @type {any} */ (src));
  assert.equal(list.get('tab_click')?.annotations?.destructiveHint, true);
  assert.equal(list.get('tab_elements')?.annotations?.readOnlyHint, true);
  assert.match(String(list.get('tab_elements')?.description), /not instructions/);
});
