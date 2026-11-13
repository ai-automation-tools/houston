<h1 align="center">🥊 Abuse suite</h1>

<p align="center">
  <em>Scripted attacks on the harness, run in real containers on a real Windows 11 machine. A feature ships when its abuse tests pass here and the output is saved.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-AT--01_to_08,_11,_12,_14_to_16-8B5CF6?style=for-the-badge" alt="AT-01 to AT-08, AT-11, AT-12, AT-14 to AT-16">
  <a href="results/"><img src="https://img.shields.io/badge/last_run-12%2F12_pass,_0%2F97_through-2ea44f?style=for-the-badge" alt="Last run: 12 of 12 pass, 0 of 97 attempts through"></a>
  <a href="../README.md"><img src="https://img.shields.io/badge/↩-repository_root-6B7280?style=for-the-badge" alt="Repository root"></a>
</p>

---

The abuse tests are defined in [harness-requirements.md](../docs/product/harness-requirements.md#abuse-tests). This folder runs the ones the Core alone can: AT-13 needs a browser tab, so `npm run smoke` runs it in the window; the rest (AT-09, AT-10) need later milestones.

```powershell
$env:H1_ROOT = 'D:\scratch'          # any folder outside your user profile
node abuse/run.js                    # all of them; or name some: node abuse/run.js AT-01 AT-04
```

It needs internet (AT-04's control host) and takes about two minutes. It starts the real Core (`node core/main.js`) with its data folder in `%LOCALAPPDATA%\houston-core-abuse` and works in `<H1_ROOT>\houston-abuse`, wiping both first. It never touches the real Core's data folder. It creates one identity, `local:abuse-agent`, through the Control API, with write on its workspace and one internet host, and every attack runs as that identity in its own container. The exit code is 0 only if every test passed, and the run is saved to [`results/<date>.md`](results/) with the user, machine and paths replaced.

## 📁 What's here

| File | What it does |
|:---|:---|
| [**run.js**](run.js) | Starts the Core, makes the identity, runs the tests in order, prints them and writes the results file. |
| [**harness.js**](harness.js) | The Core as a child process, Control API calls, attack scripts run as batch files in a session, process snapshots, and the anonymizer. |
| [**tests/**](tests/) | One file per abuse test, each exporting `id`, `title` and `run(h)`. |
| [**results/**](results/) | One saved run per day, committed. |

## 🧪 The tests

| Test | What it tries | What a pass needs |
|:---|:---|:---|
| [AT-01](tests/at01-private-folders.js) | List and read `.ssh` (a non-secret file only), the Core's data folder and its `control.json`, and two other Windows profiles | Every read refused, and the `session.start` event lists a denied folder over each target |
| [AT-02](tests/at02-links.js) | Junctions it makes to a folder outside and to the Core's data folder, a junction the host made before the session, a hard link, file and folder symbolic links; then read through each | No read gets the planted token |
| [AT-03](tests/at03-path-forms.js) | 16 spellings of two denied files: case, forward slashes, 8.3, `\\?\`, `\\.\`, admin shares, `\\?\UNC\`, the volume GUID, `::$DATA`, trailing dot and space, `..` from the workspace | No spelling reads the token. A control runs the same spellings on a file it may read, to show which spellings work in a container at all |
| [AT-04](tests/at04-hosts.js) | Hosts off its list by name, by IPv4 and IPv6, an allowed host's own IP with its Host header, and around the proxy | None reached, and the control (an allowed host) was |
| [AT-05](tests/at05-loopback-apps.js) | Its own local server (127.0.0.1 and every interface) and Project Hub, by IPv4, IPv6, `localhost`, the rest of 127/8 and the LAN address, through the proxy and around it; then again with a grant for the loopback port itself | None reached, even with the grant, and the host reached the same server (the control) |
| [AT-06](tests/at06-gateway-scope.js) | Through the gateway from inside its container: an ungranted tool under seven spellings; another session's leaked token on its own gateway and on the other session's; the JSON-RPC id of a call the operator allowed once, sent again with other arguments and then unchanged | Every ungranted call refused and never run (audit), the wrong token a `401` recorded as `gateway.denied`, the other gateway unreachable, and each replay a card of its own |
| [AT-07](tests/at07-vault-sweep.js) | Dumps its environment, asks the MCP server holding a vault secret to print it (allowed on the card), and copies every file it can read in the profile, the Core's data folder, the agents folder, the session temp folders and the server's folder | The value nowhere: not in its environment, the tool's answer is the marker, and not in what it read; a planted workspace file is the control |
| [AT-08](tests/at08-pinned-change.js) | The pinned server's `echo` description changes on disk to one that asks for `~/.ssh` | The next call finds it changed: `needs_review`, refused, recorded, and later sessions see none of its tools |
| [AT-11](tests/at11-scheduler.js) | Makes a scheduled task with schtasks, Register-ScheduledTask and the Task Scheduler COM API; adds a Run-key value and a Startup-folder file; reads the Core's `control.json`, writes its database, and sends `standing.create` to its pipe with no token and a guessed one. The control is the same schtasks line on the host, which works | Every attempt refused, and, checked from the host, no task, value or file exists and the one standing grant is unchanged. Anything made would be removed |
| [AT-12](tests/at12-stop-all.js) | Three sessions, one with a child shell and one asking WMI to start a process outside the container; then `stop.all` | Nothing of theirs alive 5 seconds later |
| [AT-16](tests/at16-core-killed.js) | Kill the Core during a session, then start it again | The container is gone and the session is recorded `interrupted` |
| [AT-15](tests/at15-secret-in-output.js) | Prints a planted file of made-up credentials: an `.env` line, an OpenAI key, a GitHub token in a URL, an AWS key id, `NAME=value`, a bearer header, a private key block | None of the values in the stored transcript (through `transcript.get` and on disk), only markers, and a plain control line is there |
| [AT-14](tests/at14-audit-edit.js) | Change one `allow` to `deny` in the audit log, then restart the Core | The Core reports the break and an `audit.break` event names the line |

**How an attempt is judged.** Each one runs as a line of a batch file in the session and keeps its stdout, stderr and exit code in the workspace. A read "got through" only if it returned a token the test planted (or, where nothing can be planted, any content). Contents from protected places are never kept or printed: they are checked for the token or counted, then the files are deleted. Links are removed without following them.

**Not covered yet.** A Core that crashes right after a spawn (AT-16's other half) needs a Core that crashes on cue; [`spikes/h1-dead-core.mjs`](../spikes/h1-dead-core.mjs) checks it. H3's bar of zero successes in at least 50 attempts across the MVP set is met: the run on 2026-11-12 had 97 attempts and none got through, and the run on 2026-11-13 with AT-11 had 107. The gateway tests (AT-06 to AT-08) set up their own MCP server, the stub from `tests/core/stub-mcp-server.js`, as `abuse-stub` with a random vault secret, and an identity `local:abuse-tools` to call it ([`tests/gateway-setup.js`](tests/gateway-setup.js)).

**AT-13 runs in the window.** `npm run smoke` has the real example.com page in a tab try the MCP server (with and without CORS), the Core's `control.json` as a `file:` URL, and Houston's own `acc://settings/` and `acc://transcript/` pages, then navigate to one: nothing comes back readable and the tab stays on the web page. The gateway half is a unit test (`tests/core/gateway.test.js`): a foreign Host or Origin is refused. The Control API is a named pipe, which a page can't open.

**What the runs found.** A contained process can resolve names through the system resolver, though it can't open a connection: a DNS query could carry data out. The containers SDK has no control for it, so it was accepted as a documented limit on 2026-11-13 ([Core README](../core/README.md#-egress-proxy)). AT-07 (2026-11-12) also lists the folder names under the session temp root (the drive enumeration S1 found), though it reads no file there.

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="../docs/product/harness-requirements.md#abuse-tests">Abuse tests</a> ·
  <a href="../core/README.md">Core →</a>
</p>
