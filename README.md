<a id="readme-top"></a>

<h1 align="center">🧭 Houston</h1>

<p align="center">
  <em>One window for your browser, PowerShell, project files and bookmarks,<br>with an MCP server that lets an agent drive it.</em>
</p>

<p align="center">
  <a href="docs/README.md"><strong>Explore the docs »</strong></a>
  ·
  <a href="https://houston.ai-automation-tools.dev/"><strong>Homepage</strong></a>
</p>

<p align="center">
  <a href="https://github.com/ai-automation-tools/houston">GitHub</a>
  ·
  <a href="docs/ROADMAP.md">Roadmap</a>
  ·
  <a href="docs/CHANGELOG.md">Changelog</a>
  ·
  <a href="docs/decisions/README.md">Decisions</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-public_·_harness_build-8B5CF6?style=for-the-badge" alt="Status: public, harness build">
  <img src="https://img.shields.io/badge/runs_on-Windows_11-0078D4?style=for-the-badge" alt="Runs on Windows 11">
  <a href="docs/ROADMAP.md"><img src="https://img.shields.io/badge/plan-ROADMAP-8B5CF6?style=for-the-badge" alt="Roadmap"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-2ea44f?style=for-the-badge" alt="License: GPL-3.0-or-later"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-45.0-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 45.0">
  <img src="https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/xterm.js-6.0-000000?style=flat-square" alt="xterm.js 6.0">
  <img src="https://img.shields.io/badge/node--pty-1.1-6B7280?style=flat-square" alt="node-pty 1.1">
  <img src="https://img.shields.io/badge/PowerShell-7-5391FE?style=flat-square&logo=powershell&logoColor=white" alt="PowerShell 7">
</p>

---

Houston (formerly AI Command Center) is a Windows desktop app: a browser, PowerShell terminals and your project folders in one window.
An agent (Claude Code, or Claude in the sidebar) can drive it, and runs nothing without your click.

