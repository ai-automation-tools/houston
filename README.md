<a id="readme-top"></a>

<h1 align="center">🧭 Houston</h1>

<p align="center">
  <em>One window for your browser, PowerShell, project files and bookmarks,<br>with an MCP server that lets an agent drive it.</em>
</p>

<p align="center">
  <a href="docs/README.md"><strong>Explore the docs »</strong></a>
  ·
  <a href="https://houston.ai-automation-tools.dev/"><strong>Homepage</strong></a> · <a href="https://houston-demo.ai-automation-tools.dev/"><strong>Try the demo »</strong></a>
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
  <img src="https://img.shields.io/badge/status-public_since_2026--10--18-2ea44f?style=for-the-badge" alt="Status: public since 2026-10-18">
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

> [!TIP]
> **[Try the demo](https://houston-demo.ai-automation-tools.dev/)** in any browser. Made-up data; nothing runs or calls out.

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
| [**🤖 MCP server**](docs/mcp-server.md) | Sixteen tools so Claude Code can see and act in the window, a tab you attach included, and what it asked to run and how that went |
| **💬 Chat** | Claude in a pane on the right, with the same tools; named, searchable conversations per workspace |
| **⏱️ Cron** | [Cronsole](https://github.com/ai-automation-tools/cronsole)'s scheduled tasks and their runs |
| **🌿 Git** | The workspace repo's branch and changed files, each diff a click away (read-only) |
| **🚀 Dev** | Start, open, restart and stop the workspace's `npm run dev` style servers, with their logs |
| **🔌 Connections** | Hub, Cronsole, shells, chat and MCP: working or not, and what to set |

The full tour is in [features.md](docs/guide/features.md).

## 🚀 Quick start

Needs Windows 11, Node.js 24, PowerShell 7 and a running [Project Hub](https://github.com/ai-automation-tools/project-hub).

```powershell
git clone https://github.com/ai-automation-tools/houston
cd houston
npm install
npm start
```

| Next | Where |
|:---|:---|
| Launcher, `settings.json`, where files live | [setup.md](docs/guide/setup.md) |
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
| Ctrl+plus / minus / 0 | Zoom |
| Ctrl+\` / Ctrl+Shift+\` | Toggle terminal / new terminal |
| Ctrl+Shift+F | Search everything |
| Ctrl+B | Toggle sidebar |
| Ctrl+Shift+L | Toggle chat |
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
| [**🧪 tests/**](tests/README.md) | Unit tests and the scripted launch check |
| **📜 scripts/** | Smoke run, lint, demo build, diagram build, launcher |
| [**🤖 AGENTS.md**](AGENTS.md) | Rules for agents working in this repo (`CLAUDE.md` imports it) |
| [**🛡️ SECURITY.md**](SECURITY.md) | Reporting a vulnerability; the full model is in [security-model.md](docs/guide/security-model.md) |

## ⚖️ Licence

GPL-3.0-or-later, because the Chrome extension library is GPL. See [LICENSE](LICENSE) and [ADR-001](docs/decisions/adr-001-electron-shell.md#consequences).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<p align="center">
  Part of <a href="https://github.com/ai-automation-tools">ai-automation-tools</a> · Built on <a href="https://www.electronjs.org">Electron</a>, <a href="https://xtermjs.org">xterm.js</a>, <a href="https://github.com/samuelmaddock/electron-browser-shell">electron-chrome-extensions</a> · <a href="LICENSE">GPL-3.0-or-later</a> · <a href="docs/README.md">Docs</a>
</p>
