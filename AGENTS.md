# AGENTS.md — Houston

Instructions for any agent working in this repo (Codex, opencode, Antigravity and Claude Code, which imports this file from `CLAUDE.md`), including the roadmap routine that runs twice a week.
Read `docs/ROADMAP.md`, `docs/product/spec.md`, `docs/product/harness-requirements.md` and `docs/decisions/` before changing code.

## What this is

A Windows desktop app that puts a browser, PowerShell terminals and a sidebar over the
user's project folders into one Electron window, with an agent harness: an MCP server
the app exposes, plus a chat pane on the right with named conversations. Workspaces tie a
folder to its tabs, terminals and conversations, Ctrl+K opens a command palette over all of
it, Connections shows what's working, a read-only Git tab shows the workspace repo's
changes, a Dev tab starts and stops the workspace's dev servers, an Agents tab starts agent identities in contained sessions through the Core, and a News tab lists headlines from the feeds `settings.json` names. The sidebar reads Project Hub's
HTTP API rather than scanning disk. It was a public `ai-automation-tools` project from 2026-10-18; on 2026-11-12 the repo was re-created private to grow it into an agent harness (the old one is archived as `houston-legacy`), and going public again is its own gate. The roadmap routine works the items under `## After public release`, where the `Harness H0` to `H7` milestones now come first.

**The harness.** [ADR-004](docs/decisions/adr-004-core-companion-process.md) adds a companion process, the Core, under `core/`. The Core launches agent CLIs as identities inside OS containers, decides policy, runs the MCP gateway, holds secrets and writes audit. Houston is its client: it shows and asks, and never enforces. `core/` follows the same conventions as `src/` (ES modules, JSDoc types, `node:test`, no bundler). Inside `core/`: `policy` and `audit` import nothing from `runner` or `gateway`, only `vault` touches secret values, and nothing binds beyond `127.0.0.1`.

## Stack

| Part | What |
|:---|:---|
| Runtime | Electron 45, one `BaseWindow`: a shell `WebContentsView` plus one sandboxed `WebContentsView` per browser tab |
| Extensions | electron-chrome-extensions 4.9 (GPL-3.0) + electron-chrome-web-store 0.13 |
| Ad blocking | @ghostery/adblocker-electron 2.20 (MPL-2.0), owns the browse session's `webRequest` `onBeforeRequest`/`onHeadersReceived` |
| Terminal | node-pty 1.1 (prebuilt N-API binaries, bundled ConPTY) + xterm.js 6 |
| Code | Plain JavaScript ES modules with JSDoc types. No bundler, no TypeScript build, no framework. The preload is CommonJS. |
| Tests | `node:test` over the pure helpers in `src/shared/` |

## Verify

```powershell
npm run lint     # node --check on every .js/.cjs/.mjs in src, scripts, tests
npm test         # unit tests (count in tests/README.md)
npm run smoke    # the real app on a throwaway profile: named checks, .smoke/summary.json, exit 1 on a failure (needs a desktop session; -- --live adds the Hub and Cronsole checks)
npm run demo     # builds the browser demo (renderer + src/demo's fake window.acc) into _site/
```

`npm run lint` and `npm test` must pass on every change, and CI (`.github/workflows/ci.yml`)
runs both on every push; the org PR sweep won't merge a PR with a red check, and the
Graduate stage needs a green run on `main`. Run `npm run smoke` when you touch `src/main/`, `src/preload/`
or `src/renderer/` and you have a desktop session. `npm run scan:secrets` (gitleaks)
before anything goes public, and `npm run gate` before a release: it passes only if the newest
saved abuse run (`node abuse/run.js`, all tests, on this machine) covered this exact code.

## Standards

