# Interactive test inventory

Status describes the specific observation, not the whole feature. All actions used Windows Computer Use against the already-running Houston window. No destructive controls were activated.

| ID | Page / feature | Control or workflow | Intended behavior | Observed behavior | Status | Evidence / improvement |
|---|---|---|---|---|---|---|
| I01 | Start | Initial page | Show operator overview | Advisories, approvals, overnight run and feed highlights rendered | Pass | Initial accessibility tree and screenshot; feed setup is explained |
| I02 | Files | Sidebar tab and tree expansion | Show Hub tree | Seven top-level groups rendered; Projects expanded to four child groups | Pass | UI tree and screenshot; file open/context actions not tested |
| I03 | Bookmarks | Sidebar tab and source | Show profile bookmarks | Brave source and bookmark tree rendered | Pass | UI tree; individual links not opened to avoid account sites |
| I04 | Recent | Sidebar tab | Show recent activity | Recent items rendered | Pass | UI tree; individual entries not opened |
| I05 | News | Sidebar tab | Show configured sources or empty state | Empty state with setup guidance and Refresh rendered | Pass | [screenshot](screenshots/news-empty-state.png); Refresh not activated |
| I06 | Feed | Sidebar tab | Show feed or empty state | Empty state and Start page / Refresh buttons rendered | Pass | UI tree; buttons not activated |
| I07 | MCP | Sidebar tab | Show MCP activity | Two connection events and search field rendered | Pass | UI tree; search not tested |
| I08 | Cron | Sidebar tab and Docs filter | Show scheduled tasks and narrow list | Task list loaded; Connections reports 500 tasks; Docs reduced list to four tasks and toggling again restored it | Pass | UI screenshot and tree; task run/history not activated |
| I09 | Git | Sidebar tab | Show workspace changes | Empty state explained that a folder workspace is required | Pass | UI tree; no folder workspace selected |
| I10 | Dev | Sidebar tab | Show workspace scripts/servers | Empty state explained that a folder workspace is required | Pass | UI tree; no server started |
| I11 | Agents | Sidebar tab | Show identities/sessions | Four identities and no-folder explanation rendered | Pass | UI tree; no session started |
| I12 | Logs | Sidebar tab | Show audit events/filters | Identity, Session and Decision filters plus newest events rendered | Pass | UI tree; filter behavior not tested |
| I13 | Integrations | Sidebar tab | Show gateway, secrets, grants and backends | Section groups and tool list rendered | Pass | UI tree; no pin/grant action performed |
| I14 | Settings | Open / close | Show preferences and control scope | General, Browser, Startup, Sources, security sections rendered; close returned to app | Pass | UI tree and screenshot; no preferences changed |
| I15 | Connections | Open / close | Show component health | Core, Hub, Cronsole, shells, chat, MCP shown; close returned to app | Pass | UI tree; rechecks not activated |
| I16 | Chat | Toggle pane | Open chat beside browser | Pane opened with new conversation, message, context and Send controls; missing-key guidance shown | Partial | Model not configured, so send workflow untested |
| I17 | Browser | New tab, address entry | Open new tab and navigate | Blank tab focused address; `https://example.com/` loaded in second tab | Pass | UI screenshots and URL in accessibility tree |
| I18 | Workspace | Switcher menu | Show available profiles/workspaces | Default profile/workspace and add-workspace guidance rendered; Esc closed menu | Pass | UI tree; switching to another workspace unavailable |
| I19 | Terminal | Shell choice menu | List installed shells | PowerShell 7, Windows PowerShell, Command Prompt, Git Bash rendered; Esc closed menu | Pass | UI tree; no shell launched |
| I20 | Global search | Enter `houston` | Search indexed items | File results appeared and could be scrolled; search cleared afterward | Pass | UI tree and screenshot; ranking and non-file sources not fully verified |
| I21 | Command palette | Ctrl+K / action search | Navigate to all sections | Palette opened, but lacked five visible sidebar sections; “Show Agents” produced file matches instead | Fail | BUG-01; [source](../../../../src/renderer/app.js) and reproduction in bug report |
| I22 | Health | Palette action | Open health diagnostics | Health page rendered version table and checks; Core, Hub, Cronsole, shells, MCP and audit chain healthy | Pass | UI tree; diagnostics bundle not saved |
| I23 | Browser history | Direct `acc://start/`, Back, Forward | Navigate and traverse history | Start loaded in Health tab; Back returned to Health; Forward returned to Start | Pass | Address value and page document in successive UI snapshots |

## Other discovered controls, not exercised

Browser Reload, tab close/reopen, bookmark toggle, extension buttons, external-browser button, Stop All; terminal New, input and close; Cron Open/Refresh and task run/history; Logs filters and event detail; Integration pin/grant actions; Settings saves and toggles; Chat Send/context/conversation actions; file tree context menus; individual bookmarks and Recent entries.

## Evidence notes

Two screenshots are saved: an empty News state and the public test page's link menu. Other captures contained personal project, browsing, local-path, or clipboard information and were not retained. Reproduction steps and accessibility observations support BUG-01 without adding sensitive data to a public repository. The [context-menu inventory](CONTEXT-MENUS.md) records the right-click follow-up.
