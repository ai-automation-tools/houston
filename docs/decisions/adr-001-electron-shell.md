<h1 align="center">🧱 ADR-001: Electron Shell</h1>

<p align="center">
  <em>One Electron window, browser tabs as views, Chrome extensions through electron-chrome-extensions.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-accepted-2ea44f?style=for-the-badge" alt="Status: accepted">
  <img src="https://img.shields.io/badge/door-one--way--ish-F59E0B?style=for-the-badge" alt="One-way-ish door">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-decisions-6B7280?style=for-the-badge" alt="Back to decisions"></a>
</p>

---

**Date:** 2026-09-29 · **Options weighed:** [architecture-options.md](architecture-options.md)

## Decision

Build the app on **Electron** (44 when decided, 45 since 2026-10-27) as a single `BaseWindow`:

- The shell UI (sidebar, tab strip, address bar, terminal panel) is one `WebContentsView` loading local files over a private `acc://shell/` protocol.
- Each browser tab is its own `WebContentsView` in the `persist:browse` session, stacked over the shell's content area. The shell reports that rectangle to the main process whenever it changes.
- **electron-chrome-extensions 4.9** supplies the `chrome.*` APIs and the `<browser-action-list>` toolbar; **electron-chrome-web-store 0.13** makes the Web Store's install button work and keeps installed extensions updated.
- Plain JavaScript ES modules with JSDoc types, no bundler. The preload is CommonJS because it has to `require()` the browser-action helper.

## Why this is one-way-ish

The runtime is the costly thing to change. Moving off Electron later means rewriting the tab and extension layer; the sidebar, terminal renderer, Hub client and shared helpers would carry over. The licence is the other thing that sticks (below).

## Consequences

- **Upkeep.** Electron ships a major every 8 weeks and supports three, so the app has to take a new Electron at least every 24 weeks to keep security fixes. Budget one short session per major: bump, run `npm test`, `npm run smoke`, `npm run spike:extensions`.
- **Licence.** electron-chrome-extensions is dual-licensed GPL-3.0 or a paid patron licence, and the app passes `license: 'GPL-3.0'`. **Decided 2026-09-29: the repo is GPL-3.0-or-later** (`LICENSE`, `package.json`). Every other runtime dependency is MIT or BSD-3-Clause, both GPL-compatible. The cost: forks and anything distributed from this code stay GPL, and a closed-source build would need the patron licence.
- **`adm-zip` advisories (fixed 2026-10-18).** electron-chrome-web-store unpacks extensions with `adm-zip` and pins `^0.5.16`, which carried eight advisories (all `<= 0.6.0`). A `package.json` `overrides` entry pins `^0.6.1`, the first patched release; the package only calls `new AdmZip(buffer)` and `extractAllTo`, both unchanged. `npm audit` is clean and CI now fails on any new advisory. Drop the override once electron-chrome-web-store depends on 0.6.1 or later.
- **The shell's preload isn't sandboxed.** It needs `require()` for `<browser-action-list>`, which a sandboxed preload can't do. The shell loads only this repo's files, never a remote page, and navigation away from it is blocked. Browser tabs stay fully sandboxed with no preload from this app.

## Spike result, 2026-09-29

The prompt makes LastPass and Rakuten a hard gate, so Phase 1 opened with a spike: `npm run spike:extensions` installs both from the Web Store and loads a shop page.

| Check | Result |
|:---|:---|
| Install from the Web Store | ✅ Both install. LastPass 4.156.0 and Rakuten 26.18.2, both Manifest V3. |
| Toolbar buttons | ✅ Both icons show in `<browser-action-list>`. |
| Background service worker | ❌ Both crash on start: `Cannot read properties of undefined (reading 'onFocusChanged')`. LastPass then logs "Service worker registration failed". |
| Unknown permissions | ⚠️ Electron doesn't recognise `webNavigation`, `cookies`, `notifications`, `contextMenus`, `privacy`. |

**Why the workers crash.** Both background scripts read `chrome.windows.onFocusChanged` at start. electron-chrome-extensions adds `chrome.windows` through a preload it registers for service workers, and a probe showed that Electron runs session preloads in ordinary service workers but **not in extension service workers**. The library's own roadmap lists "Manifest V3 support — pending electron/electron#44411" for this reason.

**What that means today:** extensions whose MV3 background script uses `chrome.windows` or `chrome.tabs` events don't work. Content-script-only extensions may. LastPass and Rakuten don't.

**The workaround shipped in Phase 1:** the ↗ button in the address bar opens the current page in the default browser, so a login or a Rakuten-eligible shop is one click from Chrome.

**What reopens this ADR:**

