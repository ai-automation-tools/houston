// Browser actions on the one tab the user attaches for agents (its right-click menu's
// "Let agents click and type here"): tab_elements lists what can be clicked or typed
// into, tab_screenshot shows the page, tab_click and tab_fill act on an element from
// that list once the user clicks Run on the confirm bar.
// The page scripts run in an isolated world of the tab's sandboxed renderer: they share
// the page's DOM but not its JavaScript, so the page can't see or swap the list the refs
// point into. describeElement() and the two scripts are stringified into the page, so
// they may use nothing from this module's scope. Pure: src/main/tabs.js runs them.

/** The isolated world the scripts run in; any id but 0 (the page) and 999 (Electron's preload world). */
export const AGENT_WORLD = 4242;
export const ELEMENTS_MAX = 300;
export const FILL_MAX = 2000;
// As in tools.js: what the bar shows must be what gets typed.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;

/**
 * @typedef {{ ref: number, tag: string, type: string, role: string, label: string, fillable: boolean, href?: string }} PageElement
 */

/**
 * What an element is, as tab_elements lists it and the confirm bar names it. Runs in the
 * page. Control and format characters go from the label, so the bar reads as it acts.
 * @param {any} el
 * @returns {Omit<PageElement, 'ref'>}
 */
export function describeElement(el) {
  const tag = String(el.tagName).toLowerCase();
  const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : '';
  const role = String(el.getAttribute('role') || '');
  const buttonish = ['button', 'submit', 'reset', 'image'].includes(type);
  const field = (tag === 'input' && !buttonish) || tag === 'textarea' || tag === 'select';
  const raw = el.getAttribute('aria-label')
    || (field ? (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('name')
      : buttonish ? el.value : el.innerText)
    || el.getAttribute('title') || el.getAttribute('alt') || '';
  const label = String(raw).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const fillable = tag === 'textarea' || el.isContentEditable === true
    || (tag === 'input' && ['text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(type));
  return { tag, type, role, label, fillable, ...(tag === 'a' && el.href ? { href: String(el.href).slice(0, 500) } : {}) };
}

/**
 * Runs in the page: the visible elements one can click or type into, numbered from 1,
 * kept in this world's `window` for the act script. Elements inside frames aren't listed.
 * @param {number} max
 * @param {typeof describeElement} describe
 */
function listInPage(max, describe) {
  const sel = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],[contenteditable=""],'
    + '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"]';
  /** @type {any[]} */
  const refs = [];
  const elements = [];
  let truncated = false;
  for (const el of /** @type {any} */ (document).querySelectorAll(sel)) {
    if (el.disabled || (el.tagName === 'INPUT' && el.type === 'hidden') || el.closest('[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || style.visibility === 'hidden') continue;
    if (elements.length >= max) { truncated = true; break; }
    refs.push(el);
    elements.push(Object.assign({ ref: refs.length }, describe(el)));
  }
  /** @type {any} */ (window).__houstonRefs = refs;
  return { elements, truncated };
}

/**
 * Runs in the page: finds element `ref` from the last list, checks it is still there,
 * still what the bar named and not covered by something else, scrolls it into view and,
 * for a fill, focuses it with its text selected. Returns its centre in CSS pixels.
 * @param {number} ref
 * @param {string} expected the element as listed, as JSON
 * @param {boolean} fill
 * @param {typeof describeElement} describe
 */
function prepareInPage(ref, expected, fill, describe) {
  const refs = /** @type {any} */ (window).__houstonRefs;
  const el = refs && refs[ref - 1];
  if (!el) return { error: 'The page has changed since tab_elements; call it again' };
  if (!el.isConnected || JSON.stringify(Object.assign({ ref }, describe(el))) !== expected) {
    return { error: `Element ${ref} is gone or changed since tab_elements; call it again` };
  }
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const top = /** @type {any} */ (document).elementFromPoint(x, y);
  if (!top || !(top === el || el.contains(top))) {
    return { error: `Something else (${top ? String(top.tagName).toLowerCase() : 'nothing'} at ${Math.round(x)},${Math.round(y)} of ${innerWidth}x${innerHeight}) covers element ${ref} on the page` };
  }
  if (fill) {
    el.focus();
    if (typeof el.select === 'function') el.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = /** @type {Selection} */ (getSelection());
      s.removeAllRanges();
      s.addRange(range);
    }
    const active = /** @type {any} */ (document).activeElement;
    if (active !== el && !el.contains(active)) return { error: `Element ${ref} would not take focus` };
  }
  return { x, y };
}

/** @param {number} max */
export const listScript = (max) => `(${listInPage})(${Number(max)}, ${describeElement})`;

/** @param {PageElement} el @param {boolean} fill */
export const prepareScript = (el, fill) => `(${prepareInPage})(${Number(el.ref)}, ${JSON.stringify(JSON.stringify(el))}, ${Boolean(fill)}, ${describeElement})`;

/**
 * The list the page script returned, checked: anything off-shape is dropped, so what the
 * bar shows comes from fields this file wrote. Key order matches describeElement's, which
 * prepareScript relies on.
 * @param {unknown} raw
 * @returns {{ elements: PageElement[], truncated: boolean }}
 */
export function cleanElements(raw) {
  const r = /** @type {any} */ (raw);
  const list = Array.isArray(r?.elements) ? r.elements : [];
  /** @type {PageElement[]} */
  const elements = [];
  for (const e of list.slice(0, ELEMENTS_MAX)) {
    if (!Number.isInteger(e?.ref) || e.ref < 1 || typeof e.tag !== 'string' || typeof e.type !== 'string'
      || typeof e.role !== 'string' || typeof e.label !== 'string' || typeof e.fillable !== 'boolean') continue;
    if (e.href !== undefined && typeof e.href !== 'string') continue;
    const clip = (/** @type {string} */ s, /** @type {number} */ n) => s.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').slice(0, n);
    elements.push({
      ref: e.ref, tag: clip(e.tag, 20), type: clip(e.type, 20), role: clip(e.role, 30), label: clip(e.label, 120), fillable: e.fillable,
      ...(e.href !== undefined && { href: clip(e.href, 500) }),
    });
  }
  return { elements, truncated: r?.truncated === true || list.length > ELEMENTS_MAX };
}

/**
 * An element as the confirm bar names it: `button "Sign in"`, `email field "Email"`,
 * `link "Docs" (https://example.com/docs)`.
 * @param {PageElement} el
 */
export function elementLine(el) {
  const kind = el.role
    || (el.tag === 'a' ? 'link'
      : el.tag === 'input' ? (['button', 'submit', 'reset', 'image'].includes(el.type) ? 'button' : el.type === 'checkbox' || el.type === 'radio' ? el.type : `${el.type} field`)
        : el.tag === 'textarea' ? 'text field'
          : el.tag === 'select' ? 'list'
            : el.tag);
  const label = el.label ? `"${el.label}"` : '(no label)';
  return `${kind} ${label}${el.href ? ` (${el.href})` : ''}`;
}

/**
 * The page's host for the bar, or the URL when it has none.
 * @param {string} url
 */
export function pageHost(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * tab_click's and tab_fill's element: a ref from the last tab_elements list.
 * @param {unknown} value
 */
export function refArg(value) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1) throw new Error('ref must be a whole number from tab_elements');
  return /** @type {number} */ (value);
}

/**
 * tab_fill's text, exactly as the bar will show it: one line, no control or invisible
 * characters. It replaces what the field held.
 * @param {unknown} value
 */
export function fillTextArg(value) {
  if (typeof value !== 'string' || !value || value.length > FILL_MAX) throw new Error(`text must be a non-empty string of at most ${FILL_MAX} characters`);
  if (HIDDEN_CHARS.test(value)) throw new Error('text must be one line with no control or invisible characters');
  return value;
}