- **Security invariants.** Don't weaken any of these:
  - Browser tabs are `sandbox: true`, `contextIsolation: true`, and get no preload from this app but the extension-API ones, which act only on `chrome-extension://` pages, and (with ad blocking on) Ghostery's cosmetic-filter preload, which asks main for the CSS that hides ad slots (`preload/extension-browser.cjs`).
  - Pages get no permission that isn't in `src/shared/permissions.js` (fullscreen, pointer lock, sanitized clipboard writes). Don't add media, location, notifications or devices to that list without an ADR.
  - Every IPC handler in `src/main/main.js` goes through `handle()` / `on()`, which refuse any sender but the shell view.
  - Tabs refuse navigation outside `isAllowedNavigation()` (`src/shared/url.js`). A `file:` URL reaches a tab only as a path on a drive of this machine (`isLocalFileUrl()`), and the browse session's `file:` handler refuses one with a host for every request, a page's image included: on Windows that host gets an SMB sign-in carrying the user's NTLM hash.
  - The shell view runs with `sandbox: false` only because its preload loads the extensions toolbar (owner's call 2026-11-27, ADR-004). That's acceptable only while it loads nothing but `acc://shell` files with `script-src 'self'`: don't load remote scripts or pages into it, and don't give its preload more than `contextBridge` and `ipcRenderer`.
  - Each terminal shell is a fixed executable with fixed arguments in `src/shared/shells.js`. The renderer only picks a starting folder and a profile id. No IPC message, MCP call or URL may pass a shell path or arguments.
  - `terminal_run` is a managed run (ADR-003's 2026-10-21 update): only after the user clicks Run on the confirm bar does main open the run's own PowerShell session in the folder the bar named. That session's arguments are the fixed `RUN_SCRIPT` from `src/shared/runs.js`; the confirmed command reaches it only in `ACC_RUN_COMMAND`, which the script reads and removes, never as an argument. Only main sets that variable, from the command it held since the ask (`Terminals.create({ run })`); no IPC message can pass one. The click's answer is just yes or no. `commandArg()` refuses newlines, control and invisible characters. A run's result is its session's exit code, never its output text. Don't add a way around the click.
  - `acc://shell/` serves mapped folders only, with a path-escape check. Don't widen the map.
  - `acc://doc/` is served on the browse session only (`src/main/docs.js`): ids from Hub's index only, `DOC_HEADERS` on every response (no scripts, no framing), image bytes only to a document referrer, and `isAllowedNavigation()` refuses it from any page that isn't itself a document. `acc://run/<task>/<run>` (a Cronsole run's output) is served the same way, only for a task in `list_tasks` and a run in its history, and opens from the app only: no page may navigate to it, and a request with any referrer but another run page is refused. `acc://git/<path>?area=…` (a file's diff) follows the same rules, served only for a file `git status` lists now with that kind of change, and so does `acc://runlog/<id>` (a `terminal_run` run's output), only for a run in the history.
  - The chat panel's API key and model are read from `.env` or the environment by the main process (`src/main/env.js`, `src/main/chat.js`). `.env` stays gitignored and out of `process.env`, so the key never goes to the renderer, the terminals, Cronsole's child process, the app's own files or the repo, and there is no default model ID. The chat's tools go through the MCP server with its token, never around it.
  - The Git tab (`src/main/git.js`) is read-only and runs only the command lines fixed in `src/shared/git.js`, through `execFile` with `childEnv`, never a shell, and by git's full path from PATH's absolute entries (a bare `git` on Windows is looked up in the repo folder first). Each keeps fsmonitor, external diff and textconv off, and a path goes after `--` and must come from `git status`. Anything that writes (stage, commit, push) needs its own confirm design first.
  - Cronsole's MCP server (`src/main/cronsole.js`) runs on the app's own Electron binary (`ELECTRON_RUN_AS_NODE`) with the script path from `ACC_CRONSOLE_MCP` in `.env` or the environment. No IPC message, MCP call or URL may name that script or pass it arguments, and the app calls only its read-only `list_tasks`, `get_task_history` and `get_run_output` and, after the user clicks Run on the confirm bar, `run_task` with an id from that list (`cron_run`).
  - The Dev tab (`src/main/devservers.js`) runs `<npm|pnpm|yarn> run <script>` only on a click, in the active workspace's folder (never a folder the renderer names), for a script `devScripts()` finds in that folder's `package.json` at that moment and `isScriptName()` passes, since it goes on cmd's command line. The manager runs by its full path from PATH's absolute entries (`onPath()` in `src/main/env.js`), with `childEnv`. Stop and Restart kill a process tree only by the pid `spawn` returned, only while that child is still running; nothing finds or kills a process by name or port. No MCP tool starts one without a confirm design first. `acc://dev/<id>` (its log) is served like run pages, only for a server in this run's list.
  - The Agents tab (`src/main/agents.js`) only asks the Core: the renderer names an identity or a session id and nothing else. The folder is the active workspace's, the command is the identity's backend manifest or the fixed `SHELL_COMMAND` in `src/shared/agents.js`, and the only other thing sent is `toolchainPath()`'s `PATH` folders, which grant nothing. The Core decides and enforces; the window never starts, reads into or widens a session itself. A session's terminal comes over the Control API's `session.attach`, never a port.
  - The approval bar (`src/main/approvals.js`) only relays: it lists what the Core's inbox holds and sends back an approval id and `once`, `session` or `deny` (`isAnswer()`), nothing else. The Core holds the request and denies it at its timeout, so the window can never make an ask succeed by failing. Deny keeps the focus. Don't add an "allow always" or a way to answer from an MCP tool or the chat.
  - Stop All (`stopAllSessions()` in `src/main/main.js`) stays on the navbar, which nothing hides, keeps its hotkey and tray item, runs in the main process and asks nothing first. It stops only the Core's sessions. Don't put a confirm in front of it, move it somewhere that can be hidden, or let an MCP tool or the chat reach it (it's the operator's).
  - A session's environment is Windows' own variables (`SYSTEM_ENV` in `core/launch.js`) plus what the launch sets, never the user's: `inheritDefaultEnvironment` stays `false`, because the user's environment holds their API keys and tokens. AT-07 checks it.
  - Nothing crosses profiles (`core/profiles.js`): a session's gateway serves only its identity's profile's MCP servers, a server gets only its profile's secrets, and every profile's folder is a global deny. A new query over identities, servers or secrets filters by profile. AT-01 checks the folder.
  - Profile export (`core/profile-export.js`) carries a secret's name, never its value, and runs every string through the vault's redaction. Restore writes no row itself: it goes through the operator's own create calls, so every check applies, and what it brings back waits for the operator (draft identities, discovered servers, paused standing grants).
  - `harness.recall` serves approved memory only (`core/memory.js`), from the session's own profile; never serve a pending item, however it's asked for.
  - A quarantine profile's rules live in `core/quarantine.js` and are checked where each thing is made (registry, vault, gateway, standing); add a rule there, never in the window.
  - A broad-access (unconfined) identity is marked wherever it appears and holds a standing grant only with `standing_allowed`; never let an unconfined start look contained.
  - Only the operator installs a skill (`core/skills.js`); a session gets one read-only, by grant, and never one whose files changed since install.
  - Only the Core makes a sub-agent (`core/delegate.js`): its grants are what its parent's cover, never wider, plus every parent deny, and it never outlives its parent's session. Change `intersect` only with a test that tries to widen it; AT-10 checks it in containers.
  - Standing grants (`core/standing.js`) are made and changed only through the Control API, and a run is always unattended: every `ask` is a deny. `core/harness.js` sends the Core nothing but the grant's id. A backend's `headless` start (`core/backends.js`) is the only place its CLI's permission prompts are turned off, and only for a standing grant's prompt. Stop All pauses them before it stops sessions; nothing resumes one but `standing.resume`.
  - The Integrations tab (`integrations` in `src/main/agents.js`) sends the Core a server name, and to pin, the tools hash the tab showed, or a standing grant's id to pause or resume it (`serverName()`, `toolsHashArg()`, `standingId()` in `src/shared/integrations.js`), nothing else. Registering a server and setting a secret stay with `ctl`: no command line or secret value goes through the window.
  - The Logs tab (`logs()` in `src/main/agents.js`) only reads, through `audit.query`; the renderer sends nothing but `logFilter()`'s identity, session and decision. No way to edit, delete or export the audit log from the window.
  - The MCP gateway (`core/gateway.js`) answers only a session's own token on that session's own port, checks Host and Origin, and makes one policy check per `tools/call` before the server hears of it. Only a pinned server serves, and a changed tool list sends it to review. Servers run in their own containers as their own `local:mcp/<name>` identities, never in the agent's; a `host` or `http` registration runs outside one, and its identity must stay marked `unconfined`. A host server gets only its registration's env, never the Core's. Never forward an agent's token upstream or an upstream credential to an agent; results always go through `shapeResult()` (vault values redacted, marked untrusted, capped).
  - The vault (`core/vault.js`) is the only module that stores or opens a secret, and only the gateway calls `reveal()`, to put a value into a server's environment after a `secret:` use grant. No Control API method returns a value, no audit event holds one or its hash, and a value is never passed on a command line (`ctl` reads it from stdin).
  - Transcripts (`core/transcripts.js`) are redacted before write, never after, and only the Core writes or deletes them; retention (`core/logs.js`) deletes the oldest finished transcripts first and only then whole audit segments, never the open one, and audits each; deleting or exporting logs is the operator's, from `ctl`, never the window. The window only reads one through `transcript.get` (`acc://transcript/<id>`, opened from the app, never a web page). Don't add a path that stores a session's output unredacted.
  - The Settings page (`src/shared/scopes.js`, `acc://settings/`) only shows; it never changes a control. A new control gets a row there with its scope from harness-requirements.md's scope table and where it's changed. Never show a secret's value, only whether it's set.
  - The Health page (`acc://health/`, `src/shared/health.js`) only shows, and `core.health` only reads. The diagnostics bundle is written from a menu click to the app's own `diagnostics` folder and nowhere else, every string through `scrub()` (the user folder, the app's keys) and the Core's log through the vault's redaction; nothing uploads it. Add a field to it only if it passes the same scrub.
  - Project Hub's token (`ACC_HUB_TOKEN`) is an app secret like the chat key: in `childEnv()`'s drop list, sent only by `src/main/hub.js` and only where `hubAuth()` allows (a Hub on this machine or https). Never put it in a URL, a page or the renderer.
  - The browser demo (`src/demo/`) loads only modules with no Node imports (a test walks them), makes no network calls, and shows only made-up data. Publishing it is the owner's call.
  - The News tab fetches only the sources in `settings.json` (`newsSources`: http(s), or an absolute local `.md` path), from main with Node's fetch, a deadline and a size cap; no IPC message, MCP call or URL names a source. Only a plain-text title and an http(s) link leave `src/shared/news.js`, and the sidebar sets the title as text.
  - Nothing the app itself runs listens on a network port except the Phase 2 MCP server, which binds `127.0.0.1` and requires a per-launch token. The Core adds the one listener ADR-004 allows: a per-session egress proxy (`core/egress.js`), bound to `127.0.0.1`, which only the session's container can use as its way out, and which also serves that session's MCP gateway.
  - MCP tools that look (`list_tabs`, `read_tab`, `list_terminals`, `terminal_read`, `run_status`, `sidebar_search`, `recent`) need no click; anything that acts on the machine (`terminal_run`, `cron_run`) or on a page (`tab_click`, `tab_fill`) waits for one. `read_tab`, `terminal_read`, `tab_elements` and `tab_screenshot` return untrusted content and their descriptions say so.
  - Browser actions (`src/shared/pageactions.js`) reach only the one tab the user attached in its right-click menu, while it shows a web page. Their page scripts run in an isolated world, never the page's, and act on an element only if it is still the one the bar named and nothing covers it. A fill never presses Enter.
- **The demo stays fake.** `src/demo/` answers every `window.acc` call from made-up data: no network call, no storage, no secret, and the source bar stays on. A new call in `src/preload/shell.cjs` needs an answer in `src/demo/acc.js` (`tests/demo.test.js` fails otherwise), and renderer paths stay relative so the same files serve under `acc://shell/` and on Pages.
- **Nothing personal in tracked files.** Per-machine values (the Hub URL, the quick links) live in `%APPDATA%\ai-command-center\settings.json`, read with neutral defaults by `src/shared/settings.js`. Tests use `example.com` hosts.
- **Logic goes in `src/shared/`, with a test.** Main and renderer code stays thin enough to be covered by the smoke run.
- **Keyboard.** Ctrl+L and Ctrl+R belong to PowerShell when the terminal has focus. Don't add them to the app menu. Everything else a browser expects (Ctrl+T/W/F, Ctrl+Tab, Ctrl+1 to 9, zoom) is in the menu.
- **Docs move with code.** Update `docs/guide/`, `README.md`, `src/README.md`, the rest of `docs/` and this file when a change makes them untrue. Keep the root README short: one-line descriptions, commands and tables; detail goes in `docs/guide/`. Every ticked roadmap item gets a `docs/CHANGELOG.md` line in the same commit, tagged with its phase in italics.
- **Commits:** plain imperative sentences, no Conventional Commit prefixes.
- **Licence:** GPL-3.0-or-later. A new runtime dependency must have a GPL-3.0-compatible licence (MIT, BSD, Apache-2.0, LGPL, GPL); say which in the PR body.
- **Never commit** `.env*`, `node_modules/`, `.smoke/`, or any absolute local path (a user profile or workspace drive path). The repo was public and is meant to be again, so treat anything committed as published.

## Won't

These stay out unless a new ADR in `docs/decisions/` says otherwise:

- Forking Chromium or BrowserOS, or switching the runtime away from Electron.
- A bundler, a TypeScript build step, React or any UI framework.
- A hosted backend, accounts, sync, or telemetry of any kind.
- Rebuilding what Project Hub or Cronsole already do. Integrate over their APIs or MCP servers.
- Writing an editor. The IDE pane embeds code-server or OpenVSCode Server.
- Workarounds that patch or monkey-patch Chrome extensions to make them run.
- A built-in agent loop, model router or prompt framework. Agent CLIs are governed backends (ADR-004).
- A home-made sandbox. Containment is the operating system's.
- Chat-channel gateways (Telegram, Discord, Slack).
- Installing or running anything straight from a feed or catalogue item. Discover, install, attach and run are separate steps.
- A prompt or a UI toggle as a security control. Every control names what enforces it.
- Bumping Electron's major version without rerunning `npm run spike:extensions` and recording the result in ADR-001.

## Dependencies

`node_modules/` in a routine worktree is a junction to the real checkout. **Don't run
`npm ci` or `npm install` there**: `npm ci` deletes `node_modules`, which would wipe the
real checkout's copy, including the Electron binary. An item that needs a dependency
change gets `- [!]` with the reason, for Mike to install by hand.

## Done means

A roadmap item is done when its code is in, `npm run lint` and `npm test` pass, the docs
it made untrue are fixed, the changelog has its line, and the item is `- [x]` with a
dated note.