- An Electron release that runs preloads in extension service workers, or a library release that drops the MV3 "pending" note. Rerun `npm run spike:extensions` on every Electron major.
- Mike opening Chrome for LastPass on most days during Phase 2. Then evaluate driving an external Chrome from the browser pane, or [option B](architecture-options.md).

## Update 2026-10-20: the `browser` namespace

The diagnosis above was wrong about the cause. Probing on Electron 44.7 with a throwaway profile showed:

- Electron **does** run session service-worker preloads in extension service workers (electron/electron#44411 merged in January 2025). The library's `crx-mv3-preload` runs, and `chrome.windows` exists before the background script starts. Sandboxing the shell made no difference.
- Chromium now gives extensions a native `browser` namespace that is a **separate object** from `chrome`, with only the APIs Chromium implements itself. electron-chrome-extensions fills in `chrome` only.
- LastPass (`zc()`) and Rakuten (`u()`) both use `browser` when it exists, so they read `browser.windows`, get `undefined`, and the worker dies.

**Fix:** `src/preload/extension-browser.cjs`, registered after the library's preloads for service workers and frames, sets `globalThis.browser = chrome` in extension contexts only. It changes the API surface the app provides, not the extensions, so the "don't patch extensions" rule stands. Nobody has reported this upstream yet, so it's worth an issue on electron-browser-shell, and the alias can go once the library fills in `browser` too.

**Spike after the fix** (fresh profile, both from the Web Store):

| Check | Result |
|:---|:---|
| Background service worker | ✅ Both start and call the shimmed APIs (`tabs.query`, `cookies.get`, `cookies.onChanged`, `action.setPopup`/`setBadgeText`). |
| Rakuten | ✅ No errors. `action.setIcon` with `imageData` isn't supported by the library yet, so its icon doesn't change state. |
| LastPass | ⚠️ Starts. One `document is not defined` later on: it uses `chrome.offscreen.createDocument`, which the library doesn't implement. Login and autofill need a hand check. |

**Ad blockers (checked 2026-10-20):** uBlock Origin Lite 2026.1018 installs and runs, but `pagead2.googlesyndication.com`, `securepubads.g.doubleclick.net` and `google-analytics.com` all still load from a tab. MV3 blockers filter through `declarativeNetRequest`, which Electron doesn't implement, so no MV3 ad blocker from the Web Store will block anything here. Blocking needs to happen in the app (`session.webRequest`), with the caveat in the library's README that Electron's `webRequest` hooks stop `chrome.webRequest` listeners from firing.

**Decided 2026-10-20 (Mike): built-in blocking with `@ghostery/adblocker-electron`** (MPL-2.0, GPL-compatible), on by default with a menu toggle, in `src/main/adblock.js`. It owns the browse session's `onBeforeRequest` and `onHeadersReceived`; Electron allows one listener per event, so nothing else in the app may register them. Checked with LastPass and Rakuten installed: both workers still start, and the three ad and analytics URLs above fail while ordinary requests load.

## Update 2026-10-27: the user agent

The `document is not defined` that LastPass's worker logs every 30 seconds isn't `chrome.offscreen`: without that API LastPass's `vq()` just returns `undefined`. It picks its platform from `navigator.userAgent.indexOf("Electron")`, and Electron's default user agent has `Electron/44…` in it, so the worker took LastPass's own desktop-app path (`Sk.ELECTRON`), which reads `document.cookie`. **Fix:** `app.userAgentFallback` is set to Chrome's user agent before anything starts (`chromeUserAgent()` in `src/shared/session.js`); a probe extension's service worker sees the plain one. It changes what the app reports, not the extension, so the "don't patch extensions" rule stands. Mike confirmed his vault loads (2026-10-27).

## Update 2026-10-27: Electron 45

Moved from 44.9.3 to **45.0.0** (Chromium 156, Node 24.22). `npm run spike:extensions` on a fresh profile: LastPass 4.156.0 and Rakuten 26.20.0 install from the Web Store, and both workers start and call the library's APIs (`tabs.query`, `cookies.get`, `action.setIcon`/`setTitle`/`setBadgeText`, `webNavigation` events). LastPass logs no `document is not defined`. One `Failed to start service worker` is logged right after Rakuten installs, after which its worker runs; Rakuten's `action.setIcon` with `imageData` is still unsupported, as before. The spike's 31 checks and `npm run smoke`'s 36 pass. Mike's own vault still needs a look in the real app.

Keep the profile path short when spiking with a scratch profile: past Windows' 260-character limit, IndexedDB fails to open, and LastPass reports "No available storage method found".

---

<p align="center">
  <a href="architecture-options.md">← Architecture options</a> ·
  <a href="adr-002-hub-over-http.md">Next: ADR-002 →</a>
</p>
