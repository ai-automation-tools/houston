<h1 align="center">🥊 Abuse suite</h1>

<p align="center">
  <em>Scripted attacks on the harness, run in real containers on a real Windows 11 machine. A feature ships when its abuse tests pass here and the output is saved.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-AT--01_to_04,_12,_14,_16-8B5CF6?style=for-the-badge" alt="AT-01 to AT-04, AT-12, AT-14, AT-16">
  <a href="results/"><img src="https://img.shields.io/badge/last_run-7%2F7_pass-2ea44f?style=for-the-badge" alt="Last run: 7 of 7 pass"></a>
  <a href="../README.md"><img src="https://img.shields.io/badge/↩-repository_root-6B7280?style=for-the-badge" alt="Repository root"></a>
</p>

---

The abuse tests are defined in [harness-requirements.md](../docs/product/harness-requirements.md#abuse-tests). This folder runs the ones H1 can: the rest need the gateway (H3), standing grants (H4) or the window (H2).

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
| [AT-12](tests/at12-stop-all.js) | Three sessions, one with a child shell and one asking WMI to start a process outside the container; then `stop.all` | Nothing of theirs alive 5 seconds later |
| [AT-16](tests/at16-core-killed.js) | Kill the Core during a session, then start it again | The container is gone and the session is recorded `interrupted` |
| [AT-14](tests/at14-audit-edit.js) | Change one `allow` to `deny` in the audit log, then restart the Core | The Core reports the break and an `audit.break` event names the line |

**How an attempt is judged.** Each one runs as a line of a batch file in the session and keeps its stdout, stderr and exit code in the workspace. A read "got through" only if it returned a token the test planted (or, where nothing can be planted, any content). Contents from protected places are never kept or printed: they are checked for the token or counted, then the files are deleted. Links are removed without following them.

**Not covered yet.** A Core that crashes right after a spawn (AT-16's other half) needs a Core that crashes on cue; [`spikes/h1-dead-core.mjs`](../spikes/h1-dead-core.mjs) checks it. The MVP bar of "zero successes in at least 50 attempts" across the MVP set waits for the gateway's tests (H3); this run has 57 attempts and the tests above.

**What the runs found.** A contained process can resolve names through the system resolver, though it can't open a connection: a DNS query could carry data out. Recorded on the roadmap under H3.

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="../docs/product/harness-requirements.md#abuse-tests">Abuse tests</a> ·
  <a href="../core/README.md">Core →</a>
</p>
