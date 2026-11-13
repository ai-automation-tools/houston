<h1 align="center">✨ Features</h1>

<p align="center">
  <em>Each part of the window, in full.</em>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-guide-6B7280?style=for-the-badge" alt="Back to the guide"></a>
</p>

---

## 🪟 Window and tray

- Closing the window hides Houston to the system tray; terminals, dev servers and the MCP server keep running. Click the tray icon to bring it back.
- Right-click the tray icon for **Show Houston**, **Close to tray** and **Quit Houston**. Untick **Close to tray** there, or under **File** (Alt shows the menu), and ✕ quits instead. **File → Quit** always quits.

## 🌐 Browser

- Tabs, back, forward, reload, a context menu, and ↗ to open the page in your default browser.
- The address bar takes a URL, a `D:\` path, `localhost:3000`, or anything else as a search.
- As you type, it lists matching pages from Recent and your bookmarks (Project Hub's favorites and the Bookmarks tab's source). ↑ and ↓ pick one, Enter opens it, Escape closes the list; with none picked, Enter goes to what you typed.
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

## 📰 News

The **News** tab lists headlines from the sources in `settings.json`'s `newsSources` ([setup.md](setup.md#settings)), newest first, each link once. A source can be an RSS or Atom feed, a Markdown page on the web, or a local `.md` file such as a weekly AI digest or a bookmarks note: every `[title](https://…)` link in it becomes a headline, and a `## 2026-10-30` heading dates the links under it. Click a headline to open it in a tab (Ctrl+click or middle-click for a background tab). The sources are fetched when you first open the tab and again on **Refresh**; one that fails says why at the top while the rest still show.

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

## 🛡 Agents

The **Agents** tab is the harness's: it lists the agent identities in the [Houston Core](core-at-logon.md) and the contained sessions each one has running. It needs the Core running; otherwise it says so.

- Each row is an identity that could run (not retired), with what it runs: Claude Code, Codex, or a plain contained shell (`cmd.exe`) for an identity with no backend. One that can't start says why: suspended, still a draft, or its CLI isn't installed. Hover a row for its id and, for a CLI, how to sign in the first time.
- **Start** asks the Core for a session in the active workspace's folder and opens it as a terminal tab marked 🛡 with the identity's name. The Core decides: the identity needs a write grant on that folder, and if something's missing the refusal shows as a message. The session can reach only what its grants allow ([core/README.md](../../core/README.md)); your toolchain folders are on its `PATH`, which grants nothing by itself.
- Running sessions sit under their identity. **Open** shows one in a tab (its recent output first), **Show** brings forward the tab that already has it, and **Stop** ends it. Closing its tab stops it too.
- Sessions belong to the Core. Closing Houston closes their tabs, which stops them; one started elsewhere (`npm run ctl`) and never opened in a tab keeps running and shows here.
- **Approvals.** When a grant says *ask* (`effect=ask`), the session's request waits and a card shows above the terminals: which identity, exactly what it wants (`connect to example.com:443`), in which workspace, and how long until it's denied on its own (2 minutes). **Allow once** lets that request through, **Allow for this session** lets it and the same request again until the session ends, and **Deny** refuses it; Deny has the focus, so a stray Enter can't allow anything. Several waiting show one at a time, oldest first, with a count. The Core holds them, so closing Houston just lets them time out as denied.
- **Stop All.** The red **⏹ Stop All** button at the right end of the address bar, **Ctrl+Shift+Backspace**, or **Stop all agent sessions** in the tray menu ends every session the Core is running, at once and without asking (it's the emergency stop). A note in the corner says how many it stopped. Your own terminals, dev servers and browser tabs are left alone. If the window itself hangs, the tray menu still works: it goes straight to the Core. So does `npm run ctl -- stop.all`.
- Identities and grants are made with `npm run ctl` for now ([Backends](../../core/README.md#-backends)); the Identity Center comes later on the [roadmap](../ROADMAP.md).

## 📜 Logs

The **Logs** tab is the Core's audit log: what each agent identity did and what was decided, newest first. It needs the Core running.

- Pick an identity, a session (the recent ones, by who and when they started) or a decision (allowed, asked, denied) to narrow it. It shows the newest 300 that match and says when there are more.
- Each row is the event and what it acted on, such as `egress.connect example.org:443` or `approval.decided example.org:443 (deny)`, with who and when. Green allowed, amber asked, red denied; hover for the reasons.
- Click a row for the whole event as the Core wrote it. **Only this session** (on hover) narrows to that row's session.
- **Transcript** (on hover, on a session's start and end rows) opens what that session's terminal showed as a page: plain text, with keys, tokens and passwords already replaced by `[REDACTED:…]` when the Core wrote it. A transcript keeps up to 100 MB; past 5 GB in all, the oldest go first. The page shows the newest 1 MB.
- It only reads. The log itself is `audit/` in the Core's data folder, a hash chain the Core checks at every start ([core/README.md](../../core/README.md)).

## ⚙️ Settings

⚙ at the right of the address bar, **Ctrl+,** or **Settings** in the palette opens a page listing every control, grouped by scope:

| Scope | What it means | Examples |
|:---|:---|:---|
| Global | One per install; nothing overrides it | Hard denies, Stop All, the audit log, transcript limits, the approval timeout |
| Profile | Belongs to a profile; there's one until profiles arrive | Agent identities and grants, Project Hub, workspaces, quick links, news sources, chat |
| Workspace | Saved with the active workspace | Its folder, tabs, terminals and conversations |
| Session | Lives as long as one agent session | Allow once and allow for this session; running sessions |

Each row says what it's set to now and where it's changed (a menu, a tab, `settings.json`, `.env`, or `npm run ctl`). The page only shows; change a control where its row says. Reload the tab to read it again.

## 🔌 Connections

- Click the dot next to "Houston" at the top of the sidebar, or pick **Connections** from the palette or the View menu.
- One row each for the Houston Core, Project Hub, Cronsole, every shell the app knows, the chat model and the MCP server.
- The **Houston Core** row shows the containment its sessions run in and how many run. *Not running* says how to start it ([core-at-logon.md](core-at-logon.md)); *running older code than the app* means the Core was started before a `git pull`, so restart its task.
- Each row shows working, not set up or failing, a detail line, and what to set when it's missing.
- **Retry** checks one row again; **Check all** checks everything. A shell installed since the app started shows up on Retry, no restart needed.
- The chat row never calls the API (that would cost a request). It says the key is set, not that it works.

## 🤖 MCP, 💬 Chat and ⏱️ Cron

These have their own pages: [claude-code.md](claude-code.md), [chat.md](chat.md) and [cronsole.md](cronsole.md). The chat sits in its own pane on the right, so it stays open beside Files; 💬 or Ctrl+Shift+L shows and hides it.

## 🎨 Light and dark

- The window follows Windows' light or dark app mode (Settings → Personalization → Colors), as document pages do. The terminal stays dark either way.

---

<p align="center">
  <a href="setup.md">← Setup</a> ·
  <a href="claude-code.md">Next: Claude Code →</a>
</p>
