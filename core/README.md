<h1 align="center">🛡️ Core</h1>

<p align="center">
  <em>The harness's companion process. It will launch agents, decide policy, hold secrets and write audit; today it starts, locks and migrates its database, keeps a hash-chained audit log, answers policy checks, keeps a registry of identities and their grants, starts contained sessions on a terminal behind an egress proxy, starts Claude Code and Codex from their manifests, serves each session an MCP gateway to servers it runs in containers of their own, keeps secrets in a vault that only those servers receive, and takes orders from the operator over a named pipe.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/milestone-Harness_H4_next-8B5CF6?style=for-the-badge" alt="Milestone: Harness H4 next">
  <img src="https://img.shields.io/badge/schema-v5-2ea44f?style=for-the-badge" alt="Schema v5">
  <a href="../README.md"><img src="https://img.shields.io/badge/↩-repository_root-6B7280?style=for-the-badge" alt="Repository root"></a>
</p>

---

The Core is a plain Node 24 process, separate from the Electron app ([ADR-004](../docs/decisions/adr-004-core-companion-process.md)). Houston is its client: it shows and asks, and never enforces. Same conventions as [`src/`](../src/README.md): ES modules, JSDoc types, `node:test`, no bundler. Its dependencies: the Execution Containers SDK, and `koffi` for DPAPI in the vault (MIT, already installed by the SDK, named in `package.json` since H3). SQLite is Node's built-in `node:sqlite`.

```powershell
npm run core        # or: node core/main.js
```

