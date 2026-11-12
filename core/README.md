<h1 align="center">🛡️ Core</h1>

<p align="center">
  <em>The harness's companion process. It will launch agents, decide policy, hold secrets and write audit; today it starts, locks and migrates its database, keeps a hash-chained audit log, answers policy checks, and starts contained sessions on a terminal behind an egress proxy.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/milestone-Harness_H1-8B5CF6?style=for-the-badge" alt="Milestone: Harness H1">
  <img src="https://img.shields.io/badge/schema-v2-2ea44f?style=for-the-badge" alt="Schema v2">
  <a href="../README.md"><img src="https://img.shields.io/badge/↩-repository_root-6B7280?style=for-the-badge" alt="Repository root"></a>
</p>

---

The Core is a plain Node 24 process, separate from the Electron app ([ADR-004](../docs/decisions/adr-004-core-companion-process.md)). Houston is its client: it shows and asks, and never enforces. Same conventions as [`src/`](../src/README.md): ES modules, JSDoc types, `node:test`, no bundler. It has no dependencies of its own yet: SQLite is Node's built-in `node:sqlite`.

```powershell
npm run core        # or: node core/main.js
```

It prints one JSON line (`core.start`, with the data folder, the schema versions it moved between and the number of audit chain breaks) and then waits. Ctrl+C stops it. A second copy started on the same data folder exits with code 2 and says the Core is already running.

## 📁 What's here

