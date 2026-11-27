# Proposed implementation roadmap

No application changes were made. Estimates assume this repository's plain-JavaScript renderer and existing smoke framework.

## Phase 1 — Critical fixes

There was no observed critical outage. Address the terminal right-click paste risk **U09** first: the live test sent clipboard text to PowerShell without a menu and a fragment was evaluated. Fix **BUG-01** next (P1, quick win): expose all sidebar panels in the command palette and add a smoke assertion. Resolve **ENV-01** by aligning installed Electron with the lockfile before using this machine's smoke results as release evidence.

## Phase 2 — Quick wins

Add browser-tab and shell-edit-field context menus (U10–U11). Add direct workspace guidance to Git, Dev and Agents empty states (U03). Link News and Feed empty states to setup documentation (U07). Decide whether named sidebar tabs should be the default (U01) after a short first-user check.

## Phase 3 — UI/UX modernization

Add Cron search/filter and result count (U02), then improve Integrations and Logs information grouping (U04–U05). Keep safety warnings and Stop All visible.

## Phase 4 — Feature enhancements

Consider saved panel filters (F01) and a unified section switcher (F02) after validating actual repeated-use friction. Avoid a second navigation system unless it outperforms the corrected command palette.

## Phase 5 — Quality and optimization

Run the existing disposable-profile smoke suite, then add measured contrast, zoom, keyboard and narrow-window checks. Record Cron list load/render time before optimizing. Include the Electron version preflight in release verification.

## Suggested regression scenarios

1. Ctrl+K offers and opens each of the twelve sidebar panels.
2. Search `Show Agents` ranks the panel action above file results.
3. Default workspace empty states lead to a folder workspace selection and return to the requested panel.
4. Cron search/filter works with a seeded 500-task fixture and announces count changes.
5. Existing smoke checks for browser, terminal, Core, MCP and safety confirmations continue to pass on a disposable profile.
6. Terminal right-click on a disposable shell with harmless clipboard content shows the intended action before text reaches the shell; copy-selection still works.
