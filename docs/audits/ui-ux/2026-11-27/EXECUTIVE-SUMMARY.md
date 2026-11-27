# Houston UI/UX audit — 2026-11-27

## Scope and method

Hands-on Windows Computer Use audit of the running Houston Electron window, with read-only source and Git review. Tested the primary sidebar panels, settings, connections, chat, workspace and terminal menus, browser navigation, search, command palette, and Health page. No app code, configuration, real records, or external systems were changed. This is a sampled interactive audit, not exhaustive control coverage.

## Assessment

Houston is a capable developer workbench with clear safety boundaries and unusually broad local tooling. The running UI loaded its main surfaces without a crash. Navigation density and incomplete command palette coverage are the main usability issues found. A follow-up right-click pass found strong Files menus, but gaps on tabs, bookmarks, Recent items and editable shell fields. Terminal right-click pasted clipboard text into PowerShell and evaluated a fragment without a preview; this is intentional in source but merits a safety improvement. Chat could not be exercised because its model key is not configured; Git, Dev, and agent sessions need a folder workspace or disposable profile for safe workflow tests.

| Area | Rating | Evidence |
|---|---:|---|
| Overall | 7/10 | Major sections opened; one confirmed navigation defect and dependency drift. |
| UI quality | 7/10 | Consistent dark styling, but icon-only navigation and dense lists reduce scanning. |
| UX quality | 6/10 | Palette omits five sidebar areas; context-menu coverage is uneven. |
| Functional reliability | 7/10 | Sampled navigation, search, browser, settings and Health worked. Core workflows remain untested. |
| Accessibility | Not Rated | Accessibility tree and keyboard palette worked; contrast, focus order and screen reader testing incomplete. |
| Performance | Not Rated | No timing or profiling baseline captured; Cron loaded a 500-task list. |

## Strengths

- Connections and Health give concrete status and recovery guidance; Health verified the Core, Hub, Cronsole, shell runtimes, MCP server and audit chain.
- Settings separates local preferences from read-only agent and security controls.
- Keyboard command palette, search, browser, terminal and sidebar are integrated in one window.
- Existing node:test and disposable-profile smoke infrastructure cover substantial logic and critical workflows.

## Top ten improvements

1. **P1 / UX safety:** Protect terminal right-click paste from accidental command execution (U09).
2. **P1 / Bug:** Add News, Feed, Agents, Logs and Integrations to command palette actions (BUG-01).
3. **P1 / Quality:** Align installed Electron with the manifest and lockfile before interpreting smoke or performance results (ENV-01).
4. **P2 / UX:** Add standard browser tab and editable-field context menus (U10–U11).
5. **P2 / UX:** Make sidebar labels visible by default or show a discoverable first-run choice.
6. **P2 / UX:** Add a compact task search/filter to Cron for the observed 500-task account.
7. **P2 / UI:** Make Integrations and Logs easier to scan with stronger grouping.
8. **P2 / UX:** Add a direct folder-workspace action in Git, Dev and Agents empty states.
9. **P2 / Quality:** Add palette and terminal right-click regression checks on a disposable profile.
10. **P3 / Accessibility:** Measure secondary-text contrast, focus, zoom and window-size behavior.

## Recommended order

Address terminal paste safety, fix BUG-01, resolve ENV-01, add regression checks, then improve tab/field context menus and sidebar discoverability. For a more complete release assessment, run the existing smoke suite on a disposable profile and repeat manual workflows there.

See [interactive results](INTERACTIVE-TEST-RESULTS.md), [right-click inventory](CONTEXT-MENUS.md), [bugs](BUG-REPORT.md), [improvements](UI-UX-IMPROVEMENTS.md), [features](FEATURE-ENHANCEMENTS.md), [roadmap](IMPLEMENTATION-ROADMAP.md), and [coverage](TEST-COVERAGE.md).