> [!NOTE]
> **Where this is going.** From 2026-11-12 the repo was private while Houston grew into an agent harness; it is public again since 2026-11-27: every agent runs as a named identity inside an OS container, reaches tools and credentials only through a local gateway, and leaves an audit trail. Under [`core/`](core/README.md), milestone H1 built the Core: its database, audit log, policy check, launch defaults, egress proxy, the runner that starts a contained session for an identity, the identity registry and the Control API, checked against real containers and started at logon by [a Scheduled Task](docs/guide/core-at-logon.md). H2, the first slice in the window, is under way: Connections shows the Core, Claude Code and Codex start from [backend manifests](core/README.md#-backends) with a sign-in home of each identity's own, and the **Agents** tab starts an identity in a contained terminal tab; a request under an *ask* grant waits on an approval card in the window, and **Stop All** (a button that's always on screen, and Ctrl+Shift+Backspace) ends every session at once. The **Logs** tab reads the audit log by identity, session and decision, and opens each session's transcript, redacted before the Core wrote it; **Settings** shows every control with its scope. H3 is done: each contained session reaches MCP servers only through [the Core's gateway](core/README.md#-mcp-gateway), which runs each server in a container of its own (or, for Houston's own server and Cronsole's, outside one and marked so) from a tool list the operator pinned and checks every call, and [a vault](core/README.md#-vault) gives those servers their credentials and never an agent; the **Integrations** tab installs, pins and disables servers. H4 waits only on its first nightly job's 5 nights: a [standing grant](core/README.md#-standing-grants) lets a scheduled task run one identity unattended (`harness run --grant <id>`), a command or a Claude Code or Codex prompt, and the first real nightly job runs on one; contained sessions see none of the user's environment variables. H5 is done: the **Identity Center** shows every identity with its grants, sessions, review dates and what it can reach, and the Agents tab suspends, activates, retires and reviews them. **Profiles** keep workstreams apart: each has its own identities, MCP servers, secrets, settings, workspaces and browser storage, and the 🧭 menu switches between them. An agent with the right grant can start **sub-agents**, which get no more than it has and end when it does. H6 is done: Roundtable seats each agent as its own identity, skills come from Promptbook and are attached by grant, profile memory waits for your review, local models are reached through each session's own relay, and a **Feed** tab and start page show advisories for what you have installed. H5 also brought a **quarantine** profile, which holds an untrusted MCP server to one folder, no secrets and the hosts you name, and **broad-access** identities run outside a container, marked everywhere. Hardening and release readiness (H7) are under way: the abuse suite is a release gate, schema upgrades are tested with a backup first, and a profile exports and restores without its secrets. The plan is [harness-requirements.md](docs/product/harness-requirements.md) and [ADR-004](docs/decisions/adr-004-core-companion-process.md); the spikes that tested it are [here](docs/decisions/spikes/2026-11-12-h0-spike-results.md); progress is on the [roadmap](docs/ROADMAP.md#agent-harness). Everything below describes the app as it runs today. The earlier public repo is archived as `houston-legacy`. The browser demo, the harness window on made-up data, is at <https://houston-demo.ai-automation-tools.dev/>.

> [!WARNING]
> Chrome extensions mostly work: LastPass and Rakuten do, MV3 ad blockers don't. [Details](docs/guide/features.md#-browser).

## ✨ Features

| Part | What it does |
|:---|:---|
| **🌐 Browser** | Tabs, extensions, built-in ad blocking |
| **💻 Terminals** | PowerShell 7, Windows PowerShell, Command Prompt or Git Bash, in tabs |
| **🧭 Workspaces** | A folder with its own tabs, terminals and chat |
| **⚡ Command palette** | Ctrl+K: actions, tabs, terminals, workspaces and files in one box |
| **📁 Files** | Every project from [Project Hub](https://github.com/ai-automation-tools/project-hub), opened in a tab |
| **🔖 Bookmarks · 🕘 Recent · 🔍 Search** | Your browser's bookmarks, what you opened, one search over all of it |
| **📰 News** | Headlines from the RSS, Atom or Markdown sources you list in `settings.json` |
| [**🤖 MCP server**](docs/mcp-server.md) | Sixteen tools so Claude Code can see and act in the window, a tab you attach included, and what it asked to run and how that went |
| **💬 Chat** | Claude in a pane on the right, with the same tools; named, searchable conversations per workspace |
| **⏱️ Cron** | [Cronsole](https://github.com/ai-automation-tools/cronsole)'s scheduled tasks and their runs, with a Docs filter for the docs upkeep jobs |
| **🌿 Git** | The workspace repo's branch and changed files, each diff a click away (read-only) |
| **🚀 Dev** | Start, open, restart and stop the workspace's `npm run dev` style servers, with their logs |
| **📜 Logs** | The harness's audit log: what each agent did and what was decided, by identity, session and decision; each session's transcript, secrets redacted |
| **🛡 Agents** | The harness's agent identities: start one (Claude Code, Codex or a plain shell) in a contained terminal tab, open or stop its sessions |
| **⚙️ Settings** | Every control with its scope (global, profile, workspace, session), what it's set to and where to change it |
| **🩺 Health** | Every check in one page (the Core's audit chain and storage too), and a diagnostics bundle saved on this machine with your user folder and keys scrubbed |
| **🔌 Connections** | The harness's Core, Hub, Cronsole, shells, chat and MCP: working or not, and what to set |

The full tour is in [features.md](docs/guide/features.md).

## 🚀 Quick start

Needs Windows 11, Node.js 24, PowerShell 7 and a running [Project Hub](https://github.com/ai-automation-tools/project-hub).

```powershell
git clone https://github.com/ai-automation-tools/houston
cd houston
npm install
pwsh -NoProfile -File scripts\Register-HoustonCore.ps1 -StartNow   # the harness's Core, started at logon from now on
npm start
```

| Next | Where |
|:---|:---|
| Launcher, `settings.json`, where files live | [setup.md](docs/guide/setup.md) |
| The Core at logon: check, stop or remove it | [core-at-logon.md](docs/guide/core-at-logon.md) |
| Set up the MCP server in any client | [mcp-server.md](docs/mcp-server.md) |
| Connect Claude Code | [claude-code.md](docs/guide/claude-code.md) |
| Turn on the Chat tab | [chat.md](docs/guide/chat.md) |
| Show Cronsole's tasks | [cronsole.md](docs/guide/cronsole.md) |
| Put two agents in a debate, a podcast or a collaboration | [Roundtable](https://github.com/ai-automation-tools/roundtable): its web page in a browser tab, each agent's CLI in a terminal tab |

## ⌨️ Shortcuts

| Keys | Does |
|:---|:---|
| Ctrl+K | Command palette |
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | New tab / close tab / reopen tab |
| Ctrl+Tab / Ctrl+1 … 9 | Next tab / that tab |
| Alt+D | Address bar |
| Ctrl+F | Find in page |
| Ctrl+S | Save page as (web pages) |
| Ctrl+plus / minus / 0 | Zoom |
| Ctrl+\` / Ctrl+Shift+\` | Toggle terminal / new terminal |
| Ctrl+Shift+F | Search everything |
| Ctrl+B | Toggle sidebar |
| Ctrl+Shift+L | Toggle chat |
| Ctrl+Shift+Backspace | Stop All: end every contained agent session (also the red button on the address bar, and the tray menu) |
| Ctrl+, | Settings: every control and its scope |
| F12 / Ctrl+Shift+I | Page devtools / shell devtools |

## 🧪 Checks

```powershell
npm run lint; npm test; npm run smoke
```

How to contribute: [contributing.md](docs/guide/contributing.md).

## 🗂️ What's in here

| Folder | What's inside |
|:---|:---|
| [**📖 docs/guide/**](docs/guide/README.md) | How to set up and use the app |
| [**📚 docs/**](docs/README.md) | Roadmap, changelog, design decisions, architecture diagram |
| [**🧩 src/**](src/README.md) | The app's code |
| [**🛡️ core/**](core/README.md) | The harness's Core process, H1 done: SQLite database and single-instance lock, hash-chained audit log, policy check with canonical Windows paths, container launch defaults, the per-session egress proxy, the runner, the identity registry and the Control API on a named pipe. The data contracts are in [`core/schemas/`](core/schemas/). H2 adds backend manifests, the session terminal stream, the approval inbox and redacted transcripts; the window's Agents and Logs tabs and Stop All drive it. H3 adds the MCP gateway and the vault, which the Integrations tab drives. H4 adds standing grants and the `harness run` CLI for scheduled tasks |
| [**🥊 abuse/**](abuse/README.md) | The abuse suite: scripted attacks on the Core in real containers (AT-01 to AT-16; AT-13 through `npm run smoke`), run by hand with `node abuse/run.js`; each run is saved in `abuse/results/`, and `npm run gate` holds a release until a full run on the current code passes |
| **🧪 spikes/** | Scripts run by hand against the real container SDK: the H0 spikes (`s1` to `s5`) and the milestone checks (`h1-*` to `h4-*`). Nothing imports them |
| [**🧪 tests/**](tests/README.md) | Unit tests and the scripted launch check |
| **📜 scripts/** | Smoke run, lint, demo build, diagram build, launcher |
| [**🤖 AGENTS.md**](AGENTS.md) | Rules for agents working in this repo (every agent CLI reads it, Claude Code included) |
| [**🛡️ SECURITY.md**](SECURITY.md) | Reporting a vulnerability; the full model is in [security-model.md](docs/guide/security-model.md) |

## ⚖️ Licence

GPL-3.0-or-later, because the Chrome extension library is GPL. See [LICENSE](LICENSE) and [ADR-001](docs/decisions/adr-001-electron-shell.md#consequences).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<p align="center">
  Part of <a href="https://github.com/ai-automation-tools">ai-automation-tools</a> · Built on <a href="https://www.electronjs.org">Electron</a>, <a href="https://xtermjs.org">xterm.js</a>, <a href="https://github.com/samuelmaddock/electron-browser-shell">electron-chrome-extensions</a> · <a href="LICENSE">GPL-3.0-or-later</a> · <a href="docs/README.md">Docs</a>
</p>
