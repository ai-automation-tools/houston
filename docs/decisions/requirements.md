<h1 align="center">📋 Requirements</h1>

<p align="center">
  <em>Every feature in the build prompt, ranked must, should or later, with the reason.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/phase-0-8B5CF6?style=for-the-badge" alt="Phase 0">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-decisions-6B7280?style=for-the-badge" alt="Back to decisions"></a>
</p>

---

Source: the original build prompt, kept outside this repo. Ranked on 2026-09-29, after a business analysis (also kept outside the repo) found 13 of these 16 features already run on this machine in some form. That finding drives most of the rankings below: where a tool already exists, the app's job is to host or link it, not to rebuild it.

## The four pillars

| Pillar | Rank | Why |
|:---|:---|:---|
| **🌐 Browser** | Must | Weighted highest in the prompt. It's the pillar a pinned-tab setup already does well, so the app has to match a real browser or it's a step back. |
| **💻 Terminal** | Must | PowerShell 7 with Git and the CLI agents (`claude`, `codex`) is where most work starts. |
| **🤖 Agent harness** | Must, from Phase 2 | The reason for one app rather than a tidy desktop. Without it this is a browser with a terminal attached. |
| **🧑‍💻 IDE** | Should | VS Code already works and Project Hub already opens files in it. Embedding it saves a window switch, not a capability. |

## Features

| Feature | Rank | Phase | Why |
|:---|:---|:--:|:---|
| **Tabs, address bar, back/forward** | Must | 1 | Minimum for a browser. |
| **LastPass and Rakuten** | Must | 1 | The prompt calls it a hard gate. Phase 1 opens with a spike on it. **Result: failed at first; both work since 2026-10-27.** See [ADR-001](adr-001-electron-shell.md#spike-result-2026-09-29). |
| **PowerShell 7 terminal, multiple tabs** | Must | 1 | |
| **Terminal starts in the folder you're looking at** | Must | 1 | The one thing a separate Windows Terminal can't do from the sidebar. |
| **📁 File explorer (Project Hub)** | Must | 1 | Hub already scans every workspace; reuse it ([ADR-002](adr-002-hub-over-http.md)). |
| **🔖 Bookmarks explorer** | Must | 1 | Hub already reads Chrome, Edge and Brave bookmark files, plus its own favorites. |
| **🕘 Recent** | Should | 1 | Cheap once files, pages and terminals go through one process. |
| **🔍 Search across files, bookmarks, recent** | Should | 1 | The analysis found nothing on this machine searches across tools. |
| **🎛️ Control Center MCP server** | Must | 2 | Lets an agent drive the app: open tabs and files, run a terminal command, trigger a Cronsole task. |
| **💬 Direct chat panel** | Must | 2 | The chat surface for that agent. |
| **⏱️ Cronsole integration** | Should | 2 | Cronsole has a UI and an MCP server already. Phase 2 surfaces both; it doesn't rebuild scheduling. |
| **🧑‍💻 Embedded IDE pane** | Should | 3 | code-server or OpenVSCode Server in a pane. VS Code outside the app covers it until then. |
| **📚 Docs auto-upkeep view** | Later | 3 | Four scheduled jobs already keep the docs current. A view over their reports is enough. |
| **📱 Phone chat channel** | Later | 3 | Claude Remote Control and the Hermes Telegram bots already reach this machine from a phone. |
| **📰 AI news headlines** | Later | 3 | The Library publishes weekly AI digests; a panel that reads them is small. |
| **🔗 AI bookmarks feed** | Later | 3 | Same: the Library's monthly link lists. |

## Non-functional

| Requirement | Target |
|:---|:---|
| **Platform** | Windows 11, PowerShell 7, no WSL. |
| **Network exposure** | Nothing listens on a port. Hub is reached over loopback from the main process; the MCP server in Phase 2 binds `127.0.0.1` only and needs a token. |
| **Secrets** | None in the repo. Extensions and site data live in `%APPDATA%\ai-command-center`. |
| **Untrusted pages** | Browser tabs are sandboxed, get no preload from this app but the extension-API ones, which act only on `chrome-extension://` pages, and (with ad blocking on) Ghostery's cosmetic-filter preload, which asks main for the CSS that hides ad slots, and every IPC channel refuses any sender but the shell. |
| **Cold start** | Window and terminal usable within a few seconds; the Hub tree may take ~12 s on a cold Hub scan. |

---

<p align="center">
  <a href="README.md">← Decisions</a> ·
  <a href="architecture-options.md">Next: Architecture options →</a>
</p>
