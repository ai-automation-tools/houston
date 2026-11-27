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

This page is the app as it runs today. The agent harness (identities, OS containers, a gateway, a vault, audit) is planned in [ADR-004](../decisions/adr-004-core-companion-process.md) and partly built under [`core/`](../../core/README.md) (audit log, policy check, launch defaults, egress proxy, session runner, identity registry, Control API, backend manifests); the window's Agents tab asks the Core to start sessions (below). What the spikes showed a container can and cannot do is in the [spike results](../decisions/spikes/2026-11-12-h0-spike-results.md).

## Web pages

- Browser tabs are sandboxed. Their only preloads are the extension-API ones, which act only on `chrome-extension://` pages, and, with ad blocking on, Ghostery's cosmetic-filter preload, which asks the main process for the CSS that hides ad slots.
- Tabs can't navigate to `javascript:`, `data:` or the app's own protocols.
- A local file opens only from a drive of this machine (`file:///C:/…`). A `file:` address with a server in it (`file://server/share`) is refused for every request, a page's image as much as a navigation: Windows would sign in to that server and send your password hash. Folders show as a plain list of links.
- Houston's own interface (the sidebar, tab bar, chat and terminals) runs without Chromium's sandbox, because the extensions toolbar needs it. It loads only its own files and runs only its own scripts; your secrets live in the Core, never in the window.
- A page gets no permission it asks for (camera, microphone, location, notifications, MIDI, screen capture, clipboard reads, USB, serial, HID) except fullscreen, pointer lock and sanitized clipboard writes. Without a handler, Electron would grant all of them.
- Every IPC channel checks the sender is the shell UI's main frame.
- **Settings › Project Hub** adds a folder to Project Hub only by a path on a drive of this machine. A network path is refused before Hub hears of it: scanning one would have Hub sign in to that server with your Windows account. Hub refuses its own deny-list (credential folders) and a whole drive too.
- Houston never opens or runs a download. It saves each one to your Downloads folder under a name that overwrites nothing, and the file keeps Windows' mark of the web, so SmartScreen and Office's Protected View still treat it as from the internet. **Show in folder** only selects the file in Explorer, and only for a download Recent got from the main process; the interface can't add one.

## Document and run pages

- `acc://doc/…` pages are served to the sandboxed tabs only, run no scripts (`default-src 'none'`), can't be framed, and can't be reached from a web page. Every page of this kind also says `Cross-Origin-Resource-Policy: same-origin`, so a web page that asks for one with no referrer never gets the answer.
- Only files in Project Hub's index are served, so a crafted address can't read anything else.
- A Cronsole run page (`acc://run/…`) has the same policy, opens only from the sidebar, and shows the run's output as text.
- A Git diff page (`acc://git/…`) does too, and is served only for a file `git status` lists right now with that kind of change.
- A dev server's log page (`acc://dev/…`) does too, and is served only for a server this run of the app started.
- A `terminal_run` run's log page (`acc://runlog/…`) does too, and is served only for a run in the history.

## Terminals and agents

