<h1 align="center">🚀 Setup</h1>

<p align="center">
  <em>Install, run, configure, and where the app keeps its files.</em>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-guide-6B7280?style=for-the-badge" alt="Back to the guide"></a>
</p>

---

## Prerequisites

- Windows 11
- [Node.js](https://nodejs.org) 24
- [PowerShell 7](https://github.com/PowerShell/PowerShell)
- A running [Project Hub](https://github.com/ai-automation-tools/project-hub). Its README is a two-minute setup: point it at your project folders and start it. It listens on `http://127.0.0.1:4273`.

## Install and run

```powershell
Invoke-RestMethod http://127.0.0.1:4273/api/health   # Project Hub answers
git clone https://github.com/ai-automation-tools/houston
cd houston
npm install                                          # node-pty ships prebuilt binaries; no compiler needed
npm start
```

- `npm install` on npm 11 asks before running install scripts. `node-pty` is already approved in `package.json`.
- If Electron's binary didn't download, run `node node_modules/electron/install.js`.
- Without Project Hub the app still runs. The browser, terminals and extensions work; Files and Bookmarks say Hub isn't reachable and offer Retry.

## Start without a terminal

`scripts\Start-AICommandCenter.ps1` starts the app with no console window and writes Electron's output to `logs\launch.out.log` and `launch.err.log`. Point a shortcut or Start menu entry at:

```text
pwsh -NoProfile -WindowStyle Hidden -File <repo>\scripts\Start-AICommandCenter.ps1
```

`-Quit` asks the running app to quit, as File → Quit does, instead of starting it: closing the window only hides it to the tray. It saves the session and ends the terminals; the Core and its agent sessions keep running. With no app running it does nothing.

## Settings

Per-machine settings live in `%APPDATA%\ai-command-center\settings.json` (another [profile](features.md#-profiles)'s in `profiles\<id>\settings.json` under it). You only need it if the defaults don't fit:

```json
{
  "hubUrl": "http://127.0.0.1:4273",
  "quickLinks": [
    { "label": "Project Hub", "url": "http://127.0.0.1:4273" },
    { "label": "Chrome Web Store", "url": "https://chromewebstore.google.com" }
  ],
  "newsSources": [
    { "label": "Some AI blog", "url": "https://blog.example.com/feed.xml" },
    { "label": "Weekly digest", "url": "D:/notes/ai-digest.md" }
  ],
  "feedIndex": "D:/feeds/index.json"
}
```

| Key | Means |
|:---|:---|
| `hubUrl` | Where Project Hub answers. `ACC_HUB_URL` in the environment overrides it. It must be on this machine unless `ACC_HUB_REMOTE=1` is set. If Hub runs with an access token (`HUB_TOKEN`), put the same value in `ACC_HUB_TOKEN` in `.env`: it's sent only to a Hub on this machine or over https. |
| `quickLinks` | The links on a new tab, after its Settings button; also set in **Settings › Start and new tab**. http(s) only, twelve at most. |
| `feedIndex` | The Feed tab's and start page's `index.json`, an absolute path; none by default. Its shape: `categories` (each an `id`, `name` and `definition`) and `items` (each an `id`, `category`, `title`, http(s) `url`, and optionally `summary`, `date`, `highlight: true`, `mcp: { name, command, transport }` and `advisory: { tool, severity, summary }`); the full shape is at the top of [`src/shared/feed.js`](../../src/shared/feed.js). |
| `newsSources` | The News tab's sources, none by default: each a label and an RSS or Atom feed, a Markdown page (http or https), or an absolute path to a local `.md` file. Twelve at most. |

**Settings › Browser** and **Settings › Sources** edit these four keys for you and refuse a value Houston can't use; other keys in the file are left as they are. Broken values fall back to the defaults. The chat key, the model and Cronsole's path go in the clone's `.env` instead (see [chat.md](chat.md) and [cronsole.md](cronsole.md)).

## Where the app keeps things

Everything lives under `%APPDATA%\ai-command-center`.

| File or folder | Holds |
|:---|:---|
| `workspaces.json` | Workspaces, their tabs and terminal folders |
| `layout.json` | Splitter sizes, terminal and chat pane open or not, bookmark source, ad blocking on or off |
| `recent.json` | The Recent list |
| `runs.json` | The last 50 `terminal_run` runs: command, folder, result, changed files and output |
| `chats\<workspace>\` | That workspace's chat conversations: `index.json` and one file each |
| `mcp.json` | This launch's MCP address and token; deleted on quit |
| `logs\app.log` | Crashes and errors in the app's own processes |
| `logs\extensions.log` | Errors from extension workers and popups |
| `logs\mcp.log` | Every MCP call, one JSON line each |
| `logs\launch.*.log` | Electron's output when started by the launcher |

Installed extensions and site data sit in the same folder.

---

<p align="center">
  <a href="README.md">← Guide</a> ·
  <a href="features.md">Next: Features →</a>
</p>
