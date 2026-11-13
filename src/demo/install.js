// Demo entry point, loaded before app.js: puts the fake window.acc in place and shows a
// stand-in where the app would draw a browser tab. No network, no storage.

import { demoApi } from './acc.js';
import { ABOUT_HTML, WELCOME_URL } from './about.js';

const content = /** @type {HTMLElement} */ (document.getElementById('content'));
const page = document.createElement('div');
page.id = 'demo-page';
page.hidden = true;
page.innerHTML = '<h2></h2><p class="url"></p><p>In the app, this tab is a sandboxed Chromium view with Chrome extension support. The demo has no browser behind it, so the tab strip, the address bar and Recent work, and the page stays this note.</p>';
// The welcome tab the demo opens first (and the sidebar's ai-command-center/README.md).
const about = document.createElement('div');
about.id = 'demo-about';
about.hidden = true;
about.innerHTML = ABOUT_HTML;
// The app's own pages the demo can draw: Settings, the Identity Center and a session's transcript (harness.js).
const appPage = document.createElement('div');
appPage.id = 'demo-app-page';
appPage.hidden = true;
content.append(page, about, appPage);

/** @param {string} text */
function notify(text) {
  const t = document.createElement('div');
  t.className = 'demo-toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

const acc = demoApi({
  notify,
  askAfterMs: 6000,
  approvalAfterMs: 15000,
  onTab(tab) {
    const welcome = tab?.url === WELCOME_URL;
    // Built from escaped text by src/shared/scopes.js and logs.js, the same as the app's pages.
    const html = tab && !welcome ? acc.demoPage(tab.url) : null;
    about.hidden = !welcome;
    appPage.hidden = html === null;
    if (html !== null) appPage.innerHTML = `<article class="demo-doc">${html}</article>`;
    page.hidden = !tab || welcome || html !== null;
    if (!tab || welcome || html !== null) return;
    /** @type {HTMLElement} */ (page.querySelector('h2')).textContent = tab.title;
    /** @type {HTMLElement} */ (page.querySelector('.url')).textContent = tab.url;
  },
});

// The app's Ctrl+K and Ctrl+Shift+L come from its native menu; the demo has none, so catch the keys here.
/** @type {((action: string) => void)[]} */
const shortcuts = [];
const onShortcut = acc.onShortcut;
acc.onShortcut = (/** @type {(action: string) => void} */ fn) => { shortcuts.push(fn); return onShortcut(fn); };
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const action = e.ctrlKey && !e.altKey && (!e.shiftKey && key === 'k' ? 'palette' : e.shiftKey && key === 'l' ? 'toggle-chat' : '');
  if (!action) return;
  e.preventDefault();
  for (const fn of shortcuts) fn(action);
});
/** @type {any} */ (window).acc = acc;
