# Right-click context-menu follow-up

Performed 2026-11-27 with Windows Computer Use in the running Houston window. Each observation used an actual right-click. Menu items were inspected, not activated, except Ctrl+C to cancel terminal input after the terminal's right-click paste. The [web-link menu screenshot](screenshots/context-web-link.png) contains only the public test page and an empty Feed sidebar.

| ID | Surface right-clicked | Observed options / behavior | Assessment |
|---|---|---|---|
| C01 | Internal Start page background | Back, Forward, Reload, extension entries, disabled agent attachment, Inspect | Appropriate reduced menu for an internal page |
| C02 | Public web page background | Back, Forward, Reload, extension entries, agent attachment, Inspect | Basic navigation present; no Print, Save page, or View source option |
| C03 | Public web link | Open link in new tab, open in default browser, copy link address, then page actions | Core link actions present; see screenshot |
| C04 | Browser tab strip, on a tab | Tooltip only; no context menu | Gap: no contextual Reload, Copy address, Duplicate, Close others/right |
| C05 | Project Hub folder | View here, View in new tab, VS Code, Explorer, Terminal here, Open as workspace, Copy path, Copy Hub ID | Strong coverage; no change needed |
| C06 | Project Hub Markdown file | Preview here/new tab, Open raw file in new tab, VS Code, Explorer, Terminal in folder, Copy path/Hub ID | Strong coverage; no change needed |
| C07 | Imported bookmark item | No context menu | Gap: Open in new tab/default browser and Copy address would be useful; editing imported bookmark data may belong to its source browser |
| C08 | Recent page item | No context menu | Gap: Open in new tab/default browser and Copy address/path would be useful where applicable |
| C09 | Cron task row | No context menu; hover tooltip shows schedule/status | A task context menu is optional because task details open by click; consider Copy task ID and View history, preserving Run confirmation |
| C10 | Shell search field | No context menu | Gap: Cut, Copy, Paste, Select all expected for an editable field |
| C11 | Shell address bar | No context menu | Same editable-field gap |
| C12 | Terminal body | No menu. With no selection, right-click pasted clipboard text into PowerShell. A pasted fragment was evaluated and produced an error; Ctrl+C returned to a prompt. | Intentional behavior in `src/renderer/terminal.js`, but high-impact surprise and command-execution risk |

## Recommendations

1. **P1 — Terminal paste safety (U09).** For a right-click with no selection, present a Paste action or preview/confirmation before sending clipboard text to a live shell. A visible “Right-click: paste” hint alone would improve predictability but would not address accidental execution. Do not change the Core's managed-run confirmation path.
2. **P2 — Browser tab menu (U10).** Add Reload, Duplicate, Copy address, Close, Close other tabs, and Close tabs to the right where applicable. Keep close/reopen behavior consistent with existing shortcuts.
3. **P2 — Editable shell fields (U11).** Provide Cut, Copy, Paste, and Select all on address and search fields. Do not expose sensitive history in menu labels.
4. **P3 — Bookmark and Recent menus (U12).** Add non-destructive open/copy actions appropriate to each item type. Keep imported bookmark editing with the source browser unless Houston owns the record.
5. **P3 — Web page menu (U13).** Consider Print, Save page, and View source for `http(s)` pages after confirming the intended browser scope. Keep internal `acc://` pages restricted and script-free.

## Source correlation and limits

- `src/renderer/sidebar.js` wires a menu only for Files rows; `src/shared/tree.js` defines their actions.
- `src/main/tabs.js` constructs the browser page/link menu. Its editable-field roles apply to web page inputs, not the Houston shell's search or address fields.
- `src/renderer/terminal.js` explicitly implements right-click as copy-selection-or-paste, with clipboard text sent to the terminal process. The live paste outcome above confirms the behavior.
- No menu action that starts tasks, agents, terminals, external apps or a browser page was selected. Menus for selected page text, image elements, editable web forms, terminal tab labels, and all file types were not exhaustively tested.
