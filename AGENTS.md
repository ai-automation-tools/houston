# AGENTS.md — Houston

Instructions for any agent working in this repo (Codex, opencode, Antigravity and Claude Code, which imports this file from `CLAUDE.md`), including the roadmap routine that runs twice a week.
Read `docs/ROADMAP.md`, `docs/product/spec.md` and `docs/decisions/` before changing code.

## What this is

A Windows desktop app that puts a browser, PowerShell terminals and a sidebar over the
user's project folders into one Electron window, with an agent harness: an MCP server
the app exposes, plus a chat pane on the right with named conversations. Workspaces tie a
folder to its tabs, terminals and conversations, Ctrl+K opens a command palette over all of
it, Connections shows what's working, a read-only Git tab shows the workspace repo's
changes, and a Dev tab starts and stops the workspace's dev servers. The sidebar reads Project Hub's
HTTP API rather than scanning disk. It's a public `ai-automation-tools` project
(graduated 2026-10-18); the weekly roadmap routine works the items under `## After public release`.

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
before anything goes public.

## Standards

- **Security invariants.** Don't weaken any of these:
  - Browser tabs are `sandbox: true`, `contextIsolation: true`, and get no preload from this app but the extension-API ones, which act only on `chrome-extension://` pages, and (with ad blocking on) Ghostery's cosmetic-filter preload, which asks main for the CSS that hides ad slots (`preload/extension-browser.cjs`).
  - Pages get no permission that isn't in `src/shared/permissions.js` (fullscreen, pointer lock, sanitized clipboard writes). Don't add media, location, notifications or devices to that list without an ADR.
  - Every IPC handler in `src/main/main.js` goes through `handle()` / `on()`, which refuse any sender but the shell view.
  - Tabs refuse navigation outside `isAllowedNavigation()` (`src/shared/url.js`).
  - Each terminal shell is a fixed executable with fixed arguments in `src/shared/shells.js`. The renderer only picks a starting folder and a profile id. No IPC message, MCP call or URL may pass a shell path or arguments.
  - `terminal_run` is a managed run (ADR-003's 2026-10-21 update): only after the user clicks Run on the confirm bar does main open the run's own PowerShell session in the folder the bar named. That session's arguments are the fixed `RUN_SCRIPT` from `src/shared/runs.js`; the confirmed command reaches it only in `ACC_RUN_COMMAND`, which the script reads and removes, never as an argument. Only main sets that variable, from the command it held since the ask (`Terminals.create({ run })`); no IPC message can pass one. The click's answer is just yes or no. `commandArg()` refuses newlines, control and invisible characters. A run's result is its session's exit code, never its output text. Don't add a way around the click.
  - `acc://shell/` serves mapped folders only, with a path-escape check. Don't widen the map.
  - `acc://doc/` is served on the browse session only (`src/main/docs.js`): ids from Hub's index only, `DOC_HEADERS` on every response (no scripts, no framing), image bytes only to a document referrer, and `isAllowedNavigation()` refuses it from any page that isn't itself a document. `acc://run/<task>/<run>` (a Cronsole run's output) is served the same way, only for a task in `list_tasks` and a run in its history, and opens from the app only: no page may navigate to it, and a request with any referrer but another run page is refused. `acc://git/<path>?area=…` (a file's diff) follows the same rules, served only for a file `git status` lists now with that kind of change, and so does `acc://runlog/<id>` (a `terminal_run` run's output), only for a run in the history.
  - The chat panel's API key and model are read from `.env` or the environment by the main process (`src/main/env.js`, `src/main/chat.js`). `.env` stays gitignored and out of `process.env`, so the key never goes to the renderer, the terminals, Cronsole's child process, the app's own files or the repo, and there is no default model ID. The chat's tools go through the MCP server with its token, never around it.
  - The Git tab (`src/main/git.js`) is read-only and runs only the command lines fixed in `src/shared/git.js`, through `execFile` with `childEnv`, never a shell, and by git's full path from PATH's absolute entries (a bare `git` on Windows is looked up in the repo folder first). Each keeps fsmonitor, external diff and textconv off, and a path goes after `--` and must come from `git status`. Anything that writes (stage, commit, push) needs its own confirm design first.
  - Cronsole's MCP server (`src/main/cronsole.js`) runs on the app's own Electron binary (`ELECTRON_RUN_AS_NODE`) with the script path from `ACC_CRONSOLE_MCP` in `.env` or the environment. No IPC message, MCP call or URL may name that script or pass it arguments, and the app calls only its read-only `list_tasks`, `get_task_history` and `get_run_output` and, after the user clicks Run on the confirm bar, `run_task` with an id from that list (`cron_run`).
  - The Dev tab (`src/main/devservers.js`) runs `<npm|pnpm|yarn> run <script>` only on a click, in the active workspace's folder (never a folder the renderer names), for a script `devScripts()` finds in that folder's `package.json` at that moment and `isScriptName()` passes, since it goes on cmd's command line. The manager runs by its full path from PATH's absolute entries (`onPath()` in `src/main/env.js`), with `childEnv`. Stop and Restart kill a process tree only by the pid `spawn` returned, only while that child is still running; nothing finds or kills a process by name or port. No MCP tool starts one without a confirm design first. `acc://dev/<id>` (its log) is served like run pages, only for a server in this run's list.
  - Nothing the app itself runs listens on a network port except the Phase 2 MCP server, which binds `127.0.0.1` and requires a per-launch token.
  - MCP tools that look (`list_tabs`, `read_tab`, `list_terminals`, `terminal_read`, `run_status`, `sidebar_search`, `recent`) need no click; anything that acts on the machine (`terminal_run`, `cron_run`) or on a page (`tab_click`, `tab_fill`) waits for one. `read_tab`, `terminal_read`, `tab_elements` and `tab_screenshot` return untrusted content and their descriptions say so.
  - Browser actions (`src/shared/pageactions.js`) reach only the one tab the user attached in its right-click menu, while it shows a web page. Their page scripts run in an isolated world, never the page's, and act on an element only if it is still the one the bar named and nothing covers it. A fill never presses Enter.
- **The demo stays fake.** `src/demo/` answers every `window.acc` call from made-up data: no network call, no storage, no secret, and the source bar stays on. A new call in `src/preload/shell.cjs` needs an answer in `src/demo/acc.js` (`tests/demo.test.js` fails otherwise), and renderer paths stay relative so the same files serve under `acc://shell/` and on Pages.
- **Nothing personal in tracked files.** Per-machine values (the Hub URL, the quick links) live in `%APPDATA%\ai-command-center\settings.json`, read with neutral defaults by `src/shared/settings.js`. Tests use `example.com` hosts.
- **Logic goes in `src/shared/`, with a test.** Main and renderer code stays thin enough to be covered by the smoke run.
- **Keyboard.** Ctrl+L and Ctrl+R belong to PowerShell when the terminal has focus. Don't add them to the app menu. Everything else a browser expects (Ctrl+T/W/F, Ctrl+Tab, Ctrl+1 to 9, zoom) is in the menu.
- **Docs move with code.** Update `docs/guide/`, `README.md`, `src/README.md`, the rest of `docs/` and this file when a change makes them untrue. Keep the root README short: one-line descriptions, commands and tables; detail goes in `docs/guide/`. Every ticked roadmap item gets a `docs/CHANGELOG.md` line in the same commit, tagged with its phase in italics.
- **Commits:** plain imperative sentences, no Conventional Commit prefixes.
- **Licence:** GPL-3.0-or-later. A new runtime dependency must have a GPL-3.0-compatible licence (MIT, BSD, Apache-2.0, LGPL, GPL); say which in the PR body.
- **Never commit** `.env*`, `node_modules/`, `.smoke/`, or any absolute local path (a user profile or workspace drive path). The repo is public, so anything committed is published.

## Won't

These stay out unless a new ADR in `docs/decisions/` says otherwise:

- Forking Chromium or BrowserOS, or switching the runtime away from Electron.
- A bundler, a TypeScript build step, React or any UI framework.
- A hosted backend, accounts, sync, or telemetry of any kind.
- Rebuilding what Project Hub or Cronsole already do. Integrate over their APIs or MCP servers.
- Writing an editor. The IDE pane embeds code-server or OpenVSCode Server.
- Workarounds that patch or monkey-patch Chrome extensions to make them run.
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
