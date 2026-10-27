<h1 align="center">🔭 Upstreams</h1>

<p align="center">
  <em>What the app depends on outside this repo, what the code assumes about each, and where to check.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/checked-biweekly-8B5CF6?style=for-the-badge" alt="Checked biweekly">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-docs_home-6B7280?style=for-the-badge" alt="Back to docs"></a>
</p>

---

Every external service, protocol, SDK and platform Houston depends on, what the code
assumes about each, and where to check whether that assumption still holds. The biweekly
**AI-Command-Center Upstream Check** routine (`upstream/auto-*` PRs) works from this file. Keep it
current by hand too: a new outbound call or a new runtime dependency is a new row.

**Last checked** is filled in by the routine, and only with a date it actually read the source.
`—` means never checked.

## Protocols and APIs

| Upstream | What the code assumes | Code | Check at | Last checked |
|:---|:---|:---|:---|:---|
| **Anthropic Messages API** *(chat panel)* | `POST https://api.anthropic.com/v1/messages` with `anthropic-version: 2026-10-21` and `stream: true`; the reply is server-sent events that `readStream` puts back into content blocks (`text`, `tool_use`), with `tool_result` blocks sent back. The key comes from `ACC_CHAT_API_KEY` or `ANTHROPIC_API_KEY`, the model from `ACC_CHAT_MODEL` or `ANTHROPIC_MODEL`; there is no default model ID | `src/shared/chat.js`, `src/main/chat.js` | platform.claude.com/docs/en/api/versioning; platform.claude.com/docs/en/build-with-claude/streaming; platform.claude.com/docs/en/about-claude/model-deprecations; platform.claude.com/docs/en/api/migration-2026-10-21 | 2026-10-27 |
| **Model Context Protocol** *(the app is an MCP server)* | Hand-written JSON-RPC 2.0 over HTTP on `127.0.0.1` with a per-launch bearer token. Dual-era: revision `2026-07-28` per request (`_meta` `io.modelcontextprotocol/protocolVersion` and `clientCapabilities`, the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers checked against the body, `server/discover`, `resultType` and `serverInfo` in every result's `_meta`, errors `-32020` and `-32022`, 404 for an unknown method), and `initialize` answering `2025-11-25`, `2025-06-18` or `2025-03-26` (echoing the client's if listed); also `ping`, `tools/list` (with `readOnlyHint` / `destructiveHint` / `openWorldHint` annotations) and `tools/call` returning `content` plus `structuredContent` | `src/shared/mcp.js`, `src/main/mcp.js` | modelcontextprotocol.io/specification (latest revision and changelog); github.com/modelcontextprotocol/modelcontextprotocol/releases | 2026-10-23 |
| **Cronsole's MCP server** *(stdio child process)* | Started from the path in `ACC_CRONSOLE_MCP` on the app's own Electron binary with `ELECTRON_RUN_AS_NODE=1`; speaks newline-delimited JSON-RPC over stdio; the app calls only `initialize`, `list_tasks`, `get_task_history` (`structuredContent.runs`: `id`, `status`, `triggeredAt`, `durationMs`, `log`, `platformRunId`), `get_run_output` (its text) and `run_task` (with an id from that list), and reads `CRONSOLE_TOKEN` / `CRONSOLE_API_URL` from the environment | `src/main/cronsole.js`, `src/shared/cronsole.js` | github.com/ai-automation-tools/cronsole (`mcp-server/`, README, releases) | — |
| **Project Hub HTTP API** *(loopback, default `http://127.0.0.1:4273`)* | `GET /api/health`, `/api/scan`, `/api/webmarks`, `/api/file`, and `/api/open`; sent from the main process with Node's `fetch`, so no `Sec-Fetch-Site` header reaches Hub's same-origin guard. 30 s timeout. `/api/favorites` is read with `GET` and written whole with `PUT` (the address-bar star). The `/api/events` server-sent stream (`event: change` after a rescan, `: ping` heartbeat every 25 s) is subscribed once and reconnected when it drops | `src/main/hub.js`, `src/main/docs.js`, `src/shared/tree.js`, `src/shared/docs.js`, `src/shared/events.js`, `src/shared/favorites.js`, `src/shared/settings.js` | github.com/ai-automation-tools/project-hub (`server` routes, README, releases) | — |
| **Chrome Web Store** | `https://chromewebstore.google.com` is a default quick link; `electron-chrome-web-store` makes its "Add to Chrome" button install into the browse session and runs `updateExtensions` at start | `src/shared/settings.js`, `src/main/extensions.js` | developer.chrome.com/docs/extensions/develop/migrate (Manifest V2 to V3 timeline); github.com/samuelmaddock/electron-browser-shell/releases | 2026-10-22 |

