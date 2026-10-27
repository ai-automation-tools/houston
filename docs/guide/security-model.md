<h1 align="center">🔒 Security Model</h1>

<p align="center">
  <em>What a web page, an agent and the app's own processes can and can't do.</em>
</p>

<p align="center">
  <a href="../../SECURITY.md"><img src="https://img.shields.io/badge/report-SECURITY.md-e74c3c?style=for-the-badge" alt="Report a vulnerability"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/↩-guide-6B7280?style=for-the-badge" alt="Back to the guide"></a>
</p>

---

The rules every change has to keep are in [AGENTS.md](../../AGENTS.md)'s security invariants. To report a problem, see [SECURITY.md](../../SECURITY.md).

## Web pages

- Browser tabs are sandboxed. Their only preloads are the extension-API ones, which act only on `chrome-extension://` pages, and, with ad blocking on, Ghostery's cosmetic-filter preload, which asks the main process for the CSS that hides ad slots.
- Tabs can't navigate to `javascript:`, `data:` or the app's own protocols.
- A page gets no permission it asks for (camera, microphone, location, notifications, MIDI, screen capture, clipboard reads, USB, serial, HID) except fullscreen, pointer lock and sanitized clipboard writes. Without a handler, Electron would grant all of them.
- Every IPC channel checks the sender is the shell UI's main frame.

## Document and run pages

- `acc://doc/…` pages are served to the sandboxed tabs only, run no scripts (`default-src 'none'`), can't be framed, and can't be reached from a web page.
- Only files in Project Hub's index are served, so a crafted address can't read anything else.
- A Cronsole run page (`acc://run/…`) has the same policy, opens only from the sidebar, and shows the run's output as text.
- A Git diff page (`acc://git/…`) does too, and is served only for a file `git status` lists right now with that kind of change.
- A dev server's log page (`acc://dev/…`) does too, and is served only for a server this run of the app started.
- A `terminal_run` run's log page (`acc://runlog/…`) does too, and is served only for a run in the history.

## Terminals and agents

- Each shell is a fixed executable with fixed arguments. The UI chooses only a starting folder and a shell by name.
- `terminal_run` starts nothing until you click Run. Then the main process opens a PowerShell terminal for that command alone, in the folder the bar named. Its arguments are a fixed script; the command reaches it in an environment variable that only the main process sets and the script removes, so the shell still never takes arguments from an agent or the UI.
- The main process keeps the command and folder from the moment it asks. The click only says yes or no.
- A run's result is its exit code, never its output. Closing its tab while it runs ends it and every process it started, found by the pid the app started, never by name.
- Newlines, control characters and invisible characters are refused, so the bar shows exactly what runs. Unanswered asks expire after 5 minutes.

## The MCP server

- It's the app's only listening port: `127.0.0.1` only, a random port and a fresh token each launch (in `mcp.json`, deleted on quit). A call without the token is refused.
- Every call, answered or refused, is logged to the MCP tab and `logs\mcp.log`: one JSON line each, arguments clipped to 300 characters, rotated at 5 MB.
- `open_file` takes Hub node ids, never paths, and can't open a file with its default app, so an agent can't launch a script that way.
- `read_tab` and `terminal_read` carry whatever is on screen. Their descriptions tell the model it's content, not instructions.
- Project Hub is reached over loopback from the main process.

## Processes and data

- The Git tab runs `git` itself, read-only: fixed command lines through `execFile`, no shell, in the workspace's repo, with the scrubbed environment the terminals get. It runs the `git.exe` found on PATH's absolute entries, never a bare `git`, which Windows would look for in the repo folder first. Every call turns off fsmonitor hooks, external diff tools and textconv drivers. A file path reaches git only after `--`, and only when git just listed it.
- The Dev tab runs a script only when you click it, only one its workspace's `package.json` names as a dev script, and only with a plain name (letters, digits and `:._-`), since it goes on cmd's command line. The package manager runs by its full path from PATH, in the workspace's folder, with the terminals' scrubbed environment. The renderer names a script, never a folder or a command. Stop and Restart end a process tree by the pid the app was given when it started it, and only while that process still runs, so a reused pid is never touched. No MCP tool starts or stops one.
- Cronsole's MCP server is the only other process the app starts on its own, besides the terminals and the dev servers you start: the app's own Electron binary running the script `ACC_CRONSOLE_MCP` names, which only `.env` or your environment can set. It talks over stdio and listens on nothing.
- The app calls only Cronsole's read-only `list_tasks`, `get_task_history` and `get_run_output`, plus `run_task` for a task you clicked Run for. The task id never comes from the click, only the yes.
- The chat key goes only to `api.anthropic.com`. It's never sent to the shell UI or written to disk.
- The chat's tool calls go through the MCP server with its token, so they're logged and confirmed like any other agent's.
- Claude's replies and the context tray's attachments are shown as plain text, never HTML.
- Crashes go to `logs\app.log` and extension errors to `logs\extensions.log`, nowhere else. No telemetry.

---

<p align="center">
  <a href="cronsole.md">← Cronsole</a> ·
  <a href="contributing.md">Next: Contributing →</a>
</p>
