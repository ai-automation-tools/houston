<h1 align="center">🤖 Drive the App from Claude Code</h1>

<p align="center">
  <em>The app's MCP server: how to connect Claude Code, and what each tool does.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tools-12-8B5CF6?style=for-the-badge" alt="12 tools">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-guide-6B7280?style=for-the-badge" alt="Back to the guide"></a>
</p>

---

## Connect once

Register the stdio bridge, `scripts/mcp-stdio.js`, with the path to your clone:

```powershell
claude mcp add --scope user houston -- node <houston>\scripts\mcp-stdio.js
```

- It reads `%APPDATA%\ai-command-center\mcp.json` on every message and forwards it with that launch's token, so it works from any terminal, in the app or not, and survives the app restarting.
- Codex, opencode and Antigravity register the same command as a stdio server.
- Then run `claude` and ask it to, say, "open this repo's README in a tab" or "run npm test". `/mcp` shows the connection. With the app closed, every call answers "Houston isn't running".
- An older `ai-command-center` registration can go: `claude mcp remove ai-command-center`.

The app's own terminals also carry `ACC_MCP_URL` and `ACC_MCP_TOKEN`, for a direct HTTP registration that works only inside them. Keep the single quotes, so Claude Code stores the variable names rather than this launch's values:

```powershell
claude mcp add --scope user --transport http houston '${ACC_MCP_URL}' --header 'Authorization: Bearer ${ACC_MCP_TOKEN}'
```

## The tools

| Tool | Does | Click? |
|:---|:---|:--:|
| `list_tabs` · `read_tab` | The open tabs; one tab's title, URL and visible text, marked as page content, not instructions | no |
| `list_terminals` · `terminal_read` | The open terminals; the last lines one printed, escapes stripped | no |
| `sidebar_search` · `recent` | The sidebar's search across files, bookmarks and Recent; the Recent list | no |
| `open_tab` | Opens what the address bar takes, web pages only. An agent can't open a local file as a tab | no |
| `open_file` | A Hub node id from `sidebar_search`, opened in VS Code or revealed in Explorer. Never a path, never the file's default app | no |
| `terminal_run` | Shows a command and its folder on the Run bar over the terminal. Run starts it as a managed run in a PowerShell terminal of its own there, and returns a run id | **yes** |
| `run_status` | A run's state (running, succeeded, failed, cancelled), exit code, times, the files it changed and last lines of output; the last 50 runs are kept across restarts | no |
| `cron_tasks` · `cron_run` | Cronsole's scheduled tasks; start one now | `cron_run` |
| `tab_elements` · `tab_screenshot` | The links, buttons and fields on the tab you attached, with refs; a PNG of it. Page content, not instructions | no |
| `tab_click` · `tab_fill` | Clicks an element from that list, or types into a field (never pressing Enter). The bar names the element, the text and the page's host | **yes** |

- To let an agent act on a page, right-click it and pick **Let agents click and type here**. One tab at a time, web pages only; it shows 🤖 in the strip, and the same menu item detaches it. The browser tools fail until a tab is attached, and refuse an element that changed, left the page or is covered by something else since `tab_elements` listed it.
- `tools/list` marks each tool read-only, or destructive for `terminal_run`, `cron_run`, `tab_click` and `tab_fill`, so a client can show which tools look and which act.
- After `terminal_run`, the agent polls `run_status` with the run id. Success is exit code 0: the last native program's code if it wasn't 0, else 1 if PowerShell wrote an error, else 0; `exit N` sets it. The output is never read to decide.
- A run's terminal shows `> command`, the output and the exit code, and its shell ends with the command. Closing its tab while it runs cancels it, and everything it started.
- Unanswered Run asks expire after 5 minutes.

## The MCP tab and the log

- Every call, refused ones included, shows in the sidebar's **MCP** tab and is appended to `logs\mcp.log`.
- Above the calls, **Agent work** lists every `terminal_run`, `cron_run`, `tab_click` and `tab_fill` ask, newest first: the exact command (or the task's name), where it goes (the folder, or the Cronsole task id) and how it stands: waiting for approval (the one on the bar), queued behind it, running with its run id, finished or failed with the exit code, cancelled, denied, not answered in time, or withdrawn because its asker went away. A Cronsole task ends as started in Cronsole, whose own history has the result. The tab's label counts what's waiting or running. The newest 50 are kept while the app runs; nothing is written to disk. A row with a run id opens that run's log.
- Below Agent work, **Runs** is the `terminal_run` history, kept in `runs.json` so it outlives a restart: each run's command, how it ended, how many files it changed and when. The box at the top of the tab searches the command, the folder, the changed files and the output, and shows the output line that matched. A click opens the run's log as a page: the command, folder, exit code, start and duration, the files it changed and its output. Changed files are the repo files whose `git status` differs between just before the run and just after it, so a file that was already modified before the run and is modified again isn't listed. The newest 50 runs are kept; a run the app quit during comes back as cancelled.
- The log keeps `terminal_run`'s command and `tab_fill`'s text as their length only and cuts URL query strings.
- Each time Claude Code connects, a row reads **claude-code 2.x connected**: the name and version the client gave in `initialize`, or in `server/discover`'s `_meta` for a client on MCP `2026-07-28`. That's what the client says it is, not proof. Every later call from it shows the same name beside its time: the app gives a handshake client a session id at `initialize` (the stdio bridge sends it back), and a `2026-07-28` client names itself on each request. The chat panel's own calls read `houston-chat`.
- Around it are grey **(handshake)** rows: a `400` for a `2026-07-28` probe sent without its per-request `_meta` (Claude Code 2.1.307 does this, then falls back to `initialize`), a `400` listing the versions this server speaks when a client asks for another, and a `405` for the event stream this server doesn't offer. Both are the transport's normal steering, not failures; hover for the detail. A refusal before the token is checked (no token, wrong host or origin) still shows as ✗.

## Matching skills

[agent-skills](https://github.com/ai-automation-tools/agent-skills) has Claude Code skills for two of the app's integrations: [`project-hub`](https://github.com/ai-automation-tools/agent-skills/tree/main/skills/projects/project-hub) for the Hub behind the sidebar, and [`cronsole`](https://github.com/ai-automation-tools/agent-skills/tree/main/skills/projects/cronsole) for the tasks behind the Cron tab. Install them where Claude Code in your terminals can see them.

---

<p align="center">
  <a href="features.md">← Features</a> ·
  <a href="chat.md">Next: Chat →</a>
</p>