| File | What it does |
|:---|:---|
| [**main.js**](main.js) | The entry point. Picks the data folder, creates it, opens the database, runs the migrations, opens the audit log and writes `core.start`, then holds the process open. `start(dir)` is the same thing as a function, for tests. |
| [**db.js**](db.js) | `openDb` opens the database in SQLite's exclusive locking mode, which is also the single-instance lock. `migrate` applies the schema steps a database is missing. |
| [**migrations.js**](migrations.js) | The schema, one SQL string per version. |
| [**audit.js**](audit.js) | The audit log: append, the hash chain, the check at start, export. |
| [**policy.js**](policy.js) | The policy check: global denies, explicit denies, the narrowest allow or ask, default deny. |
| [**egress.js**](egress.js) | The egress proxy: `CONNECT` tunnels, and plain `GET` for revocation lists, to the hosts a session's policy allows, and only to public addresses. |
| [**runner.js**](runner.js) | Starts a session: checks the identity and workspace, compiles grants to a container, starts the proxy, opens a PTY, and records start and end. |
| [**launch.js**](launch.js) | The container request every session starts from, with the defaults the spikes found. |
| [**paths.js**](paths.js) | One spelling for every Windows path, and a refusal for the spellings that could name another file. |
| [**schemas/**](schemas/) | The JSON contracts the owner accepted on 2026-11-12: identity, policy request and decision, audit event. |

Tests are in [`tests/core/`](../tests/core/) and run with `npm test`.

Not here yet: the log has no size cap and no rotation. One file grows until a break starts the next. Both come with the log limits in H7.

## 🗄️ Data folder

| Order | Where |
|:---|:---|
| 1 | `HOUSTON_CORE_DATA`, if set. It must be an absolute path. |
| 2 | `%LOCALAPPDATA%\houston-core` |
| 3 | `~/.houston-core`, when there is no `LOCALAPPDATA` (CI on Linux) |

It sits under the user profile on purpose. A session container is denied the profile, so an agent cannot read the database or, later, the vault. Abuse test AT-01 will check that. Don't point `HOUSTON_CORE_DATA` at a folder any identity is granted.

The folder holds `core.db` (plus its `-wal` file while the Core runs) and the `audit\` folder.

## 🔒 Single-instance lock

There is no lock file. The Core opens `core.db` with `PRAGMA locking_mode = EXCLUSIVE` and writes once, and SQLite then holds the file for that process until it closes. The operating system releases it when the process ends, crash included, so there is never a stale lock to clean up.

The cost: nothing else can open `core.db` while the Core runs, the `sqlite3` command line included. That is the intent. Other programs ask the Core; they don't read its database.

## 🧱 Schema v2

| Table | Holds |
|:---|:---|
| `identities` | One row per principal, shaped like [`identity.schema.json`](schemas/identity.schema.json) with snake_case columns. Every identity but the operator needs an owner. A row can't be deleted, and `retired` can't be undone, because an id is never reused. |
| `grants` | One permission for one identity: a typed resource (`file:`, `net:`, `tool:`, `command:`, `secret:`, `session:`), a permission, and `allow`, `ask` or `deny` (`deny` since v2). No row means deny. |
| `sessions` | One launch of an identity: workspace, containment rung, attended or not, the policy version it ran under, start and end. |

The enums are `CHECK` constraints, so a bad row is refused by the database whatever code wrote it. Audit events are not in the database: they go to JSON-lines files, described below.

### Changing the schema

1. Add a new SQL string to the end of `MIGRATIONS` in [`migrations.js`](migrations.js). Never edit one that has merged.
2. Add a test in [`tests/core/core.test.js`](../tests/core/core.test.js) for what the new step must refuse or keep.

`PRAGMA user_version` is the schema version. Each step runs in one transaction with its version bump, so a step that fails changes nothing. A Core that meets a database newer than itself refuses to start.

## 🧾 Audit log

[`audit.js`](audit.js) writes one JSON line per event to `audit\audit-000001.jsonl` in the data folder, shaped like [`audit-event.schema.json`](schemas/audit-event.schema.json). Each line carries `audit.seq`, the hash of the line before (`audit.prev_hash`) and its own `audit.hash`: SHA-256 over `prev_hash` and the event as JSON with its keys sorted. Every line is flushed to disk before `append` returns.

```js
const log = openAudit(path.join(dir, 'audit'));
log.append({ type: 'mcp.tool_call', identity: { subject: 'local:dev-codex' }, session_id, action: 'tool.call',
  resource: { type: 'Tool', id: 'github/create_issue' }, decision: { result: 'deny', policy_version } });
```

The log sets `schema`, `event_id`, `time` and `audit` itself; a caller cannot. An event without an identity, a resource or a decision is refused. Never put a secret or full arguments in one: `resource.args_preview` is clipped to 500 characters and that is the only help the log gives.

**At start** the Core checks every line of every file. If something does not verify:

1. It prints `audit chain break: <file> line <n>: <reason>` and counts it in the `core.start` line.
2. It leaves the broken file exactly as found.
3. It starts the next file, `audit-000002.jsonl`, with an `audit.break` event naming the file, line and reason, chained from the last good line.

A break is recorded once. Later starts still list it, but add nothing. If an older file is changed after that, the new break gets its own `audit.break` event in the current file.

| The chain shows | The chain cannot show |
|:---|:---|
| A line edited, removed, added, copied or reordered | Lines cut off the end of the newest file |
| A file that is missing or emptied | Anything done by someone who rewrites every hash after their edit |

The claim is tamper-evident against an agent, not tamper-proof against the operator's own account ([requirements](../docs/product/harness-requirements.md)). An agent's container cannot reach this folder at all.

`log.events()` gives every good event oldest first, and `log.exportTo(file)` writes them to one JSON-lines file and returns the breaks, so a reader knows what the export is missing. Events the Core writes about itself (`core.start`, `core.stop`, `audit.break`) use the subject `local:core`.

## ⚖️ Policy

[`policy.js`](policy.js) answers one question: may this identity do this to that? A request has the shape in [`policy-request.schema.json`](schemas/policy-request.schema.json), and the answer is `allow`, `ask` or `deny` with the grant ids that decided it, the reasons, and the policy version.

```js
check(db, {
  principal: { type: 'Identity', id: 'local:dev-codex' },
  action: 'file.read',
  resource: { type: 'File', id: 'D:\\work\\app\\.env' },
  context: { session_id, attended: true },
}, { globals });
// { decision: 'deny', determining_policies: ['env'], reasons: ['explicit deny'], policy_version: '3f0c…', approval_id: null }
```

The order, from the [scope rules](../docs/product/harness-requirements.md#scope-rules):

1. **The identity** must exist, be `active` and not have expired.
2. **A global deny** wins over every grant. `globalDenies()` lists them: the Core's data folder, other profiles' folders, and credential stores under the profile (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, the GitHub CLI's folder, `.git-credentials`, `_netrc`, DPAPI keys, Credential Manager and the Windows vault).
3. **An explicit deny grant** wins over any allow or ask, however narrow.
4. **The narrowest allow or ask** decides: the pattern with the most literal characters. On a tie, `ask` beats `allow`.
5. **Nothing matches:** deny.

An unattended run (`attended: false`) turns every `ask` into `deny`. An expired grant is ignored, and so is an allow whose expiry date doesn't parse; a deny whose date doesn't parse keeps denying. A deny grant whose pattern can't be read denies the request rather than being skipped.

| Resource | Pattern | Example |
|:---|:---|:---|
| `file:` | An absolute path. `*` is one name, `**` any depth; `dir/**` also covers `dir`. Case-insensitive | `file:D:/work/**`, `file:D:/work/**/.env` |
| `net:` | `host:port`. `*` is any run of labels or any port; `*.example.com` is not `example.com` | `net:api.openai.com:443` |
| `tool:`, `secret:`, `session:` | `*` is one `/` part, `**` anything. Case-sensitive | `tool:github/*` |
| `command:` | `*` is anything. Case-sensitive. Only as strong as whatever runs the command | `command:git push*` |

The permission must match the action exactly: `file.read` needs a `read` grant, and `write` does not imply `read`.

`policy_version` is a hash of every grant row and the global denies, so any change gives a new version. An `ask` has no `approval_id` yet; the approval inbox (H2) adds it.

### Paths

[`paths.js`](paths.js) gives every Windows path one spelling before it is compared: drive letter upper case, forward slashes, `.` and `..` resolved, and compared case-folded. It **refuses** a path that could name a different file than it seems to, and the request is denied:

| Refused | Why |
|:---|:---|
| `\\server\share`, `\\localhost\C$`, `\\?\UNC\…` | Network paths can reach a local drive by another name |
| `\\?\Volume{…}`, `\\?\GLOBALROOT\…` | Device paths. `\\?\C:\…` and `\\.\C:\…` are accepted and stripped |
| `file.txt:stream`, `::$DATA` | Alternate data streams |
| A name ending in a dot or a space | Win32 strips them, so `.ssh.` is `.ssh` |
| `NUL`, `CON`, `COM1.txt` and the rest | Device names, in any folder |
| `PROGRA~1`, `SSHKEY~1.PUB` | 8.3 aliases. A real long name of exactly that shape is refused too |
| Relative and drive-relative paths (`work`, `\\work`, `D:work`) | The answer would depend on the current folder |

`resolvePath()` also follows the disk: junctions, symlinks, `subst` drives and 8.3 aliases are resolved for the part of the path that exists. Whoever hands the policy a path an agent supplied should pass it through `resolvePath` first. The container policy is still what stops a read through a junction; this keeps the gateway's answer the same as the container's.

## 📦 Launch defaults

[`launch.js`](launch.js) builds the container request every session starts from. `launchRequest(spec)` takes the command, workspace, temp folder, the operator's profile folder and the program folders, and returns a request for the Execution Containers SDK, or throws `LaunchError`. It starts nothing; the runner (next) does.

Each default comes from a [spike result](../docs/decisions/spikes/2026-11-12-h0-spike-results.md#what-this-changes):

| Default | Why |
|:---|:---|
| `ui: { disable: false }` | Without it Node, Git and Python's TLS die with `0xC0000142`. Clipboard and input injection stay denied |
| Enumerate (names only) on the drive root of every granted folder | Node `lstat`s each parent from the root down |
| Deny the users folder (every profile) and each global deny outside it | Enumerate is recursive and would otherwise list every file name on the drive |
| Workspace and temp folder outside every denied folder | Node will not run under a denied folder. A program or a CLI's config folder under the profile may still be granted |
| `PATH` is `System32`, the Windows folder, `Wbem`, then the program folders | The SDK shells out to `whoami`; nothing from the operator's own `PATH` |
| `TEMP` and `TMP` in the session's temp folder; `PYTHONNOUSERSITE=1` | The profile's temp and per-user site-packages are denied |
| `NODE_USE_ENV_PROXY=1` when there is a proxy port | Node's own `fetch` ignores `HTTPS_PROXY` without it |
| No network; or, with `proxyPort`, the container proxy setting | Leaves that one host port reachable and nothing else on the machine or the network |

It refuses a grant that overlaps a global deny (inside it or around it), a whole drive, a backend setting `PATH`, `TEMP`, `TMP`, `PYTHONNOUSERSITE` or `NODE_USE_ENV_PROXY`, and every path [`paths.js`](paths.js) refuses.

Checked on this machine on 2026-11-12 with [`spikes/h1-launch-defaults.mjs`](../spikes/h1-launch-defaults.mjs), run from PowerShell with `H1_ROOT` set to a scratch folder outside the profile:

```text
node --version   exit 0   v24.22.1
git --version    exit 0   git version 2.51.0.windows.1
node --test      exit 0   pass 1
PATH             C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Program Files\Git\cmd;C:\Program Files\nodejs
list profile     exit 1   Access is denied.
read .ssh        exit 1   Access is denied.
write outside    exit 1   Access is denied.
write workspace  exit 0
internet         ENOTFOUND
loopback 4273    EACCES
```

## 🚪 Egress proxy

[`egress.js`](egress.js) is a session's only way out. A container launched with `proxyPort` reaches that one host port and nothing else (spike S2), so whatever listens there decides what the session can reach.

```js
const proxy = await startEgressProxy({
  check: ({ host, port }) => check(db, { principal, action: 'net.connect', resource: { type: 'Host', id: `${host}:${port}` }, context }),
  onEvent: (e) => audit.append(/* an egress.connect event */),
});
launchRequest({ ...spec, proxyPort: proxy.port });
```

- **One proxy per session.** A connection's identity is the port it arrived on, so there is no header, token or client name to trust. The gateway (H3) will serve its MCP endpoint on the same port: every origin-form request (`POST /mcp`) goes to `fallback`.
- **HTTPS through `CONNECT`; plain HTTP only as `GET` or `HEAD`.** A plain request goes to the checked address with hop-by-hop headers (`Proxy-Authorization` among them) dropped both ways, no body, and a 64 MB cap on the response. `POST`, `PUT` and the rest get a 405, so a listed plain-HTTP host can't be sent data.
- **The list is by name; the address is checked too.** After the policy allows `host:port`, the proxy resolves the name and refuses the tunnel if any address is loopback, private, link-local, multicast, documentation, CGNAT or IPv4-mapped. The tunnel goes to the address it checked. Without this the proxy, which runs outside the container, would be the way round the container's loopback and LAN block.
- **Only `allow` lets traffic through.** `ask`, a thrown check or an odd answer is a 403: nobody can answer an approval card in the middle of a TLS handshake.
- **One event per decision**, of type `egress.connect`, with the host, port, scheme (`https` or `http`), method for plain HTTP, decision, reason and, when allowed, the address. Wiring it to the audit log comes with the runner.

Listens on `127.0.0.1` only. `close()` ends open tunnels too.

**Revocation lists.** Windows' own TLS (schannel: `curl.exe`, PowerShell's web cmdlets) fetches certificate revocation lists over plain HTTP before it trusts a certificate, and fails without them. So a session's policy names those hosts as `net:<host>:80` grants (Google's are `c.pki.goog` and `o.pki.goog`), and the proxy forwards plain `GET` and `HEAD` to them. A first run showed `curl.exe` failing with `CRYPT_E_REVOCATION_OFFLINE` before this was added.

Checked on this machine on 2026-11-12 with [`spikes/h1-egress-proxy.mjs`](../spikes/h1-egress-proxy.mjs) (list: `registry.npmjs.org:443`, `c.pki.goog:80`, `o.pki.goog:80`, plus `127.0.0.1:4273` and `localhost:4273` so the address rule has to stop those):

```text
curl allowed host              allow, then 3x allow c.pki.goog:80 (revocation list)   HTTP 200
curl other host                deny example.com:443 (not on the allow-list)           CONNECT tunnel failed, response 403
node fetch allowed host        allow                                                  HTTP 200
curl plain http, not listed    deny example.com:80 (not on the allow-list)            HTTP 403
curl POST to a listed http host  deny (plain HTTP POST is not proxied)                HTTP 405
powershell -Proxy, allowed     allow                                                  200
curl https://127.0.0.1:4273    deny (loopback address)                                CONNECT tunnel failed, response 403
curl https://localhost:4273    deny (resolves to ::1,127.0.0.1)                       CONNECT tunnel failed, response 403
curl --noproxy "*"             (never reaches the proxy)                              Failed to connect
```

Windows PowerShell ignores `HTTPS_PROXY`; it needs `-Proxy $env:HTTPS_PROXY`. PowerShell 7 reads the variable.

`launchRequest` sets `NODE_USE_ENV_PROXY=1` whenever there is a proxy port, so Node's own `fetch` uses the `HTTP_PROXY` and `HTTPS_PROXY` the container sets.

## ▶️ Runner

[`runner.js`](runner.js) starts a session: one identity, one workspace, one command, in a container on a pseudo-terminal.

```js
const runner = createRunner({ db, audit, coreDir, tempRoot });
const session = await runner.start({ identity: 'local:dev-codex', workspace: 'D:\\work\\app', command: 'cmd.exe', size: { rows: 30, columns: 120 } });
session.output.on('data', show);   // session.input, session.resize(size)
await session.stop();              // closes the container; session.done settles with the reason
```

What `start` does, in order. Each refusal writes a `session.start` deny event and leaves nothing behind:

1. **The identity** must exist, be `active`, not have expired, and run on the `container` rung. `restricted-token` and `unconfined` identities are refused until H7.
2. **The workspace** is resolved through junctions, and the identity needs an `allow` grant to write it.
3. **Its grants are compiled** (`compileGrants`) to what a container can enforce: an `allow` `write` grant becomes a read-write folder (a container can't separate write from read), `read` a read-only one, a `deny` a denied folder. Only `dir/**` or an exact path compiles; any other wildcard skips an allow and **refuses the launch** for a deny, since the container would not enforce it. `ask` grants are skipped, because nobody can answer inside a container. `list` grants are skipped too. Tool, command, secret and session grants are left for the gateway.
4. **Network.** If the identity holds any `net:` allow grant, an egress proxy starts for this session and decides on a **frozen copy** of the grants: one added after the start does not reach the session. Otherwise the container has no network.
5. **The request** comes from `launchRequest`, with a temp folder at `<tempRoot>\<session id>\tmp`. `tempRoot` must be outside the user profile.
6. **Records:** a `sessions` row, then a `session.start` event whose `launch` field lists the command, the container's name, the read-write, read-only and denied folders, the network setting and the skipped grants. With no denial reports from the container ([why](../docs/product/harness-requirements.md)), this is what makes a failed read attributable.
7. **`spawnWithPty`.** If the container doesn't start, the session ends at once as `failed to start`.

When the session ends, by `stop()`, by exiting or by its 24-hour timeout, the row gets `ended_at` and an `end_reason` (`stopped`, `exit <code>`, `timeout`), a `session.end` event is written, the proxy closes and the temp folder is deleted. `runner.list()` and `runner.stopAll()` cover live sessions.

The SDK hands out a terminal's streams only until `wait()` starts draining them, so the runner takes them first and exposes them as `session.input` and `session.output`.

**A dead Core's containers.** A container can outlive the Core that started it: one killed mid-session takes its containers with it, but one that exits right after a spawn leaves the SDK's broker (`wxc-exec.exe`) and the contained process running. So every container is named after its session (`containerName`: the session id's 32 hex digits, recorded as `launch.container`). At start, if the database still has open sessions, the Core lists the running brokers (`listBrokers` reads the container id from each one's launch config), ends the broker of each open session, which ends its container, and marks the session `interrupted` (`markInterrupted`). The `session.end` event's reason says which happened: `ended its container`, `no container was running`, `could not end its container (...)` or `could not check for its container: ...`. The record closes either way. Brokers of other containers are left alone.

Checked on this machine on 2026-11-12 with [`spikes/h1-dead-core.mjs`](../spikes/h1-dead-core.mjs), which starts a contained `cmd.exe` from a second Core, lets that Core die, and starts the Core again:

```text
--- kill: Core exit killed ---
left running before restart: 0 broker(s), 0 contained process(es)
restart: session.end interrupted: no container was running
still running after restart: 0
--- crash: Core exit 1 ---
left running before restart: 1 broker(s), 1 contained process(es)
restart: session.end interrupted: ended its container
still running after restart: 0
```

Checked on this machine on 2026-11-12 with [`spikes/h1-runner.mjs`](../spikes/h1-runner.mjs): an identity with write on a workspace, read on Node, and `registry.npmjs.org:443` and `c.pki.goog:80`, running `cmd.exe` on a PTY:

```text
>node --version                         v24.22.1
>echo written> here.txt & type here.txt written
>type "<root>\outside.txt"              Access is denied.
>dir /b "%USERPROFILE%\.ssh"            Access is denied.
>curl.exe ... https://registry.npmjs.org/   registry HTTP 200
>curl.exe ... https://example.com/          CONNECT tunnel failed, response 403
--- end: stopped ---
0 core.start allow
1 session.start allow  denied=C:\Users,<root>\core network={"proxy":true,"hosts":["registry.npmjs.org:443","c.pki.goog:80"]}
2 egress.connect allow registry.npmjs.org:443
3 egress.connect deny  example.com:443 (not on the allow-list)
4 session.end allow  stopped
5 core.stop allow
session row: {"end_reason":"stopped"}    temp folder left: false    leftover processes: 0
```

Closing the terminal prints `Error: AttachConsole failed` from node-pty's console-list helper on stderr. It is noise: the session still ends cleanly.

## 🚧 Not built yet

In roadmap order ([Harness H1](../docs/ROADMAP.md)): the Control API on a named pipe, the identity registry, the abuse suite, and starting at logon.

Module rules that apply as those arrive: `policy` and `audit` import nothing from `runner` or `gateway`; only `vault` touches secret values; nothing binds beyond `127.0.0.1`; the Control API is a named pipe, never a port.

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="../docs/product/harness-requirements.md">Harness requirements</a> ·
  <a href="../docs/decisions/adr-004-core-companion-process.md">ADR-004 →</a>
</p>
