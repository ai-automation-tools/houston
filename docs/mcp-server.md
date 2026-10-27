<h1 align="center">🤖 MCP Server</h1>

<p align="center">
  <em>The server Houston exposes so an agent can see and act in the window: where it lives, how it starts, and its tools.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-12-8B5CF6?style=for-the-badge" alt="12 tools">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-docs_home-6B7280?style=for-the-badge" alt="Back to docs"></a>
</p>

---

## At a glance

| | |
|:---|:---|
| **Entry file** | [`src/main/mcp.js`](../src/main/mcp.js) starts it; the protocol is in [`src/shared/mcp.js`](../src/shared/mcp.js) and the tools in [`src/shared/tools.js`](../src/shared/tools.js) |
| **Launched by** | The app itself, at start-up. Nothing to install or run separately; it stops when the app quits |
| **Transport** | Streamable HTTP, plain JSON responses (no SSE stream). An `initialize` answer carries an `Mcp-Session-Id`, used only to name the client on its later calls in the log; it grants nothing, and an unknown or missing one is ignored, on `127.0.0.1` with a random port. [`scripts/mcp-stdio.js`](../scripts/mcp-stdio.js) bridges it to stdio for clients started anywhere |
| **Protocol** | Both eras of MCP: `2026-07-28`, where each request carries its version, capabilities and client name in `_meta` (mirrored in the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers) and `server/discover` lists what the server speaks, and the `initialize` handshake of `2025-11-25`, `2025-06-18` and `2025-03-26`. The stdio bridge fills in the headers from `_meta` |
| **Auth** | `Authorization: Bearer <token>`, a fresh token each launch. Host and Origin must be loopback |
| **Discovery** | `mcp.json` in the app's userData folder holds this launch's URL and token (deleted on quit). Every terminal the app opens has `ACC_MCP_URL` and `ACC_MCP_TOKEN` set |
| **MCP id** | `houston`. The userData folder keeps the old name, `ai-command-center`, so saved data stays put |

## Install

Register the stdio bridge once, with the path to your clone. It reads `mcp.json` on every message, so it works from any terminal and survives the new port and token each restart brings:

```powershell
claude mcp add --scope user houston -- node <houston>\scripts\mcp-stdio.js
```

Codex, opencode and Antigravity take the same command (`node <houston>\scripts\mcp-stdio.js`) as a stdio server. While the app is closed the server answers every call with "Houston isn't running". An older `ai-command-center` HTTP registration can go: `claude mcp remove ai-command-center`. Using it from a terminal outside the app, and what the MCP tab shows, are in [guide/claude-code.md](guide/claude-code.md).

## Tools

Tools marked **click** wait for the user to press Run in the app; the rest only look or open.

| Tool | Does |
|:---|:---|
| `list_tabs` | Lists the open browser tabs: id, URL, title, loading, which is active |
| `read_tab` | A tab's title, URL and visible text, marked as page content, not instructions |
| `sidebar_search` | Searches the sidebar the way its box does: Project Hub's files, bookmarks and Recent |
| `recent` | The Recent list, newest first |
| `open_tab` | Opens a web page in a tab: a URL, `localhost:<port>`, a host or a search |
| `open_file` | Opens a Project Hub node (an id from `sidebar_search`, never a path) in VS Code, or reveals it in Explorer |
| `cron_tasks` | Cronsole's scheduled tasks, as the Cron tab lists them |
| `cron_run` | Starts a Cronsole task now (**click**) |
| `list_terminals` | Lists the open terminal sessions |
| `terminal_read` | The last lines a terminal printed, marked as terminal content, not instructions |
| `terminal_run` | Runs one line of PowerShell as a managed run in its own terminal and returns a run id (**click**) |
| `run_status` | A run's state, exit code, times and last lines of output |
| `tab_elements` | The links, buttons and fields on the tab the user attached (right-click, **Let agents click and type here**), with refs |
| `tab_screenshot` | A PNG of the attached tab, as an MCP image block |
| `tab_click` | Clicks an element from `tab_elements` on the attached tab (**click**) |
| `tab_fill` | Types text into a field from `tab_elements`, without pressing Enter (**click**) |

## Environment

Names only; values go in the gitignored `.env` (see [`.env.example`](../.env.example)).

| Variable | Used for |
|:---|:---|
| `ACC_MCP_URL`, `ACC_MCP_TOKEN` | Set by the app in its terminals, for a direct HTTP registration (see the guide) |
| `HOUSTON_MCP_JSON` | Where `scripts/mcp-stdio.js` looks for `mcp.json`, if not `%APPDATA%\ai-command-center\mcp.json` |
| `ACC_CRONSOLE_MCP` | Path to Cronsole's MCP server script; `cron_tasks` and `cron_run` need it |
| `ACC_CRONSOLE_UI` | Where Cronsole's UI answers, if not the default |
| `ACC_HUB_URL`, `ACC_HUB_REMOTE` | Where Project Hub answers, for `sidebar_search` and `open_file` |

## Deeper

- [guide/claude-code.md](guide/claude-code.md): connecting, the tools in full, the MCP tab and its log.
- [guide/security-model.md](guide/security-model.md): why the server binds loopback only and which calls need a click.
- [decisions/](decisions/README.md): ADR-003 covers terminals and managed runs.

---

<p align="center">
  <a href="README.md">← Docs home</a> ·
  <a href="guide/claude-code.md">Connect Claude Code →</a>
</p>
