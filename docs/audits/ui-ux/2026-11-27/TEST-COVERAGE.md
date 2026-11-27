# Test coverage and limitations

## Actual interactive coverage

| Measure | Result | Basis |
|---|---:|---|
| Primary sidebar panels discovered | 12 | Files, Bookmarks, Recent, News, Feed, MCP, Cron, Git, Dev, Agents, Logs, Integrations |
| Primary sidebar panels opened | 12 | Computer Use clicks and post-action UI state |
| Additional major surfaces opened | 7 | Start, Settings, Connections, Chat, workspace switcher, command palette, Health |
| Browser workflows opened | 2 | New tab to example.com; direct internal route with Back/Forward |
| Inventory observations | 23 | Rows I01–I23 in interactive results |
| Context-menu probes | 12 | Rows C01–C12 in right-click inventory; separate from the 23 observations |
| Passed observations | 21 | Only the stated action/state in each row |
| Failed observations | 1 | I21 / BUG-01 |
| Partial observations | 1 | I16 / Chat configuration gate |
| Confirmed product bugs | 1 | BUG-01 |
| Confirmed environment discrepancies | 1 | ENV-01 |
| Individual controls discovered/tested | Not fully enumerated | Large dynamic lists and context menus were not exhaustively inventoried; no false exact total is asserted |

## Environment

- **Platform:** Windows 11 desktop, Houston Electron window at approximately 1488 × 944 logical pixels.
- **App process:** Electron executable inside the supplied Houston repo. No HTTP URL hosts the shell; internal pages use `acc://`.
- **Repository:** `main`, clean before report creation, `origin` at the Houston GitHub repository. Open issues and PR lists were empty at audit time.
- **Method:** Windows Computer Use (`@oai/sky`) accessibility snapshots and screenshots, with read-only PowerShell/Git/source inspection. One screenshot is retained in `screenshots/`.
- **Installed version drift:** Electron 45.2.3 in the running Health page and `node_modules`; manifest and lockfile specify 45.4.1.

## Not tested

- No alternate desktop sizes, tablet/mobile viewport, real mobile device, other browser engine or light theme. Houston is documented as a Windows desktop app; responsive requirements should be evaluated as minimum-window and zoom behavior.
- No full keyboard tab order, screen reader, color contrast measurement, reduced-motion check, automated accessibility scan, console/network trace, Lighthouse equivalent, or performance timing.
- No settings save, chat message, agent session, standing grant, task run, managed terminal command, dev server start/stop, secret action, file edit/delete, external account login, or Git mutation. Some were intentionally excluded by the audit's safety restriction; others require a disposable workspace/profile.
- No selected-page-text, image, editable-web-form, terminal-tab-label or every-file-type context menu; no individual bookmark/Recent link activation, every Cron task, every log event, every integration tool, browser reload, or persistence across restart.
- Existing unit and smoke suites were reviewed but not run. The audit did not change application code, and the live installation has dependency drift.

## Next verification environment

Use the repo's existing disposable-profile `npm run smoke -- --live` workflow after Electron is aligned, then a throwaway Hub workspace and Core profile for CRUD-like workflows. Record timings and keep personal data out of captured artifacts.
