<h1 align="center">🎯 Product Spec</h1>

<p align="center">
  <em>What the app has to do, how you'd know, and what it deliberately won't do.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/source-decisions%2Frequirements.md-8B5CF6?style=for-the-badge" alt="Source: decisions/requirements.md">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-product-6B7280?style=for-the-badge" alt="Back to product"></a>
</p>

---

Condensed from [requirements.md](../decisions/requirements.md), which has the reasoning for each ranking. This project didn't come through the pipeline's ideate stage, so there's no business plan behind it; the requirements are the source.

This page covers the workbench. The agent harness added on 2026-11-12 has its own requirements, acceptance criteria and Won't list in [harness-requirements.md](harness-requirements.md).

## Musts

| Story | Accepted when |
|:---|:---|
| **Browse in the app.** As a developer, I want tabs and an address bar in the same window as my terminal, so that I stop switching to Chrome for docs and dashboards. | Typing a URL, a `D:\` path, `localhost:<port>` or a search loads the right page in the active tab. Links and pop-ups open as tabs. Back, forward and reload work. |
| **A terminal where I'm looking.** As a developer, I want a PowerShell 7 terminal that opens in the folder I picked in the sidebar, so that I don't `cd` by hand. | "Terminal here" on a sidebar folder opens `pwsh` with that working directory. Several terminals can be open at once. |
| **Every project in one tree.** As a developer, I want every workspace in the sidebar, so that I can open any file in one or two clicks. | The Files panel shows Project Hub's tree. A file opens as a document in a tab under the app's own sidebar (rendered by Hub; VS Code from its menu), an HTML file in a tab. When Hub is down the panel says so and offers Retry. |
| **One search.** As a developer, I want one box that searches files, bookmarks and recent items, so that I don't need to remember where something lives. | Every word must match; name matches rank first; results appear within half a second of typing. |
| **An agent can drive the window** *(Phase 2)*. As a developer, I want Claude to open tabs and files and run terminal commands through an MCP server, so that one agent works across the browser, the terminal and my files. | The MCP server binds `127.0.0.1` only, refuses calls without its per-launch token, asks before running a command, and logs every call. |
| **Chat inside the app** *(Phase 2)*. As a developer, I want a chat panel wired to that server, so that I don't need a separate window to drive it. | A message in the panel can open a tab, open a file, and run a confirmed command. |
| **The agent can see what it did** *(Phase 2b)*. As a developer, I want the agent to read a terminal's output and a tab's text, so that "run the tests and tell me what failed" works in one message. | `terminal_read` returns the last lines of a session with escapes stripped; `read_tab` returns a tab's visible text, marked as untrusted; neither needs a click. Anything that acts (a Cronsole task) waits for the click like a command. |

## Shoulds

- Recent pages, files and terminals, kept across restarts.
- Bookmarks from the user's Chrome, Edge or Brave profile.
- Cronsole's task list and UI inside the app.
- Tabs reopen after a restart.
- The browser basics: cycle and pick tabs from the keyboard, reopen a closed tab, zoom, find in page.
- A crash log a stranger can paste into a bug report.

## Won't

- Fork Chromium or BrowserOS.
- A hosted backend, accounts, sync or telemetry.
- Rebuild Project Hub, Cronsole or an editor.
- Patch Chrome extensions to make them run.
- macOS or Linux builds in this version.

## Non-functional

| | Target |
|:---|:---|
| Platform | Windows 11, PowerShell 7 |
| Network | No listening ports except the MCP server on loopback |
| Untrusted content | Tabs sandboxed with no preload from this app but the extension-API ones, which act only on `chrome-extension://` pages, and (with ad blocking on) Ghostery's cosmetic-filter preload, which asks main for the CSS that hides ad slots; IPC refuses any sender but the shell; page permission requests (camera, microphone, location, notifications and the rest) denied by default |
| Cold start | Window and terminal usable within a few seconds; the Hub tree may take about 12 s on a cold Hub |

---

<p align="center">
  <a href="README.md">← Product</a> ·
  <a href="build-plan.md">Next: Build plan →</a>
</p>
