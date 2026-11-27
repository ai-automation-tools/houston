# Confirmed findings

## BUG-01 — Command palette omits five sidebar sections

- **Severity:** Medium; **type:** Bug Fix; **effort:** Quick Win.
- **Affected:** Ctrl+K command palette and sidebar navigation.
- **Precondition:** Houston running with the default sidebar sections.
- **Steps:** Open Ctrl+K. Inspect the `Show …` actions. Search `Show Agents`; repeat for News, Feed, Logs and Integrations.
- **Expected:** Each visible sidebar section has a matching navigation action, consistent with Files, Bookmarks, Recent, MCP, Cron, Git and Dev.
- **Actual:** The five sections have no action. `Show Agents` returns unrelated file results rather than an action.
- **Evidence:** Live accessibility tree showed all twelve sidebar tabs and only seven `Show …` palette actions. `src/renderer/app.js` builds those actions from a seven-name array near line 670. No screenshot is retained because the palette exposed private file paths.
- **Likely cause:** The static `ACTIONS` array did not grow when additional panels were added.
- **Fix:** Derive actions from the sidebar's panel registry or add the missing five names, then verify their `panel-*` handlers.
- **Regression test:** In the disposable-profile smoke run, enumerate visible sidebar tab identifiers and assert a matching palette action navigates to each one; include a query for `Show Agents`.

## ENV-01 — Installed Electron version differs from repo requirement

- **Severity:** Medium for reproducibility; **type:** Technical Debt; **effort:** Quick Win.
- **Affected:** Audit environment and local development installation.
- **Steps:** Open Health, read Electron version; compare `package.json`, `package-lock.json`, and `node_modules/electron/package.json` in the app's running repo.
- **Expected:** Installed runtime satisfies the manifest and matches the lockfile for reproducible verification.
- **Actual:** Health and `node_modules` report Electron 45.2.3, while both manifest and lockfile specify 45.4.1.
- **Evidence:** Live Health page and read-only file inspection. The window process path points into this repo; source revision equality at process launch cannot be proven from the window alone.
- **Likely cause:** Dependencies were not reinstalled after the manifest/lockfile update.
- **Fix:** Refresh dependencies in a controlled development step, restart the app, and rerun smoke; no dependency change was made in this audit.
- **Regression test:** Add a local preflight that compares the installed Electron package version with the lockfile before release checks.

No other behavior is labeled a confirmed bug. Empty News/Feed and unavailable Chat are configuration states, not observed defects.

The [right-click follow-up](CONTEXT-MENUS.md) records an intentional terminal copy/paste behavior with an observed accidental paste into PowerShell. It is prioritized as a UX safety improvement (U09), rather than mislabeled a code malfunction.
