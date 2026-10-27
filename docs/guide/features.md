<h1 align="center">✨ Features</h1>

<p align="center">
  <em>Each part of the window, in full.</em>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-guide-6B7280?style=for-the-badge" alt="Back to the guide"></a>
</p>

---

## 🌐 Browser

- Tabs, back, forward, reload, a context menu, and ↗ to open the page in your default browser.
- The address bar takes a URL, a `D:\` path, `localhost:3000`, or anything else as a search.
- Links open as tabs. A sign-in pop-up such as "Sign in with Google" gets its own small window, so it can hand the login back.
- ☆ in the address bar adds the page to Project Hub's favorites; click again to remove it.
- Chrome Web Store installs work in a tab. **Extensions** in the menu bar (Alt shows it) lists them, with Options, Web Store page and Remove.
- Ads and trackers are blocked by default: EasyList and EasyPrivacy through [Ghostery's adblocker](https://github.com/ghostery/adblocker) (MPL-2.0). **Extensions → Block ads and trackers** turns it off.

> [!WARNING]
> Extensions half-work. electron-chrome-extensions covers only part of the `chrome.*` API: offscreen documents, `action.setIcon` with image data and `declarativeNetRequest` are missing. LastPass and Rakuten work. Web Store ad blockers such as uBlock Origin Lite block nothing, which is why the app has its own. Details in [ADR-001](../decisions/adr-001-electron-shell.md#update-2026-10-27-the-user-agent).

## 💻 Terminals

- PowerShell 7 in tabs along the bottom. The ⌄ next to ＋ opens Windows PowerShell, Command Prompt or Git Bash instead.
- "Terminal here" on any sidebar folder opens one there.
- Web addresses in the output (`http(s)://…`, `localhost:3000`) open as a tab on click.
- Ctrl+C copies a selection and Ctrl+V pastes. Right-click copies a selection, or pastes when nothing is selected.
- Ctrl+L and Ctrl+R stay with PowerShell while the terminal has focus.

## 🧭 Workspaces

- Right-click a folder in Files and pick **Open as workspace**. The Files tree starts there, new terminals open there, and the workspace keeps its own tabs, terminals and chat conversations.
- The name at the top of the sidebar switches workspaces, or removes one. Removing never touches the folder.
- A switch closes the tabs and opens the other workspace's. Terminals keep running, hidden. A workspace's saved folders open as fresh shells, so nothing is ever re-run.
- **Default** is the whole Project Hub tree.
- Saved in `%APPDATA%\ai-command-center\workspaces.json`.

## ⚡ Command palette

- **Ctrl+K** opens one box over the open tabs and terminals, the workspaces, and every menu action with its shortcut.
- Once you type, files from the workspace's Files tree join the list.
- Every word you type has to match. ↑↓ pick, Enter goes, Esc or a click outside closes.

## 📁 Files

- Every workspace from Project Hub. A rescan by Hub shows up on its own.
- A click reads the file in a tab under the app's own sidebar: Markdown rendered by Hub, other text as code, images inline, folders as a listing. Clicking through files reuses that tab; Ctrl+click opens another.
- An HTML file opens as the page itself.
- Hover or right-click a row for Terminal here, View here, VS Code, Reveal in Explorer, Copy path, Copy Hub id and Open as workspace.

## 🔖 Bookmarks, 🕘 Recent and 🔍 Search

- **Bookmarks:** your Chrome, Edge or Brave bookmarks (Hub reads them from disk), or Hub's own favorites.
- **Recent:** pages, files and terminals you've opened.
- **Search** (Ctrl+Shift+F): one box across files, bookmarks and Recent.

## 🌿 Git

- The **Git** tab in the sidebar shows the active workspace's repo: its branch, the upstream it tracks and how far ahead or behind it is, then the changed files grouped as Conflicts, Staged, Changes and Untracked.
- Click a file to read its diff in a tab: additions in green, removals in red. A file with both staged and unstaged changes is listed in each group, and each opens its own diff.
- Read-only for now: nothing here stages, commits or pushes. **Refresh** asks git again, and opening the tab always does.
- The Default workspace has no folder of its own, so open a folder as a workspace first.

## 🚀 Dev servers

- The **Dev** tab lists the active workspace's dev scripts: `dev`, `start`, `serve`, `preview`, `watch` and variants like `dev:api` from its `package.json`. Other scripts aren't shown.
- Click a script (or **Start**) to run it with npm, pnpm or yarn, whichever the folder's lockfile names. It runs hidden, not in a terminal, with `BROWSER=none` so it doesn't open a window of its own.
- The row says *starting…* until the server prints a `localhost` or `127.0.0.1` address, then shows that address. Click it, or **Open**, for a tab on it.
- **Log** opens the server's output in a tab; reload the tab for newer lines. **Restart** stops and starts it again; **Stop** ends it and everything it started.
- Servers keep running when you switch workspaces and are listed under *Other workspaces*. Closing the app stops every server it started. It never stops a process it didn't start, such as a server you ran in a terminal.

## 🔌 Connections

- Click the dot next to "Houston" at the top of the sidebar, or pick **Connections** from the palette or the View menu.
- One row each for Project Hub, Cronsole, every shell the app knows, the chat model and the MCP server.
- Each row shows working, not set up or failing, a detail line, and what to set when it's missing.
- **Retry** checks one row again; **Check all** checks everything. A shell installed since the app started shows up on Retry, no restart needed.
- The chat row never calls the API (that would cost a request). It says the key is set, not that it works.

## 🤖 MCP, 💬 Chat and ⏱️ Cron

These have their own pages: [claude-code.md](claude-code.md), [chat.md](chat.md) and [cronsole.md](cronsole.md). The chat sits in its own pane on the right, so it stays open beside Files; 💬 or Ctrl+Shift+L shows and hides it.

---

<p align="center">
  <a href="setup.md">← Setup</a> ·
  <a href="claude-code.md">Next: Claude Code →</a>
</p>
