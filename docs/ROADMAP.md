<h1 align="center">🗺️ Roadmap</h1>

<p align="center">
  <em>From the public release on 2026-10-18 to a project-centered shell, editing in the window, and agent work you can check.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/now-Milestone_C-F59E0B?style=for-the-badge" alt="Now: Milestone C">
  <img src="https://img.shields.io/badge/stage-public_since_2026--10--18-2ea44f?style=for-the-badge" alt="Stage: public since 2026-10-18">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-docs_home-6B7280?style=for-the-badge" alt="Back to docs"></a>
</p>

---

Ordered by what blocks what; [build-plan.md](product/build-plan.md) has the reasoning. A roadmap routine (`\AI-Automation-Tools-Org\Update-Existing-Projects\Roadmaps\AI-Command-Center Weekly Roadmap`, Sunday and Wednesday 20:00) takes the first open item each run and opens a `roadmap/auto-<date>` PR, which the org PR sweep reviews and merges. **Every item above `## After public release` was a release gate;** all of them closed on 2026-10-18 and the repo went public. Ticking an item adds its line to the [changelog](CHANGELOG.md) and updates any doc it made stale, in the same commit.

Markers: `- [ ]` open, `- [-]` claimed by a run in progress, `- [x]` done, `- [!]` blocked (the reason follows on the line). `🔒 Needs Mike` marks an item only Mike can do; the routine skips it.

> [!NOTE]
> **Where we are, 2026-10-27.** Public since 2026-10-18. A project audit on 2026-10-20 added Milestones A to D: A (a trustworthy foundation) and B (a project-centered shell: workspaces, the command palette, the context tray, connections, named conversations, the chat pane) are done. Milestone C has started: the Git changes view (read-only) and dev servers are in. **Next:** its editor ADR is Mike's call and the side-by-side editor waits on it, and the Integrations are all done. Milestone D is under way: managed runs, the activity list, MCP clients by name and browser actions on an attached tab are in; the per-client tool switch was dropped, provider adapters wait on an open question, and run history is in (2026-10-27). LastPass works since 2026-10-27.

## 🧭 Phase 0: decide (done 2026-09-29)

- [x] Requirements ranked must / should / later, with reasons ([requirements.md](decisions/requirements.md)) — 2026-09-29
- [x] Three candidate architectures compared ([architecture-options.md](decisions/architecture-options.md)) — 2026-09-29
- [x] Runtime, Hub integration and terminal recorded as ADR-001 to ADR-003 — 2026-09-29

## 🔨 Phase 1: one window (done 2026-09-30)

- [x] One Electron window: sidebar, tab strip, address bar, terminal panel, splitters that remember their size — 2026-09-29
- [x] Browser tabs with back, forward, reload, links as tabs, context menu, open in default browser — 2026-09-29
- [x] Chrome Web Store installs inside a tab; installed extensions load at start with toolbar icons — 2026-09-29
- [x] PowerShell 7 terminals in tabs, openable in any sidebar folder — 2026-09-29
- [x] Files panel from Project Hub, with VS Code, Explorer and open-in-tab actions — 2026-09-29
- [x] Bookmarks panel (Chrome, Edge or Brave via Hub, or Hub favorites) — 2026-09-29
- [x] Recent list and one search box across files, bookmarks and recent — 2026-09-29
- [x] `npm test`, `npm run smoke`, `npm run spike:extensions` — 2026-09-29
- [x] `npm run lint` (`node --check` over every JS file) and `CLAUDE.md` for the weekly routine — 2026-09-29
- [x] Tabs that were open reopen after a restart (store the URLs in `layout.json`; unit-test the list handling in `src/shared/`) — 2026-09-30, checked by hand the same day
- [x] `Start-AICommandCenter.ps1` in `scripts/` that starts the app hidden-window-free, so launching doesn't need a terminal — 2026-09-30, checked by hand the same day

## 🤖 Phase 2: harness (done 2026-10-04)