It prints one JSON line (`core.start`, with the data folder, the schema versions it moved between, the number of audit chain breaks and the Control API's pipe) and then, on Windows, serves the [Control API](#-control-api); elsewhere (CI on Linux) there are no containers, so it only holds its lock and prints `pipe: null`. Ctrl+C stops every session and then the Core. Each start, stop and failure to start is also a line in `core.log` in the data folder, the only record when the Core runs with no console. To start it at logon with no window, see [core-at-logon.md](../docs/guide/core-at-logon.md): the task passes `--exit-with-parent`, which stops the Core cleanly once the process that started it is gone. Session temp folders go under `HOUSTON_SESSION_TEMP`, or `%ProgramData%\houston-core\sessions`: they can't be in the user profile, which sessions are denied. A second copy started on the same data folder exits with code 2 and says the Core is already running.

## 📁 What's here

| File | What it does |
|:---|:---|
| [**main.js**](main.js) | The entry point. Picks the data folder, creates it, opens the database, runs the migrations, opens the audit log, writes `core.start`, makes the operator on the first start, then, on Windows, starts the runner and the Control API. `start(dir)` does the first part as a function, for tests. |
| [**db.js**](db.js) | `openDb` opens the database in SQLite's exclusive locking mode, which is also the single-instance lock. `migrate` applies the schema steps a database is missing. |
| [**migrations.js**](migrations.js) | The schema, one SQL string per version. |
| [**audit.js**](audit.js) | The audit log: append, the hash chain, the check at start, export. |
| [**policy.js**](policy.js) | The policy check: global denies, explicit denies, the narrowest allow or ask, default deny. |
| [**egress.js**](egress.js) | The egress proxy: `CONNECT` tunnels, and plain `GET` for revocation lists, to the hosts a session's policy allows, and only to public addresses. |
| [**identities.js**](identities.js) | The identity registry: the operator, agent identities through their lifecycle, and their grants. |
| [**approvals.js**](approvals.js) | The approval inbox: a policy `ask` waits here for the operator's once, session or deny, and denies at its timeout. |
| [**transcripts.js**](transcripts.js) | Session transcripts: each session's terminal as plain text, secrets replaced by a marker before write, with a cap per transcript and for the folder. |
| [**vault.js**](vault.js) | The vault: named secrets sealed with DPAPI and entropy only the Core holds. Set, list and delete from the Control API; values go only to the gateway, for an MCP server's environment. |
| [**gateway.js**](gateway.js) | The MCP gateway: each session's MCP endpoint on its proxy port, the server registrations (discovered, installed, pinned, needs review, disabled), each server in a container of its own, one policy check per call, results redacted, marked and capped. |
| [**upstream.js**](upstream.js) | The gateway's side of one MCP server's stdio: JSON-RPC lines, the handshake, the tool list. |
| [**mcp-protocol.js**](mcp-protocol.js) | What every MCP endpoint here checks the same way: protocol versions (2026-07-28 and the 2025 handshake), the bearer token, Host and Origin. Shared with the app's own MCP server. |
| [**control.js**](control.js) | The Control API on a named pipe: sessions, identities, grants and the audit log, each request with the token from `control.json`. |
| [**client.js**](client.js) | The client side: `dataDir()`, `callControl()` and `attachSession()`, with nothing but Node built-ins, so Houston's window and `ctl.js` don't load the Core. |
| [**ctl.js**](ctl.js) | `npm run ctl -- <method> key=value ...`: the Control API from a terminal. |
| [**runner.js**](runner.js) | Starts a session: checks the identity and workspace, compiles grants to a container, starts the proxy, opens a PTY, and records start and end. |
| [**launch.js**](launch.js) | The container request every session starts from, with the defaults the spikes found. |
| [**backends.js**](backends.js) | The adapter manifests for Claude Code and Codex: how each CLI starts in a container, with a home of its own. |
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

The Core uses the folder's long, final spelling (`realpathSync.native`): the path rules refuse 8.3 names, and a `TEMP` like `C:\Users\RUNNER~1\...` on CI has them.

It sits under the user profile on purpose. A session container is denied the profile, so an agent cannot read the database or, later, the vault. Abuse test AT-01 will check that. Don't point `HOUSTON_CORE_DATA` at a folder any identity is granted.

The folder holds `core.db` (plus its `-wal` file while the Core runs), `vault.key` (the vault's entropy), the `audit\` folder, the `transcripts\` folder and, while the Core runs, `control.json`.

**Only the operator can read it.** At every start the Core removes the folder's inherited access and grants full control to the operator and SYSTEM alone (`secureDir`, with `icacls`; `chmod 700` elsewhere). Inherited access can name other local accounts: on the dev machine, `%LOCALAPPDATA%` was readable by a `CodexSandboxUsers` group. Entries set directly on the folder are kept: one you chose with `HOUSTON_CORE_DATA` may have some on purpose, and a folder made by an elevated process carries one for Administrators, who are outside the threat model anyway ([ADR-004](../docs/decisions/adr-004-core-companion-process.md)).

## 🔒 Single-instance lock

There is no lock file. The Core opens `core.db` with `PRAGMA locking_mode = EXCLUSIVE` and writes once, and SQLite then holds the file for that process until it closes. The operating system releases it when the process ends, crash included, so there is never a stale lock to clean up.

The cost: nothing else can open `core.db` while the Core runs, the `sqlite3` command line included. That is the intent. Other programs ask the Core; they don't read its database.

## 🧱 Schema v5

| Table | Holds |
|:---|:---|
| `identities` | One row per principal, shaped like [`identity.schema.json`](schemas/identity.schema.json) with snake_case columns. Every identity but the operator needs an owner, and there is one operator (v3). A row can't be deleted, and `retired` can't be undone, because an id is never reused. |
| `grants` | One permission for one identity: a typed resource (`file:`, `net:`, `tool:`, `command:`, `secret:`, `session:`), a permission, and `allow`, `ask` or `deny` (`deny` since v2). No row means deny. |
| `sessions` | One launch of an identity: workspace, containment rung, attended or not, the policy version it ran under, start and end. |
| `secrets` | The vault (v4): a name and a DPAPI blob; the value is in no other column. |
| `mcp_servers` | The gateway's registrations (v4): name, the `mcp-server` identity it runs as, its command (an http server's URL), env (text or `secret:<name>`), program folders, state, the tool list as last read, its hash, and the hash the operator pinned. Since v5, its `transport`: `container`, `host` or `http`. |

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

`policy_version` is a hash of every grant row and the global denies, so any change gives a new version. `check` itself never waits: an `ask` comes back as `ask` (with `approval_id` null), and the caller that can hold the request puts it in the [approval inbox](#-approval-inbox).

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

- **One proxy per session.** A connection's identity is the port it arrived on, so there is no header, token or client name to trust. The gateway serves its MCP endpoint on the same port: every origin-form request (`POST /mcp`) goes to `fallback`, and so do an absolute-form request and a `CONNECT` to the proxy's own port ([MCP gateway](#-mcp-gateway)).
- **HTTPS through `CONNECT`; plain HTTP only as `GET` or `HEAD`.** A plain request goes to the checked address with hop-by-hop headers (`Proxy-Authorization` among them) dropped both ways, no body, and a 64 MB cap on the response. `POST`, `PUT` and the rest get a 405, so a listed plain-HTTP host can't be sent data.
- **The list is by name; the address is checked too.** After the policy allows `host:port`, the proxy resolves the name and refuses the tunnel if any address is loopback, private, link-local, multicast, documentation, CGNAT or IPv4-mapped. The tunnel goes to the address it checked. Without this the proxy, which runs outside the container, would be the way round the container's loopback and LAN block.
- **Only `allow` lets traffic through.** A thrown check or an odd answer is a 403. An `ask` never reaches the proxy as one: the runner holds the `CONNECT` (or plain `GET`) in the [approval inbox](#-approval-inbox) before any TLS starts, and passes on the operator's allow or deny. Without an inbox, `ask` is a 403.
- **One event per decision**, of type `egress.connect`, with the host, port, scheme (`https` or `http`), method for plain HTTP, decision, reason and, when allowed, the address. Wiring it to the audit log comes with the runner.

Listens on `127.0.0.1` only. `close()` ends open tunnels too.

**DNS.** A contained process can resolve names, though it can connect nowhere off its list: Windows answers lookups through its DNS Client service, outside the container, so egress rules never see them (its own `nslookup`, which sends packets itself, times out). The containers SDK has no DNS control: its network rules match addresses and ports only. Accepted on 2026-11-13 as a known limit: a lookup could carry a little data out to a name server someone controls, but brings nothing in except addresses the container still can't connect to. Found by AT-04 (abuse run 2026-11-12).

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

## 🤖 Backends

An agent is someone else's CLI ([ADR-004](../docs/decisions/adr-004-core-companion-process.md)). [`backends.js`](backends.js) holds one manifest per CLI, and an identity created with `backend` set to one of them runs it:

```powershell
npm run ctl -- identity.create id=local:dev-claude kind=ai-agent displayName="Dev Claude" backend=claude-code
npm run ctl -- grant.add identity=local:dev-claude resource=file:D:/work/app/** permission=write
npm run ctl -- grant.add identity=local:dev-claude resource=net:api.anthropic.com:443 permission=connect
npm run ctl -- grant.add identity=local:dev-claude resource=net:platform.claude.com:443 permission=connect
npm run ctl -- identity.activate id=local:dev-claude
npm run ctl -- session.start identity=local:dev-claude workspace=D:\work\app
```

| | Claude Code (`claude-code`) | Codex (`codex`) |
|:---|:---|:---|
| Program, read-only | `%USERPROFILE%\.local\bin\claude.exe` (the file) | the native `codex.exe`'s folder under the npm global `@openai/codex` (not the Node wrapper, S3) |
| Arguments | `--strict-mcp-config` | `--sandbox danger-full-access` (its own Windows sandbox can't be set up in a container), no update check, no analytics |
| Home | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| Also | Git Bash: Git's folder read-only, `CLAUDE_CODE_GIT_BASH_PATH`; no telemetry or self-update | |
| Hosts it needs | `api.anthropic.com:443`, `platform.claude.com:443` (sign-in token) | `chatgpt.com:443`, `auth.openai.com:443`, `api.openai.com:443` |
| Sign in | `/login`, then paste the code from the browser | device code |

**A home of its own.** Each identity gets `houston-agents\<id>\<backend>` beside the Core's data folder (`%LOCALAPPDATA%\houston-agents`), restricted to the operator at every start like the data folder, and granted read-write to that identity's sessions only. It signs in there once; the home outlives its sessions. The operator's own `~/.claude` and `~/.codex` are never granted: besides the sign-in they hold the operator's MCP list, with tokens in its env blocks, plus hooks and history. A fresh home also starts with no MCP servers, which the manifest could not have done otherwise: Codex's `-c mcp_servers={}` adds to the list instead of replacing it. The agent can read its own sign-in, as ADR-004 says; nothing else of the operator's.

**What the runner does with it.** A backend identity's `session.start` takes no `command`: the manifest sets it, and passing one is refused. The program must be installed now (`backend.list` says which are). The manifest's environment wins over the caller's `program.env`, so a caller can't point the CLI at another home; the caller's `program` still adds toolchain folders. The CLI's own permission prompts stay on as its UX; the container is the boundary. The hosts are declared, not granted: `session.start`'s `launch.backend.missingHosts` lists those the identity has no `allow` for, and the proxy refuses them like any other.

Checked on this machine on 2026-11-12 with [`spikes/h2-backends.mjs`](../spikes/h2-backends.mjs): each CLI started in a real container with its manifest's hosts granted and nothing typed, for 25 seconds:

```text
claude-code  first screen: "Welcome to Claude Code v2.1.323 ... Choose the text style"   home: .claude.json, sessions
             egress: allow api.anthropic.com:443, allow platform.claude.com:443
codex        first screen: "Welcome to Codex ... 1. Sign in with ChatGPT  2. Sign in with Device Code"
             egress: allow chatgpt.com:443; deny raw.githubusercontent.com, github.com, api.github.com, files.openai.com
```

Codex reaches for GitHub even with its update check off; those calls are refused and logged, and it carries on. Grant them only if something turns out to need them.

## 🪪 Identity registry

[`identities.js`](identities.js) is who may act and what they may touch. Each change is an audit event with the policy version it produced: `identity.lifecycle` (with a `lifecycle` field, `{ from, to, reason? }`) or `grant.change` (with the `grant`).

**The operator.** The Core makes `local:operator` at its first start: active, unconfined, owner of everything else. There is one per database (a unique index since schema v3), its status never changes, and it takes no grants.

**The lifecycle**, from [`identity.schema.json`](schemas/identity.schema.json):

| From | Can become |
|:---|:---|
| `draft` (every new identity) | `active`, `retired` |
| `active` | `suspended`, `retired` |
| `suspended` | `active`, `retired` |
| `retired` | nothing: final, and the id is never reused |

Only an `active` identity starts a session (the runner checks, and records `lastUsedAt`). Suspending or retiring one over the Control API also stops its running sessions.

**What `create` checks:** an id of `local:` plus a lowercase name; a kind other than `operator`; a display name of 1 to 80 characters; an owner (default: the caller) and a parent that exist and aren't retired, and a parent for a sub-agent; a containment rung (default `container`); an expiry in the future.

**What `addGrant` checks:** a resource of `<type>:<pattern>` whose pattern compiles; a permission that fits the type (`file`: read, write or list; `net`: connect; `tool`: call; `command`: run; `secret`: use; `session`: run or spawn); `allow`, `ask` or `deny`; an identity that isn't retired and isn't the operator. It does not check what a container can enforce: a grant on `C:/Users/**` is accepted, and the launch refuses it with the reason.

**By hand:** [`ctl.js`](ctl.js) calls the running Core's Control API from a terminal, so an identity can be made without the window:

```powershell
npm run ctl -- identity.create id=local:dev-shell kind=ai-agent displayName="Dev shell"
npm run ctl -- grant.add identity=local:dev-shell resource=file:D:/work/app/** permission=write
npm run ctl -- identity.activate id=local:dev-shell
npm run ctl -- session.start identity=local:dev-shell workspace=D:\work\app command="cmd.exe /d /q /k"
```

Each argument is `key=value`; a value that parses as JSON (`true`, `3`, `["a","b"]`) is taken as JSON. One JSON object works too.

Checked on this machine on 2026-11-12 with [`spikes/h1-identity.mjs`](../spikes/h1-identity.mjs), which does exactly that against the real Core, with a real contained shell:

```text
identity.create local:dev-shell              draft, owner local:operator
session.start while draft                    -> refused: the identity is draft
grant.add write on the workspace             allow write
grant.add on the user profile                allow read (the launch refuses it later)
identity.activate                            active
session.start while active                   -> refused: C:\Users overlaps a global deny, which no grant overrides
grant.remove the profile grant               removed file:C:/Users/**
session.start again                          started
identity.suspend                             suspended, stopped 1
session.start while suspended                -> refused: the identity is suspended
identity.activate                            active
identity.retire                              retired, stopped 0
identity.activate after retire               -> conflict: local:dev-shell is retired; it can become nothing else
identity.create the same id again            -> conflict: local:dev-shell exists (retired: ids are never reused)
session.start while retired                  -> refused: the identity is retired
identity.get                                 retired, lastUsedAt set, retiredAt set, 1 grant
```

Every step, refusals included, is in the audit log: 16 events.

## ✋ Approval inbox

[`approvals.js`](approvals.js) is where a policy `ask` waits for the operator (SEC-05). The Core holds the request; Houston shows it as a card and sends back an answer, so nothing a session does can answer for the operator, and a closed window means the card times out as a deny.

| Answer | Does |
|:---|:---|
| `once` | Allows this one request |
| `session` | Allows it, and every identical request (same action and resource) until the session ends |
| `deny` | Refuses it |
| no answer in 120 s | Denies it (`timeout`) |
| the session ends | Denies whatever it still had waiting, and forgets its session allows |

Each ask is an `approval.requested` audit event (decision `ask`, the approval id and when it expires) and each outcome an `approval.decided` (allow or deny, the answer, and who gave it: `local:operator`, or `local:core` for a timeout or a session's end). An unattended session never gets here: `check` turns its `ask` into `deny`.

**Who asks.** The egress proxy: an identity with an `ask` grant on `net:<host>:<port>` gets a proxy even with no `allow` grant, and a `CONNECT` or plain `GET` to that host is held, before any TLS, until the answer. `session.start`'s `launch.network.ask` lists those hosts. The MCP gateway (H3) asks the same way for a tool under an `ask` grant: the call is held, and the card shows the tool and its arguments (clipped, vault values redacted). The answer covers that one call; nothing the agent sends later can reuse it, unless the operator chose **Allow for this session**.

Checked by `npm run smoke` against a throwaway Core on 2026-11-12: a contained `curl.exe` to an `ask` host showed a card with the identity, `connect to example.org:443` and the workspace; **Deny** gave curl a `403`. Two identical requests to another `ask` host asked once; **Allow for this session** let both through.

## 📼 Transcripts

[`transcripts.js`](transcripts.js) keeps what each session's terminal showed, on by default (CORE-19, LOG-01). One file per session, `transcripts\<session id>.txt` in the data folder, so only the operator can read it. It starts with a `# session` line (id, identity, workspace, start) and ends with `# ended: <reason>`.

- **Plain text.** The terminal's escape sequences are resolved the way the window's own output reader does it (one line at a time), so it reads like the screen did, minus colours.
- **Redacted before write** (LOG-04). Text is held until its line ends, so a secret split across two chunks is caught whole, and each line is checked before it reaches the disk: Anthropic, OpenAI, GitHub, Slack, AWS and Google key shapes, JWTs, `Bearer`/`Basic` credentials and `NAME=value` where the name ends in KEY, TOKEN, SECRET, PASSWORD or similar become `[REDACTED:<kind>]`; a private key block, over however many lines, becomes one `[REDACTED:private-key]`. A secret with no telltale shape gets through by shape, but every value stored in the vault is also replaced, wherever it shows, by `[REDACTED:secret:<name>]` (values of 8 characters or more).
- **Caps.** One transcript stops at 100 MB with a line saying so (the session runs on). The folder is kept under 5 GB: past it, the oldest finished transcripts are deleted first, each a `log.deleted` audit event by `local:core`. A running session's transcript is never deleted, and the audit log is never rotated here.
- **Reading one.** `transcript.get` gives a session's newest 1 MB (from a whole line), running or ended. Houston opens it as an `acc://transcript/<id>` page from the Logs tab's **Transcript** button.

A disk error stops that transcript, not the session. Checked by `npm run smoke` on 2026-11-12: a made-up Anthropic key echoed in a contained shell shows only as its marker on the transcript page.

## 🔐 Vault

[`vault.js`](vault.js) holds named secrets (SEC-06) for MCP servers, never for an agent. The only module that stores or opens a value.

- **Sealed twice.** Each value is a DPAPI blob for the operator's account, made with 32 bytes of entropy kept in `vault.key` in the data folder. Spike S5 found that a contained process, running as the same Windows user, can decrypt a plain DPAPI blob it is handed, but not one made with entropy it never sees. The blob and the key both sit in the data folder, which every session is denied. Off Windows (Linux CI) the same key seals values with AES-256-GCM.
- **In, never out.** `secret.set`, `secret.list` (names and dates) and `secret.delete`. There is no `secret.get`: a value leaves the vault only through `reveal`, which the gateway calls to put it into a server's environment. Each change is a `secret.change` audit event with the name, never the value or a hash of it.
- **Setting one.** `ctl` reads the value from stdin, so it isn't in shell history or a process list: `Get-Content token.txt | npm run ctl -- secret.set name=github-token`, or run it with no pipe and type it (not echoed).
- **Redaction by value.** `vault.redact` replaces every stored value of 8 characters or more with `[REDACTED:secret:<name>]`. Tool results, the approval card's argument preview and transcripts all go through it.

## 🚪 MCP gateway

[`gateway.js`](gateway.js) is the only MCP endpoint a session sees and the only client an MCP server has (SEC-01, ADR-004).

**Where it answers.** On the session's egress proxy port, which is the one host port its container can reach: `HOUSTON_MCP_URL` (`http://127.0.0.1:<port>/mcp`) and `HOUSTON_MCP_TOKEN` are in every session's environment. The port says which session is calling; the bearer token, random per session, must match it, and stops working when the session ends (Stop All included). Host and Origin must be loopback, which also refuses a web page (AT-13). A client that routes loopback through `HTTP_PROXY` reaches it too: absolute-form requests and a `CONNECT` to the proxy's own port are handed to the gateway, and every other loopback target is still refused. Both MCP eras are spoken: the 2025 `initialize` handshake and 2026-07-28's per-request `_meta` with mirrored headers ([`mcp-protocol.js`](mcp-protocol.js), shared with the app's own server). Claude Code gets the gateway through `--mcp-config` (a file in the session's temp folder that names `${HOUSTON_MCP_TOKEN}`), Codex through `-c mcp_servers.houston.*` with `bearer_token_env_var`; neither puts the token on the command line.

**Registering a server.**

| Step | Method | State after |
|:---|:---|:---|
| Register: the full command is shown, nothing runs | `mcp.add` | `discovered` |
| Grant its identity `local:mcp/<name>` the folders, hosts and secrets it needs | `grant.add` | |
| Run it once in its container and read its tools | `mcp.install` | `installed` |
| Accept that list, by its hash | `mcp.pin` | `pinned`: sessions get its tools |
| Its tools change (found when it next starts) | | `needs_review`: calls refused until it is installed and pinned again |
| Switch it off | `mcp.disable` | `disabled`: calls refused at once |

```powershell
npm run ctl -- mcp.add name=github command='"C:\Program Files\nodejs\node.exe" D:\mcp\github\dist\index.js' env='{"GITHUB_PERSONAL_ACCESS_TOKEN":"secret:github-token"}' pathDirs='["C:\\Program Files\\nodejs"]'
npm run ctl -- grant.add identity=local:mcp/github resource=file:D:/mcp/github/** permission=read
npm run ctl -- grant.add identity=local:mcp/github resource=secret:github-token permission=use
npm run ctl -- grant.add identity=local:mcp/github resource=net:api.github.com:443 permission=connect
npm run ctl -- mcp.install name=github
npm run ctl -- mcp.pin name=github hash=<toolsHash from the install>
npm run ctl -- grant.add identity=local:dev-claude resource=tool:github/* permission=call
```

**A server's container.** It starts on a session's first call to it, as its own identity: that identity's file and `net:` grants are its container's policy (its own egress proxy, `ask` is deny since nobody watches a server), its program folders are read-only and on `PATH`, and its home (`houston-agents\mcp+<name>`) is its `USERPROFILE`, `APPDATA` and npm cache. Each `secret:<name>` in its env needs a `secret:<name>` use grant; each injection is a `credential.inject` event, and without the grant the server doesn't start. It stops when the session ends. Its tools are listed again at every start and hashed (name, title, description, schemas, annotations); a hash that isn't the pinned one moves it to `needs_review` (AT-08).

**Host and http servers.** Some servers can't work in a container, so a registration names its `transport`. `host` starts the command on the host, unconfined: it gets the Windows basics, a clean `PATH` with its program folders, its own home and temp folders and its env, and nothing else of the Core's environment, and its file and `net:` grants don't bind it. Cronsole's server is one, because it calls Cronsole's API on loopback, which a container can't reach. `http` is a server already listening on loopback (plain http, no credentials in the URL), reached at its `url` with its env as request headers; `Bearer secret:<name>` takes the value from the vault under the same use grant. `mcp.update` gives an http server a new address. Either way its identity is `unconfined`, and every event by it says so. Pinning, the per-call check and result handling are the same for all three.

Houston registers its own MCP server this way at every start: an http server named `houston`, with its per-launch token in the vault as `houston-mcp` and the use grant made with it, and its new address sent with `mcp.update`. The operator still installs and pins it before any session sees its tools, and it needs review again whenever an app update changes them. Cronsole's is registered by hand:

```powershell
Write-Output $env:CRONSOLE_TOKEN | npm run ctl -- secret.set name=cronsole-token
npm run ctl -- mcp.add name=cronsole transport=host command='"C:\Program Files\nodejs\node.exe" D:\path\to\cronsole\mcp-server\dist\index.js' env='{"CRONSOLE_TOKEN":"secret:cronsole-token"}' pathDirs='["C:\\Program Files\\nodejs"]'
npm run ctl -- grant.add identity=local:mcp/cronsole resource=secret:cronsole-token permission=use
npm run ctl -- mcp.install name=cronsole
npm run ctl -- mcp.pin name=cronsole hash=<toolsHash from the install>
```

Checked on 2026-11-13 by [`spikes/h3-host-servers.mjs`](../spikes/h3-host-servers.mjs): an agent in a real container listed and called `cronsole.list_tasks` (Cronsole's real server on the host, with its token from the vault) and `houston.list_tabs` (an http server built from the app's own MCP code). An ungranted Cronsole tool was refused, the container couldn't reach the http server's port directly, neither token was in the transcript or the audit log, and no server process was left running.

**A call.** Tools are `<server>.<tool>` to the agent and `tool:<server>/<tool>` in a grant. `tools/list` shows a pinned server's tools that the identity isn't denied. `tools/call` is one policy check: `deny` is refused without the server hearing of it, `ask` waits on a card, `allow` goes through. Every call is an `mcp.tool_call` event with the arguments as a clipped, redacted preview and a SHA-256, the decision, and the outcome. A refused call comes back as a tool error (`isError`) that says why.

**A result.** Every vault value is redacted, the first content block says it is untrusted content from that server, `_meta["houston/untrusted-content"]` says the same, and anything over 1 MB is cut block by block. Checked in real containers by [`spikes/h3-gateway.mjs`](../spikes/h3-gateway.mjs) on 2026-11-12: a contained agent listed and called the stub server's tools through its proxy and straight at the port, the ungranted tool was refused, and the server's injected token came back only as its marker; the value was in neither the agent's environment nor the audit log.

## 🎛️ Control API

[`control.js`](control.js) is how the operator's client drives the Core. The client side is [`client.js`](client.js): Houston's main process uses it through [`src/main/core.js`](../src/main/core.js), and tests, scripts and `ctl.js` call it directly.

```js
import { callControl, dataDir } from './core/client.js';
const s = await callControl(dataDir, 'session.start', { identity: 'local:dev-shell', workspace: 'D:\\work\\app', command: 'cmd.exe /d /q /k' });
await callControl(dataDir, 'stop.all');
```

A named pipe, `\\.\pipe\houston-core-<32 random hex digits>`, new at every start. One JSON object per line each way: a request `{ id, token, method, params }`, an answer `{ id, result }` or `{ id, error: { code, message } }`. Several requests can share a connection; each answer carries its request's id.

| Method | Params | Result |
|:---|:---|:---|
| `core.status` | none | `{ pid, startedAt, schema, containment, sessions, limits }`: `containment` is the rung sessions run on (`container`), `sessions` how many run, and `limits` the approval timeout and transcript caps (`approvalSeconds`, `transcriptBytes`, `sessionTranscriptBytes`). Houston's Connections row and Settings page show it |
| `session.start` | `identity`, `workspace`; `command` unless the identity has a backend; optional `attended`, `size`, `program` (`readonly`, `pathDirs`, `env`) | `{ id, identity, workspace, startedAt }` |
| `backend.list` | none | each manifest: `name`, `displayName`, `hosts`, `signIn`, and whether its program is `installed` here |
| `session.attach` | `id` | `{ attached: id }`, then the connection streams the terminal ([below](#a-sessions-terminal)) |
| `session.stop` | `id` | `{ reason, exitCode }` |
| `approval.list` | none | the asks waiting, oldest first: `id`, `identity`, `session_id`, `workspace`, `action`, `resource`, `createdAt`, `expiresAt` |
| `approval.decide` | `id`, `answer` (`once`, `session` or `deny`) | `{ result }`; `not_found` once it was answered, timed out or its session ended |
| `session.list` | none | the running sessions |
| `transcript.get` | `id` | `{ id, text, bytes, truncated }`: the session's transcript, its newest 1 MB, already redacted; `not_found` when there is none ([Transcripts](#-transcripts)) |
| `stop.all` | none | `{ stopped }`, the number stopped. One `stop.all` audit event (resource `Core` / `sessions`) by `local:operator` (how many were running), then each session's own `session.end`; pending approvals end denied with their sessions. Houston's **Stop All** button, Ctrl+Shift+Backspace and the tray call it |
| `audit.query` | optional `type`, `session_id`, `identity`, `result`, `since`, `limit` (1 to 1000, default 100) | `{ events, truncated }`: the newest matches, oldest first |
| `identity.list` | optional `status` | identities with their grants |
| `identity.get` | `id` | one identity with its grants |
| `identity.create` | `id`, `kind`, `displayName`; optional `owner`, `parent`, `purpose`, `backend` (`claude-code` or `codex`), `containment`, `expiresAt`, `tags` | the new identity, in `draft` |
| `identity.activate` | `id`; optional `reason` | the identity |
| `identity.suspend`, `identity.retire` | `id`; optional `reason` | `{ identity, stopped }`: its running sessions are stopped |
| `grant.add` | `identity`, `resource`, `permission`; optional `effect` (default `allow`), `expiresAt` | the grant, with its id |
| `grant.remove` | `id` | the grant removed |
| `mcp.list`, `mcp.get` | `name` for get | registrations: `name`, `identity`, `transport`, `command` (or `url` for http), `env` (names and `secret:` references, never values), `pathDirs`, `state`, `tools`, `toolsHash`, `pinnedHash` ([Gateway](#-mcp-gateway)) |
| `mcp.add` | `name`, then `command`, or `transport=http` and `url`; optional `transport` (`container`, the default, or `host`), `env` (an http server's request headers), `pathDirs` | the registration, `discovered`, with the full command; its identity `local:mcp/<name>` is made active with no grants, `unconfined` unless it runs in a container |
| `mcp.update` | `name`, `url` | an http server at its new address; its state stays, and its tools are still checked against the pin at every start |
| `mcp.install` | `name` | runs it once (in its container, on the host, or over http) and reads its tools: `installed` (or `needs_review` if it was pinned and the list changed) |
| `mcp.pin` | `name`, `hash` (the `toolsHash` the operator read) | `pinned`: sessions get its tools. `conflict` when the hash isn't the list as last read |
| `mcp.disable` | `name` | `disabled`: calls are refused at once; `mcp.pin` enables it again |
| `secret.set` | `name`, `value` | `{ name, created_at, updated_at, last_used_at }`, never the value. `ctl` reads the value from stdin ([Vault](#-vault)) |
| `secret.list` | none | names and dates |
| `secret.delete` | `name` | `{ name, deleted }` |

Error codes: `unauthorized`, `bad_request`, `unknown_method`, `not_found`, `conflict` (the lifecycle doesn't allow it, or the id exists), `refused` (the runner said no, with its reason), `internal`. Every call acts as the operator: only the operator holds the token.

### A session's terminal

The Core reads every session's output whether or not anyone watches, so a session never stalls on a full buffer, and keeps the newest 256 KB of it. `session.attach` turns its connection into that session's terminal, on a connection of its own:

1. The answer `{ id, result: { attached } }`, then `{ "data": "..." }` with the kept output, then one `{ "data" }` line per chunk as it comes, decoded as UTF-8 across chunk edges.
2. The client sends `{ "input": "..." }` (up to 64 KB a line) to type and `{ "resize": { "rows", "columns" } }` to resize (clamped to 5 to 200 rows and 20 to 500 columns). Anything else gets a `bad_request` and the connection closes; the session runs on.
3. When the session ends, `{ "end": { reason, exitCode } }` and the Core closes the connection.

Several connections can attach to one session; closing one detaches it and leaves the session running. Only the `session.attach` request carries the token. The client side is `attachSession()` in [`client.js`](client.js); Houston's Agents tab uses it ([`src/main/agents.js`](../src/main/agents.js)).

**Who can call it.** Three layers:

1. **The pipe's ACL.** Node can't set one, so the pipe has Windows' default: full control for the operator, SYSTEM and administrators, and read-only for everyone else, which can't send a request. A contained process can't open a host pipe at all (spike S3).
2. **The token.** Every request carries a 32-byte random token, new at every start, compared in constant time. A wrong or missing one gets `unauthorized`, a `control.denied` audit event, and a closed connection.
3. **The data folder.** The pipe name and the token are in `control.json` in the data folder, which the Core restricts to the operator and SYSTEM at every start ([below](#-data-folder)). Every session is denied that folder too.

Requests are capped at 1 MB. `control.json` is deleted when the Core stops; after a crash it is stale until the next start replaces it.

Checked on this machine on 2026-11-12 with [`spikes/h1-control.mjs`](../spikes/h1-control.mjs), against the real `node core/main.js`:

```text
core.start: pipe \\.\pipe\houston-core-<random>
session.list: 4 running
wrong token: {"id":1,"error":{"code":"unauthorized","message":"bad or missing token"}}
stop.all: {"stopped":2} in 155 ms; then session.list: 0
contained shell writes to the Core pipe: exit 1
contained shell reads control.json: exit 1
audit: 1 control.denied (wrong token), 4 session.end
--- pipe ACL ---
Everyone: Allow Read, Synchronize
NT AUTHORITY\ANONYMOUS LOGON: Allow Read, Synchronize
NT AUTHORITY\SYSTEM: Allow 2032127
BUILTIN\Administrators: Allow 2032127
<machine>\<operator>: Allow 2032127
--- data folder ACL ---
NT AUTHORITY\SYSTEM:(OI)(CI)(F)
<machine>\<operator>:(OI)(CI)(F)
```

`2032127` is full control. The first run found the data folder readable by a local `CodexSandboxUsers` group, inherited from `%LOCALAPPDATA%`; that is why the Core now sets the folder's ACL itself.

## 🚧 Not built yet

H1 and H3 are done, and H2 waits only on the owner's items: H3 brought the gateway, the vault, Houston's own MCP server and Cronsole's behind the gateway, the DNS decision (see [Egress proxy](#-egress-proxy)) and the window's Integrations tab. Next on the [roadmap](../docs/ROADMAP.md): H4, standing grants and unattended runs. AT-06 to AT-08 pass in [`abuse/`](../abuse/README.md) with the rest of the suite.

Module rules: `policy` and `audit` import nothing from `runner` or `gateway`; only `vault` stores or opens a secret, and only the gateway asks it for one, to hand straight to a server's container; nothing binds beyond `127.0.0.1`; the Control API is a named pipe, never a port; the Core imports nothing from the window (`src/`).

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="../docs/product/harness-requirements.md">Harness requirements</a> ·
  <a href="../docs/decisions/adr-004-core-companion-process.md">ADR-004 →</a>
</p>