## Runtime and platform

| Upstream | What the code assumes | Code | Check at | Last checked |
|:---|:---|:---|:---|:---|
| **Electron** | `^45.0.0`; one `BaseWindow`, a shell `WebContentsView` plus a sandboxed `WebContentsView` per tab; `ELECTRON_RUN_AS_NODE` for Cronsole's server; the main process runs ESM | `src/main/*.js`, `package.json`, `scripts/smoke.js` | releases.electronjs.org/release/stable; electronjs.org/docs/latest/tutorial/electron-timelines (supported majors) | 2026-10-27 |
| **Ad blocking** | `@ghostery/adblocker-electron` `^2.20.1` (MPL-2.0) and its prebuilt ads-and-tracking engine, downloaded from Ghostery's CDN and cached in `adblock-engine.bin` for a week; it holds the browse session's only `webRequest` `onBeforeRequest`/`onHeadersReceived` listeners | `src/main/adblock.js`, `src/main/main.js` | github.com/ghostery/adblocker/releases | 2026-10-22 |
| **Chrome extension support** | `electron-chrome-extensions` `^4.9.0` and `electron-chrome-web-store` `^0.13.0` (GPL-3.0); `adm-zip` is pinned to `^0.6.1` by `overrides` in `package.json` because of a transitive advisory | `src/main/extensions.js`, `package.json` | github.com/samuelmaddock/electron-browser-shell/releases; github.com/advisories (adm-zip) | 2026-10-22 |
| **node-pty** | `^1.1.0`; prebuilt N-API binaries and the bundled `conpty.dll` on Windows; `pty.spawn(file, args, …)` with a fixed shell per profile; install scripts allowed only for `node-pty@1.1.0` (`allowScripts`) | `src/main/terminal.js`, `src/shared/shells.js`, `package.json` | github.com/microsoft/node-pty/releases | 2026-10-22 |
| **xterm.js** | `@xterm/xterm` `^6.0.0` and `@xterm/addon-fit` `^0.11.0`, loaded by the shell renderer and the demo | `src/renderer/`, `src/demo/`, `package.json` | github.com/xtermjs/xterm.js/releases | 2026-10-22 |
| **Git** | The `git` on PATH, any recent version: `rev-parse --show-toplevel`, `status --porcelain=v2 --branch -z` (v2 format, `# branch.*` headers), and `diff` with `--no-ext-diff`, `--no-textconv`, `--cached` and `--no-index` against `/dev/null`; `-c core.fsmonitor=false -c diff.external=` on each | `src/main/git.js`, `src/shared/git.js` | git-scm.com/docs/git-status (porcelain v2); github.com/git/git/tree/master/Documentation/RelNotes | 2026-10-22 |
| **PowerShell 7** | Terminal profiles launch fixed executables with fixed arguments; Windows is the only target | `src/shared/shells.js` | github.com/PowerShell/PowerShell/releases | 2026-10-22 |
| **Node.js** | CI runs Node 24 on `ubuntu-latest` and `windows-latest`; tests use `node:test`, no TypeScript build | `.github/workflows/ci.yml`, `package.json` | nodejs.org/en/about/previous-releases (EOL dates) | 2026-10-22 |

## CI and hosting

| Upstream | What the code assumes | Where | Check at | Last checked |
|:---|:---|:---|:---|:---|
| **GitHub Actions** | `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-pages-artifact@v3`, `actions/deploy-pages@v4`; Dependabot raises the grouped bumps | `.github/workflows/ci.yml`, `.github/workflows/pages.yml` | github.com/actions/setup-node/releases; github.com/actions/deploy-pages/releases | 2026-10-22 |
| **GitHub Pages** | The demo (`npm run demo` into `_site/`) is deployed by `pages.yml` to `https://houston-demo.ai-automation-tools.dev/` on every push to `main` | `.github/workflows/pages.yml`, `scripts/demo.js` | docs.github.com/en/pages; github.blog/changelog | — |
| **npm audit** | The CI `audit` job runs `npm audit --omit=dev` and must stay green | `.github/workflows/ci.yml` | docs.npmjs.com/cli/commands/npm-audit | 2026-10-22 |

Flag breaking majors, EOL runtimes, protocol revisions and security advisories only. Routine bumps
are Dependabot's job. `src/demo/` makes no network calls and has no upstream.

---

<p align="center">
  <a href="README.md">← Docs home</a> ·
  <a href="ROADMAP.md">Roadmap →</a>
</p>