- [x] Control Center MCP server started by the main process on `127.0.0.1`, random port and per-launch token written to `%APPDATA%\ai-command-center\mcp.json`; refuses calls without the token — 2026-09-30, live server checked by hand (401 without the token, `ping` answered with it)
- [x] Read-only tools first: `list_tabs`, `sidebar_search`, `recent` — 2026-09-30, weekly roadmap run; unit-tested and called against the live app by `npm run smoke`
- [x] Navigation tools: `open_tab`, `open_file` (through Hub's `/api/open`) — 2026-09-30, weekly roadmap run; unit-tested, and `npm run smoke` calls `open_tab` against the live app
- [x] `terminal_run`: shows the command in the app and waits for a click before running it — 2026-10-04; unit-tested, and `npm run smoke` calls it and clicks Run
- [x] Every MCP call written to an in-app log panel and to `%APPDATA%\ai-command-center\logs\mcp.log` — 2026-10-04; the sidebar's MCP tab and a JSON-lines file, refused calls included; unit-tested, and `npm run smoke` compares the panel with the file
- [x] README section with the `claude mcp add` line, so Claude Code in the app's terminal can drive the app — 2026-10-04; the app's terminals carry `ACC_MCP_URL` and `ACC_MCP_TOKEN` and the line stores the variable names, so it survives restarts; checked by connecting `claude` to the running app with the README's command
- [x] Chat panel wired to the MCP server (Claude first; model and key read from the user environment, never stored in the repo) — 2026-10-04, weekly roadmap run; a Chat tab in the sidebar, tools through the MCP server over HTTP with its token. Unit-tested against a real MCP server with a scripted model, and `npm run smoke` opens the tab; not yet run against the live API, which needs Mike's key
- [x] Cronsole: its task list in the sidebar through the Cronsole MCP server, and its UI in a pinned tab — 2026-10-04, weekly roadmap run; a Cron tab that starts Cronsole's stdio MCP server from `ACC_CRONSOLE_MCP` and lists `list_tasks`, and an Open Cronsole button that keeps one pinned tab. Unit-tested against a fake stdio server; `npm run smoke` listed 452 tasks from the live Cronsole and checked the pinned tab

## 🧰 Daily use (done 2026-10-04)

Found using the app on 2026-10-04 and made release gates the same day.

- [x] Right-click menu on Files rows: the hover actions (Terminal here, VS Code, Reveal in Explorer, open in tab) plus copy path and copy Hub id — 2026-10-04; native menu, items unit-tested
- [x] Open a folder or file in the content area under the app's own sidebar, not Project Hub's whole page: Hub renders the file (`/api/file`), the app shows it as a script-free `acc://doc` page in a tab, folders as a listing — 2026-10-04; `npm run smoke` clicks a Markdown file and checks the page (no second sidebar, images load)
- [x] New-terminal button with a menu of shells: PowerShell 7, Windows PowerShell, Command Prompt, and Git Bash when installed. Each is a fixed profile in `src/shared/shells.js`; the renderer sends a profile id, never a path or arguments — 2026-10-04; unit-tested, `npm run smoke` starts a Command Prompt session

## 🚦 Public release (done 2026-10-18)

- [x] CI workflow (`.github/workflows/ci.yml`) running `npm run lint` and `npm test` on push and PR, and passing; `npm audit` as a non-blocking step that reports the known `adm-zip` advisories until they're fixed — 2026-10-05; Ubuntu and Windows, Node 24, no Electron download; passing is confirmed on the first push
- [x] Nothing personal in tracked files: Project Hub URL and the empty-state quick links move to a settings file with neutral defaults; no absolute local paths anywhere — 2026-10-05; `%APPDATA%\ai-command-center\settings.json` read by `src/shared/settings.js` (3 tests), `ACC_HUB_URL` still wins, the Hub-down note points at the Project Hub repo, and the test hosts are `example.com`
- [x] README usage section rewritten for someone who isn't Mike, and verified against the real code — 2026-10-05; prerequisites and a clone-to-run quick start, what works without Hub, where the app's files live, a Contributing section in place of Mike's branch, and every claim checked against `src/`
- [x] `SECURITY.md`, plus a full-history secret scan (gitleaks) that comes back clean — 2026-10-05; 17 commits, no leaks; `npm run scan:secrets` keeps the command
- [x] Page permissions denied by default: the browse session gets a `setPermissionRequestHandler` that refuses camera, microphone, location, notifications, MIDI, USB, serial, HID and the rest, and allows only fullscreen, pointer lock and clipboard writes. Without a handler Electron grants everything a page asks for. Found in the 2026-10-05 review — 2026-10-05; request, check and device handlers, allowlist in `src/shared/permissions.js` with a test
- [x] Crash and error log: `uncaughtException`, `unhandledRejection`, a renderer or tab process going away, and `[startup] failed` appended to `%APPDATA%\ai-command-center\logs\app.log`, so a stranger's bug report has something to paste. Moved up from Distribution in the 2026-10-05 review — 2026-10-05; `src/main/applog.js`, which `mcp.log` now shares
- [x] Browser shortcuts a daily browser can't do without: Ctrl+Tab and Ctrl+Shift+Tab cycle tabs, Ctrl+1 to Ctrl+8 pick a tab and Ctrl+9 the last, Ctrl+Shift+T reopens the last closed tab, Ctrl+plus, Ctrl+minus and Ctrl+0 zoom the page. All in the app menu except where PowerShell needs the key. Found in the 2026-10-05 review — 2026-10-05; cycling and picking follow the strip's order in `src/shared/session.js` (2 tests), the last 10 closed tabs are kept
- [x] Find in page: Ctrl+F opens a find bar over the content area (`webContents.findInPage`), Enter and Shift+Enter step through matches, Escape closes it. Found in the 2026-10-05 review — 2026-10-05; the bar sits in the address row with a match count, closes when the tab changes; `npm run smoke` types a word and reads the count
- [x] Clear the `adm-zip` advisories: it is a transitive dependency (the `electron-chrome-*` packages pin `^0.5.16`, lock has 0.5.18; first patched release 0.6.1, per the 8 open Dependabot alerts, 5 high). Add a `package.json` `overrides` entry for `adm-zip` at the patched version, regenerate the lockfile, confirm `npm run smoke` still loads an extension, and drop the `npm audit` carve-out from CI once it reports clean. Queued 2026-10-14 by the org automation audit — 2026-10-18; override `^0.6.1`, `npm audit` clean, CI audit now blocking, `npm run smoke` passed with both extensions loaded
- [x] 🔒 Live demo on GitHub Pages at `https://ai-automation-tools.dev/ai-command-center/`, served from this repo: the shell UI running in a browser with a mocked `window.acc` and fabricated files, bookmarks and terminal output; carries the org source bar; makes no network calls that need secrets. The renderer's absolute `/sidebar.js` and `/vendor/…` imports have to become relative first, so the same files serve under `acc://shell/` and under a Pages subpath — **Held by Mike 2026-10-12: built, not deployed.** No Pages workflow and Pages stays off until Mike has validated the whole roadmap and says to go public; the routine must not add the workflow or enable Pages. Built 2026-10-07, roadmap run: `src/demo/` and `npm run demo` (builds `_site/`). 8 tests; checked by hand in a browser (sidebar, tabs, terminal `npm test`, confirm bar, chat, Cron) and `npm run smoke` passed with the relative paths. Hold lifted by Mike 2026-10-18: deployed by `.github/workflows/pages.yml` on every push to `main`
- [x] Licence: GPL-3.0-or-later, chosen by Mike because electron-chrome-extensions is GPL-3.0; `LICENSE` added and `package.json` updated — 2026-09-29

## After public release

Nothing below blocks go-live.

### Extensions

- [x] LastPass working in a tab. Its worker starts since the `browser` alias (2026-10-20, [ADR-001](decisions/adr-001-electron-shell.md#update-2026-10-20-the-browser-namespace)). The vault that kept spinning was LastPass reading `Electron` in the user agent and running its desktop-app code in the worker, which died on `document.cookie`; the app now sends Chrome's user agent ([ADR-001](decisions/adr-001-electron-shell.md#update-2026-10-27-the-user-agent)), and Mike's vault loads. Rakuten works, including Google sign-in, since pop-ups keep `window.opener` (2026-10-20). Rerun `npm run spike:extensions` on every Electron major — 2026-10-27

### Upstream changes

Queued by the upstream check (2026-10-22). Each is bigger than a fix.

- [x] Add MCP revision `2026-07-28` to the app's MCP server. What: `src/shared/mcp.js` and `src/main/mcp.js` speak the handshake-based revisions (`2025-11-25` and earlier); the current revision drops `initialize` in favour of a per-request `io.modelcontextprotocol/protocolVersion` in `_meta` (and the `MCP-Protocol-Version` header), a mandatory `server/discover` RPC, and an `UnsupportedProtocolVersionError` that lists supported versions. Why: it is now the **Current** revision (<https://modelcontextprotocol.io/specification/versioning>, read 2026-10-22); clients will start sending it, and the spec says servers may keep supporting older revisions side by side. Where: `PROTOCOL_VERSIONS`, the `initialize`/`tools/list`/`tools/call` handlers, `tests/`. Done when: a request carrying the new `_meta` key and `server/discover` both work, `initialize` still answers the old revisions, tests pin both shapes, and the token check is unchanged. Read the `2026-07-28` spec pages first; don't add the version to `PROTOCOL_VERSIONS` until the behaviour is there — done 2026-10-23, roadmap run: dual-era server. `checkRequest` picks the era (per-request `_meta`, a modern header, or `server/discover`) and checks a modern request's `clientCapabilities` and mirrored headers (400 with `-32602`, `-32020` or `-32022`, which lists `MODERN_VERSIONS` and `LEGACY_VERSIONS`); modern results carry `resultType` and `serverInfo` in `_meta`, an unknown modern method gets 404, `initialize` answers only the legacy versions, and the token check runs first, unchanged. The stdio bridge mirrors `_meta` into the headers (`mirrorHeaders`). Claude Code 2.1.307's probe (modern header, no `_meta`) still falls back to `initialize` and logs as a handshake row. 4 new tests plus modern requests in the bridge's test. Not done: `subscriptions/listen`, SSE responses and MRTR, which no tool here needs
- [ ] Move to Electron 45. What: bump `electron` from `^44.8.0` to `^45`, rerun `npm run spike:extensions` and `npm run smoke`, record the result in [ADR-001](decisions/adr-001-electron-shell.md). Why: 45.0.0 was released 2026-10-21 (<https://github.com/electron/electron/releases>); Electron supports the latest three majors (<https://www.electronjs.org/docs/latest/tutorial/electron-timelines>), so 44 is not urgent. Where: `package.json`, `docs/UPSTREAMS.md`, ADR-001. Done when: the spike and smoke runs pass and the ADR has the result. Needs a dependency install by hand 🔒 Needs Mike
- [ ] Send Anthropic `anthropic-version: 2026-10-21` from the chat panel. What: change the header in `src/shared/chat.js` and confirm the request body stays valid. Why: the new version removes `temperature`, `top_p` and `top_k` and rejects `document` blocks in assistant messages and `citations` on user text blocks (<https://platform.claude.com/docs/en/api/versioning>, <https://platform.claude.com/docs/en/api/migration-2026-10-21>); the app sends none of these today and `2023-06-01` still works, so this is housekeeping. Where: `src/shared/chat.js`, `tests/`. Done when: a test pins the header and the streaming parser still passes. Can't be checked against the live API without a key 🔒 Needs Mike

### 🔒 Mike's own checks

They decide whether to keep going, per [build-plan.md](product/build-plan.md#when-wed-stop).

- [ ] Use the app as the main window for 5 working days and fill in the log below 🔒 Needs Mike
- [ ] Terminal checked by hand: typing, resize, colors, copy/paste (keys and right-click), and `claude` running in it 🔒 Needs Mike
- [ ] Ad blocking checked by hand on a few ad-heavy sites, and no site you use daily broken by it 🔒 Needs Mike
- [ ] Milestone B and the 2026-10-21 work checked by hand in the real app: open a folder as a workspace, switch away and back (tabs, terminals and conversations follow), Ctrl+K over a page, a file and a terminal, the chat pane beside Files (resize, hide, Ctrl+Shift+L), two named conversations (search, rename, delete), Connections from the status dot, the Git tab on a real repo with a diff open, the Dev tab starting, restarting and stopping a real repo's dev server, the Cron tab's failed-task count, the MCP tab naming Claude Code when it connects and its Agent work rows, and a `terminal_run` from Claude Code that succeeds, one that fails, and one cancelled by closing its tab (`run_status` for each) 🔒 Needs Mike
- [ ] Chat checked against the live API with a real key: a streamed reply, + page, a `terminal_run` the chat asks for, and Stop mid-answer 🔒 Needs Mike

| Day | Used as main window? | What broke or got in the way |
|:---|:--:|:---|
| | | |

### 🛡️ Milestone A: a trustworthy foundation (done 2026-10-20)

From a project audit on 2026-10-20 (the report stays outside the repo). These come before anything that gives agents more authority. Each item lands with tests for its failure cases.

- [x] `terminal_run` runs exactly what was approved, where it said it would: the main process picks the target when the ask is made, not the renderer at click time, and by default runs the command in a fresh PowerShell terminal it opens (known folder, no half-typed input, no `claude` already running in it). A target that has gone away by the time of the click refuses rather than retargets. The click-to-run rule stays; ADR-003 records the change — 2026-10-20; optional `cwd` (drive paths only, no UNC), `isFreshRunTarget` in `src/shared/confirm.js` (1 test), `cwdArg` (2 tests), checked live on a throwaway profile
- [x] Agent `open_tab` opens http(s) only, and a web page can't navigate a tab or a pop-up to a `file:` URL. Local files reach an agent only through Hub's index (`open_file`, `acc://doc`); a person typing a `file:` path in the address bar still works — 2026-10-20; `tabUrlArg` and `isAllowedNavigation` (a `file:` URL only from the app or another `file:` page; a page with no URL yet counts as a page), 2 tests; checked live: a web page can't send its tab or a blank pop-up to `file:`, a typed path still opens
- [x] One child-environment builder for terminals and Cronsole that strips the app's own credentials (`ANTHROPIC_API_KEY`, `ACC_CHAT_API_KEY`) even when they come from the real environment, keeps what Windows needs and adds the MCP address and token. Tested with fake values — 2026-10-20; `childEnv` in `src/main/env.js` (any casing), 1 test; checked live: a terminal printed an empty `$env:ANTHROPIC_API_KEY` with a fake key set in the real environment
- [x] MCP request hardening: a non-object `params` or `arguments` gets `-32602`, every error at the HTTP boundary becomes a JSON-RPC error instead of an unhandled rejection, and the next request still works — 2026-10-20; also a non-string/number `id` (`-32600`) and a non-string tool name, which could crash the error message (`{"toString":1}`); 2 tests
- [x] MCP conformance: `structuredContent` is always an object (or left out), requests with an `Origin` header that isn't loopback are refused, and a test drives the server the way a strict client would — 2026-10-20; also an unsupported `MCP-Protocol-Version` header gets 400; 4 tests, one a full initialize → initialized → tools/list → tools/call session checking every reply's shape
- [x] Chat Stop: a Stop button that aborts the model request and any MCP call in flight, withdraws a pending confirm, and leaves the panel ready for the next message; plus a deadline on each request. Stopping says so; it never claims to undo a command that already ran — 2026-10-20; one signal per turn through `runTurn`, `messagesApi` and `mcpClient` (deadlines 5 and 6 minutes); the MCP server aborts a call whose client disconnects, which withdraws its confirm bar for any client, Claude Code included; open `tool_use`s get a "stopped" result. 5 tests; checked live that a disconnecting client's Run bar disappears. Not yet pressed against the live API, which needs Mike's key
- [x] Less sensitive data at rest: `mcp.log` keeps `terminal_run`'s command and page text out (metadata and length only), strips URL query strings, and the chat's Clear deletes `chat.json` — 2026-10-20; page text was never logged; the in-memory MCP panel still shows the command, the file gets `[N chars]` (`argsAtRest`); `stripQueries` covers args and errors in both. 2 tests with sentinel values
- [x] `npm run smoke` that fails when a check fails: a throwaway profile by default (`--profile` for the real one), each check an assertion, a JSON summary in `.smoke/`, a nonzero exit on any failure or on a no-op second-instance launch. Live Hub and Cronsole checks stay, opt-in — 2026-10-20; `ACC_USER_DATA` picks the profile before the single-instance lock; 22 named checks, 7 of them `--live`; screenshots warn instead of failing; checked: 21 pass and 1 skip by default, 22 pass with `--live`, and exit 1 with a broken `ACC_CRONSOLE_MCP`
- [x] Small fixes: CI's `npm audit` covers Electron (it's a devDependency but ships as the runtime); IPC also checks the sender is the shell's main frame; favorite toggles run one at a time; Hub request timers are cleared; `settings.json`'s `hubUrl` is loopback-only unless `ACC_HUB_REMOTE=1`; README status and Electron badge brought up to date — 2026-10-20; `hubFetch` reads the body inside its deadline and clears the timer; 1 test for the Hub address rule; `npm run smoke -- --live` 22/22 with the frame check on. The duplicate `overrides` key from the audit was already gone (PR #37)

### 🧭 Milestone B: a project-centered shell (done 2026-10-21)

Selecting a project should set the folder, terminals, tabs and conversation together, rather than adding more sidebar panels.

- [x] Named workspaces: a workspace is a Hub root plus its open tabs, terminal folders and conversation, saved in `workspaces.json` with a schema version. Switching restores them and never re-runs a command — 2026-10-20; Files → right-click a folder → Open as workspace, switched from the name at the top of the sidebar. Tabs close and reopen; terminals stay alive, hidden, and saved folders open as fresh shells. One conversation per workspace (Default keeps `chat.json`). `src/shared/workspaces.js`, 10 tests; `npm run smoke` does a round trip
- [x] Command palette (Ctrl+K): actions, workspaces, files, tabs and terminals from one box — 2026-10-20; a native `<dialog>` over the shell, the browser tab hidden while it shows; open tabs, terminals and workspaces list first, then 21 actions, and Files matches once something is typed (the workspace's tree). `rankPalette` in `src/shared/palette.js`, 4 tests; `npm run smoke` opens it, filters and runs a pick. Bookmarks and Recent aren't in it yet; the sidebar search covers them
- [x] Context tray: before a message goes, show exactly what's attached (page text, terminal lines) and where it's going, with a remove ✕ on each — done 2026-10-21: + page and + terminal read into a tray above the box (label, source, size, "Show what's sent" with the exact text, ✕), a line naming the model and `api.anthropic.com`, and the message sends those snapshots without reading again. `trayItem` in `src/shared/chat.js`, 2 tests; `npm run smoke` adds a tray check (25 checks); checked in the browser demo
- [x] Connections view: Hub, Cronsole, each shell, the chat model and the MCP server, each with its state, a Retry and what to set when it's missing — done 2026-10-21: a dialog from the sidebar's status dot, the palette and the View menu; each group is checked on its own (Cronsole lists its tasks; the chat row never calls the API), a shell installed since start appears on Retry. `src/shared/connections.js`, 5 tests; `npm run smoke` opens it and retries a row (26 checks); checked in the browser demo
- [x] Several conversations per workspace: named, listed and searchable (today each workspace has exactly one) — done 2026-10-21: the open conversation's name tops the Chat tab and opens the list (search over names and text with a snippet, open, rename, two-click delete); **New** replaces Clear. `chats/<ws>/` holds `index.json` and one file each; an old `chat.json` moves in. `src/shared/conversations.js`, 5 tests; `npm run smoke` seeds an old `chat.json` and runs the whole cycle (27 checks); checked in the browser demo
- [x] Chat in a resizable right-hand pane, so it stays open beside Files — done 2026-10-21: the Chat tab left the sidebar for a full-height pane on the right with its own splitter (260 to 800 px, keeping 320 px for the browser); 💬 in the address bar, Ctrl+Shift+L, the palette and × show and hide it; width and open state in `layout.json`. `npm run smoke` opens it and checks the browser area narrows by its width with Files still showing (28 checks)

### 🧑‍💻 Milestone C: editing in the window

Replaces Phase 3's IDE line.

- [ ] Editor ADR and spike: code-server publishes no Windows build, so test OpenVSCode Server and code-server under WSL2 against an existing Windows repo (paths, file watching, Git identity, extensions, terminal ownership, speed). It runs in its own session, not the browse session, on an authenticated loopback port, which changes the spec's one-port rule. VS Code handoff stays as the fallback. Mike picks the backend 🔒 Needs Mike
- [!] Editor and browser preview side by side, from the ADR's choice — blocked: waits for the editor ADR above
- [x] Git changes: branch, status and diff for the workspace's repo, read-only first — done 2026-10-21: a Git tab (branch, upstream, ahead/behind, files grouped as conflicts, staged, changes and untracked) and `acc://git` diff pages, served like run pages; git runs through `execFile` with fixed command lines and fsmonitor, external diff and textconv off. `src/shared/git.js` and `src/main/git.js`, 5 tests; `npm run smoke` builds a throwaway repo and opens a diff (29 checks)
- [x] Dev servers the app started: port, URL, ready state, logs, Stop and Restart; never touches a process it didn't start — done 2026-10-21: a Dev tab lists the workspace package.json's dev, start, serve, preview and watch scripts and runs one with `<npm|pnpm|yarn> run` (by lockfile, by full path from PATH). The first loopback address it prints marks it ready; `acc://dev/<id>` shows its log, served like run pages. Stop and Restart end the process tree by the pid it was spawned with, only while it runs, and closing the app stops them all. `src/shared/devservers.js` and `src/main/devservers.js`, 7 tests; `npm run smoke` starts a throwaway server, fetches it, restarts and stops it (30 checks)

### 🏃 Milestone D: agent work with evidence

- [x] Managed runs: a run has an id, its fixed folder and command, start and end, exit code, output and a Cancel; `terminal_run` returns the run id, and `run_status` reads it. Success comes from the exit code, never from the output text — done 2026-10-21: on Run, main opens the run's own PowerShell with a fixed `-Command` script and the command in `ACC_RUN_COMMAND` (ADR-003's 2026-10-21 update); its exit code is the result (last native non-zero code, else 1 if PowerShell wrote an error, else 0; `exit N` wins), the same in PowerShell 7 and 5.1. Closing its tab while it runs cancels it and ends its process tree. `run_status` gives state, exit code, times and cleaned output; the newest 50 runs are kept. `isFreshRunTarget` is gone. `src/shared/runs.js`, `src/main/kill.js`; 5 tests; `npm run smoke` checks a success, an exit code 3 and a cancel (32 checks)
- [x] Activity drawer: queued, waiting for approval, running, failed, cancelled and finished agent work, each with what was asked and the exact target — done 2026-10-21, roadmap run: **Agent work** at the top of the MCP tab, one row per `terminal_run` or `cron_run` ask (the exact command or task name, its folder or task id), from waiting for approval or queued, through running with its run id, to finished or failed with the exit code, cancelled, denied, not answered or withdrawn; a Cronsole task ends as started in Cronsole. The tab's label counts what's waiting or running. Kept in memory, newest 50. The bar's answer reaches main as yes or no. `src/shared/activity.js`, 3 tests; `npm run smoke` checks the three runs' rows (33 checks)
- [x] MCP clients by name: `initialize`'s `clientInfo` recorded and shown, and every later call tied to its client — done 2026-10-25, roadmap run: a legacy client gets an `Mcp-Session-Id` at `initialize` (a random UUID that grants nothing; an unknown one is ignored, the newest 100 kept), and its later calls log under the name it gave; a `2026-07-28` client is named from each request's own `_meta`. The stdio bridge sends the id back while the app's token is the same, and the chat panel's own client now speaks `2026-07-28` as `houston-chat`. The MCP tab shows the client beside each call's time. Names stay self-reported. 1 new test plus session checks in the handshake, bridge and chat tests; `npm run smoke` passes. The tool switch moved to its own row below
- [x] ~~A per-client switch for which MCP tools each client may call~~ — dropped 2026-10-26 on Mike's answer in [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md): the acting tools already wait for a click, and a switch keyed on a self-declared client name is not a boundary. Revisit only with per-client tokens and an ADR
- [ ] Provider adapters: the model API and CLI agents behind one small contract (health, capabilities, invoke, cancel, events), with Claude first. Open question first: with one provider it's an interface with one implementation, and starting a CLI agent from the app is a new kind of process start ([OPEN-QUESTIONS.md](OPEN-QUESTIONS.md))
- [x] Browser actions on a tab the user attaches: screenshot, click and fill by element, with a confirm before anything submits — done 2026-10-26, roadmap run: the user attaches one tab with **Let agents click and type here** in its right-click menu (web pages only; 🤖 in the strip, `agent` in `list_tabs`). `tab_elements` lists its visible links, buttons and fields with refs, `tab_screenshot` returns a PNG as an MCP image block, and `tab_click` and `tab_fill` act on a ref only after Run on the confirm bar, which names the element, the text and the host. Every click and fill waits for the bar, not only submits. The page scripts run in an isolated world, and an element that changed, left the page or is covered by something else is refused; the click and the typing are real input events, and a fill never presses Enter. `tab_fill`'s text reaches `mcp.log` as its length. `src/shared/pageactions.js`, 8 tests; `npm run smoke` fills a field and clicks example.com's link (31 checks)
- [x] Run history: past runs, their output and changed files, searchable, without scrolling the chat — done 2026-10-27: **Runs** in the MCP tab lists `terminal_run`'s runs, newest first, from `runs.json` (the newest 50, so they outlive a restart; one the app quit during comes back cancelled). The box at the top searches each run's command, folder, changed files and output and shows the line that matched; a click, here or on an Agent work row, opens `acc://runlog/<id>`, a script-free page with the command, folder, exit code, times, changed files and output, served like the other app-only pages. Changed files are the repo paths whose `git status` entry differs between just before the run and just after, so a file already dirty and changed again isn't caught. `src/shared/runs.js`, 4 new tests; `npm run smoke` searches for the failing run and opens its page (36 checks)

### Phase 2b: close the agent's loop

Added in the 2026-10-05 review. Today an agent can type a command and open things, but it can't see what happened: `terminal_run` returns before the output, `list_tabs` gives URLs without content, and the "trigger a Cronsole task" the harness promised in [requirements.md](decisions/requirements.md#features) never landed. Each item here is read-only or sits behind the same click as `terminal_run`.

- [x] `list_terminals` and `terminal_read`: the open terminal sessions (id, shell, folder, whether PowerShell, whether exited) and the last N lines of one session's output with ANSI escapes stripped, from a ring buffer the main process keeps per session. Read-only, no click. Closes the loop for "run `npm test` and tell me what failed" — 2026-10-05; `src/shared/output.js` cleans the output (4 tests), the tools have 1 test, and `npm run smoke` reads back what `terminal_run` printed
- [x] `read_tab`: the visible text of a tab (`document.body.innerText`, clipped to a size limit) plus its title and URL, so the chat can summarise or quote the page it's looking at. The tool description says the text is untrusted page content, not instructions — 2026-10-05; 1 test, and `npm run smoke` reads example.com back
- [x] `cron_run`: start a Cronsole task through Cronsole's own `run_task`, shown on the confirm bar like a command and run only after the click; `cron_tasks` as the read-only list the Cron tab already has. The task id stays in the main process; the click only answers yes or no — 2026-10-05; `runTask` in `src/shared/cronsole.js` (2 tests) and the tools (2 tests); `npm run smoke` calls `cron_tasks`
- [x] Chat: a "+ page" and "+ terminal" button that attaches `read_tab` or `terminal_read` output to the next message, so "what does this page say" needs no tool round-trip — 2026-10-11, roadmap run; toggles in the chat bar, read in the main process through the MCP server (logged like any call) and sent as `<attached …>` blocks the system prompt calls content, not instructions. 3 tests; `npm run smoke` toggles + page. Not yet sent to the live API, which needs Mike's key
- [x] Chat: stream the reply as it arrives, trim old turns past a token budget, and keep the last conversation across restarts in `chat.json` — 2026-10-12, roadmap run; `readStream`, `trimHistory` (about 50,000 tokens, whole turns, oldest first), `cleanMessages` and `transcript` in `src/shared/chat.js`, 8 tests; `npm run smoke` checks the panel gets the saved history. Not yet streamed from the live API, which needs Mike's key
- [x] MCP `tools/list` carries `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`) so clients can show which tools look and which act — 2026-10-14, roadmap run; seven tools look, `open_tab` and `open_file` open without harm, `terminal_run` and `cron_run` are destructive and open-world. Set in `src/shared/tools.js`, passed through by `src/shared/mcp.js`; 1 test

### Integrations

APIs the neighbours already expose, found in the 2026-10-05 review.

- [x] Project Hub's `/api/events` stream: the sidebar subscribes once and reloads the tree on `change`, so a rescan shows up without Retry and the document index in `src/main/docs.js` drops its 30 s cache — 2026-10-18; `src/shared/events.js` parses the stream (6 tests), the main process subscribes and reconnects over the stream, a `change` reloads the Files tree and invalidates the doc index, and the demo's fake hub answers the new `onChanged`
- [x] Star the current page: a ☆ in the address bar that adds the tab to Hub's favorites through `PUT /api/favorites`, so the app's own bookmarks source gains entries without opening Hub — 2026-10-18; `src/shared/favorites.js` adds/removes a link in the favorites tree (6 tests), `hub.favorite` GETs and PUTs the whole list, the address-bar ☆ toggles and shows filled when starred, and the demo's fake hub toggles for real
- [x] Links in the terminal open as tabs: an xterm `registerLinkProvider` for `http(s)://` and `localhost:<port>` text, so the address a dev server prints is one click from a tab. No new dependency; mark `- [!]` and use `@xterm/addon-web-links` (MIT) if the hand-written provider misses cases — 2026-10-18, roadmap run; `src/shared/links.js` finds the links (6 tests), `src/renderer/terminal.js` registers the provider and a click opens a tab. A URL wrapped onto a second row links its first row only
- [x] Cronsole rows show the last run's result: `get_task_history` on hover or click, with `get_run_output` behind a "Show output" that opens as an `acc://doc`-style page — 2026-10-19, roadmap run; a click on a task unfolds its last 5 runs, a run opens `acc://run/<task>/<run>` (the run's log, or `get_run_output` for a platform run) under `DOC_HEADERS`, from the app only. `taskHistory`, `runOutput`, `runRows`, `runUrl`/`runFromUrl` and `runSummary` in `src/shared/cronsole.js`, `runPage` in `src/shared/docs.js`, 6 tests; `npm run smoke` opened a real run's page
- [x] A count of failed Cronsole tasks on the Cron tab's label, refreshed on the same timer as the Hub health dot — 2026-10-21: a red badge counting active tasks whose last run failed (paused and missing ones aren't), checked at start and every 60 s with the Hub dot and whenever the tab loads, names in its tooltip; only when Cronsole is set up. `failedTasks` in `src/shared/cronsole.js` (1 test); `npm run smoke -- --live` compares the badge with the failed rows (31 checks)
- [x] Claude Code in the terminal: when `claude` registers with the MCP server, the MCP tab's first row says which client connected (`initialize`'s `clientInfo`), so the log reads "claude-code 2.x connected" rather than two ✗ rows — 2026-10-21: the `initialize` row names the client from `clientInfo` (control characters stripped, clipped), and the two refusals Claude Code 2.1.307 actually triggers (a `400` for its `2026-07-28` version probe and a `405` for GET's event stream; `DELETE` too) log as grey `(handshake)` rows with a note instead of ✗. Refusals before the token stay failures. `clientInfo` is recorded in the log entry only; the per-client view stays in Milestone D. `expectedCall` in `src/shared/mcplog.js`; 3 tests, one replaying Claude Code's real handshake; checked against `claude -p --mcp-config` too

### Later

Moved behind Milestones A to D on 2026-10-20: none of these helps the edit, run and check loop. The IDE line moved to Milestone C.

- [ ] Docs upkeep view, as a filter on the Cron tab (the docs-maintenance jobs and their reports) rather than a panel of its own
- [ ] AI news panel and AI bookmarks feed, read from configurable RSS or Markdown sources
- [ ] Phone channel through an existing gateway (Claude Remote Control, Hermes or OpenClaw). Needs its own ADR first: pairing, per-device scopes and revocation. Never exposes the MCP port as it is

### Daily use, round 2

Nice to have; found in the 2026-10-05 review.

- [x] Right-click in the terminal copies a selection or pastes — 2026-10-20; `src/renderer/terminal.js`
- [x] Manage extensions: an **Extensions** menu with Get extensions…, and per extension Options, Web Store page and Remove (uninstalls for good) — 2026-10-20; `extensionsMenu` in `src/main/extensions.js`
- [x] Ad and tracker blocking, on by default with a menu toggle: Ghostery's engine with EasyList/EasyPrivacy, since Web Store MV3 blockers can't work in Electron — 2026-10-20, Mike's call on the dependency; `src/main/adblock.js`
- [ ] Address bar suggestions from Recent and bookmarks as you type, picked with the arrow keys
- [ ] Tabs: drag to reorder, duplicate, mute, and pin any tab (today only Cronsole's is pinned)
- [ ] Downloads: `will-download` handled so a finished download shows a toast with Reveal in Explorer, and lands in Recent
- [ ] Light theme for the shell, following `prefers-color-scheme` the way document pages already do
- [!] Terminal search with `@xterm/addon-search` (MIT) — blocked: needs a new dependency, which the routine never installs; Mike adds it by hand
- [ ] Terminals: rename a tab, font size, and output sent to the renderer in batches so a noisy build doesn't flood IPC
- [ ] Keyboard and screen-reader pass: the Files tree and tab strip work from the keyboard, focus is visible, the confirm bar takes focus, splitters report their value
- [ ] Measure memory per tab with ten tabs open, before deciding whether idle tabs need suspending

### Code health

From the 2026-10-05 review.

- [x] Move the smoke routine out of `src/main/main.js` into `src/main/smoke.js`; it's 150 lines of a 490-line file that CLAUDE.md says should stay thin — 2026-10-20; `main.js` 590 → 389 lines, `npm run smoke` passes unchanged
- [x] Test counts in `README.md`, `tests/README.md` and `CLAUDE.md` drift apart (65+, 74 and 80 on 2026-10-05). Say "80+" once in `tests/README.md` and drop the number elsewhere, or print it from CI — 2026-10-20; the one count is the "140+" badge in `tests/README.md`, CLAUDE.md points there, README.md had none

- [ ] The terminal's last-resort shell runs by a full path: when no shell is found at its usual place, `shellProfiles` falls back to a bare `powershell.exe`, which Windows looks up in the starting folder first (the Git and Dev tabs already resolve `git.exe` and `npm.cmd` from PATH's absolute entries with `onPath()` in `src/main/env.js`; do the same here). Found 2026-10-21 while building the Git view; unit-test the fallback

### Distribution and promotion

- [ ] Windows installer with electron-builder, published as a GitHub release, with a profile backup before an upgrade and a way back
- [ ] Code-signing certificate (costs money) 🔒 Needs Mike
- [ ] Electron upgrade drill done once, following ADR-001's checklist
- [ ] Launch post for the ai-automation-tools.dev landing page

---

<p align="center">
  <a href="README.md">← Docs home</a> ·
  <a href="CHANGELOG.md">Changelog →</a>
</p>