- Each shell is a fixed executable with fixed arguments. The UI chooses only a starting folder and a shell by name.
- A right-click in a terminal never pastes on its own: with nothing selected it opens a menu whose **Paste** item shows the clipboard's first line and how many lines it has, and only a click on it sends them to the shell.
- `terminal_run` starts nothing until you click Run. Then the main process opens a PowerShell terminal for that command alone, in the folder the bar named. Its arguments are a fixed script; the command reaches it in an environment variable that only the main process sets and the script removes, so the shell still never takes arguments from an agent or the UI.
- The main process keeps the command and folder from the moment it asks. The click only says yes or no.
- A run's result is its exit code, never its output. Closing its tab while it runs ends it and every process it started, found by the pid the app started, never by name.
- Newlines, control characters and invisible characters are refused, so the bar shows exactly what runs. Unanswered asks expire after 5 minutes.
- The Agents tab's sessions are the Core's, not the app's. The window names an identity or a session and nothing else; the folder is the active workspace's and the command is the identity's backend manifest or a fixed `cmd.exe`. The Core checks the identity and its grants and runs the session in an OS container, which can't read your profile, reach other local apps, or connect anywhere its grants don't list. Its terminal reaches the window over the Core's named pipe, never a port.
- An *ask* grant's request waits in the Core until you answer its card. The window only shows the card and sends back once, session or deny; the Core holds the request and denies it when the 2 minutes run out or the session ends, so a closed or hung window can only ever deny. Every ask and answer is in the audit log.
- Each contained session's terminal is kept as a transcript in the Core's data folder, which only you can read. Secrets with a recognisable shape (API keys, tokens, `NAME=value` passwords, private keys) are replaced with a marker before it's written, never after; every value stored in the vault is also replaced, by exact match, whatever its shape. Transcripts are capped at 100 MB each, and transcripts and the audit log together at 5 GB: past that, the oldest finished transcripts go first and only then the oldest whole audit segments, each deletion itself an audit event. Deleting or exporting logs is yours alone, from `npm run ctl` (`transcript.delete`, `audit.prune`, `log.export`); the window can only read them.
- **Stop All** (the address bar's red button, Ctrl+Shift+Backspace, or the tray menu) has the Core end every session it runs, with no confirm. All three run it in the main process, not the page, and the tray needs no page at all, so a hung window can't hold it up. It's audited as one `stop.all` event, then each session's end. Each session's gateway token dies with the session, so Stop All revokes them too, and it pauses every standing grant first, so no scheduled run starts until you resume it.
- A contained session starts with only Windows' own environment variables, never yours: API keys and tokens you keep as user environment variables don't reach it.
- A local model is reached only through the session's own relay, with its token and a grant for that port; the container still can't touch anything else on loopback.
- What an agent remembers reaches another session only after you approve it, and never crosses profiles.
- A skill reaches a session only after you install it and attach it with a grant, read-only, and not at all if its files changed since you installed it. A tool result telling an agent to send your files somewhere still runs into the network policy (AT-09).
- A sub-agent never holds more than the session that started it: the Core gives it only what the parent's grants cover, and stops it when the parent ends.
- A quarantine profile is where an untrusted MCP server goes: contained, without secrets, with one folder and the hosts you name, and nothing unattended.
- A broad-access identity is the exception you choose: it runs outside any container, with your own access, and Houston marks it everywhere so you never mistake it for a contained one. It runs unattended only if you switch that on for it.
- Profiles keep workstreams apart. A session reaches only its own profile's MCP servers, a server gets only its own profile's secrets, no grant opens any profile's folder, and each profile's browser storage is its own.
- A contained session reaches MCP tools only through the Core's gateway, at the address and token in its own environment (`HOUSTON_MCP_URL`, `HOUSTON_MCP_TOKEN`). The token works only for that session, on that session's own port, and stops when it ends. Only a server you registered, ran once and pinned by its tool list serves; if its tools change, it's held for review and refused. Each call is checked against the identity's grants before the server hears of it, an *ask* waits on a card showing the tool and its arguments, and results come back with vault values redacted, marked as untrusted, and capped at 1 MB. Every call is in the audit log. Most servers run in a container of their own; two can't and are marked unconfined: Houston's own MCP server, which the gateway reaches over loopback with a token it keeps in the vault, and Cronsole's, which runs on the host with only its own token in its environment. Their tools still need your grant, call by call.
- A contained process can resolve names, though it can connect nowhere off its list: Windows answers lookups through its DNS Client service, outside the container, so egress rules never see them (its own `nslookup`, which sends packets itself, times out). The containers SDK has no DNS control: its network rules match addresses and ports only. This is a known limit: a lookup could carry a little data out to a name server someone controls, but brings nothing in except addresses the container still can't connect to.
- Each MCP server runs in a container of its own, as its own identity (`local:mcp/<name>`), with only the folders, hosts and secrets you grant that identity. It never runs inside the agent's container.
- Secrets live in the Core's vault: encrypted with Windows DPAPI plus a key only the Core holds, in its data folder. Nothing reads a value back out: the Control API can set, list and delete, and `npm run ctl -- secret.set` reads the value from a pipe or hidden typing, never the command line. A server gets a secret in its environment only with a `secret:` grant; an agent never gets one, and each hand-over is logged without the value.
- A Claude Code or Codex identity signs in to a folder of its own (`%LOCALAPPDATA%\houston-agents`), never your own `.claude` or `.codex`, so it can read its own sign-in and nothing of yours: not your MCP servers' tokens, hooks or history.

## The MCP server

- It's the app's only listening port: `127.0.0.1` only, a random port and a fresh token each launch (in `mcp.json`, deleted on quit). A call without the token is refused.
- Every call, answered or refused, is logged to the MCP tab and `logs\mcp.log`: one JSON line each, arguments clipped to 300 characters, rotated at 5 MB.
- `open_file` takes Hub node ids, never paths, and can't open a file with its default app, so an agent can't launch a script that way.
- `read_tab` and `terminal_read` carry whatever is on screen. Their descriptions tell the model it's content, not instructions.
- Project Hub is reached over loopback from the main process.
- The News tab fetches only the sources `settings.json` lists, from the main process with Node's fetch (no browser cookies), with a 15 s deadline and a 2 MB cap. Only a plain-text title and an http(s) link come out of each item; the sidebar shows the title as text and opens the link as an ordinary tab.

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
