<h1 align="center">🛡️ Core</h1>

<p align="center">
  <em>The harness's companion process. It will launch agents, decide policy, hold secrets and write audit; today it starts, locks and migrates its database, keeps a hash-chained audit log, answers policy checks, builds container requests and runs the egress proxy.</em>
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
| [**egress.js**](egress.js) | The egress proxy: `CONNECT` tunnels to the hosts a session's policy allows, and only to public addresses. |
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
- **HTTPS only, through `CONNECT`.** A plain-HTTP proxy request gets a 403.
- **The list is by name; the address is checked too.** After the policy allows `host:port`, the proxy resolves the name and refuses the tunnel if any address is loopback, private, link-local, multicast, documentation, CGNAT or IPv4-mapped. The tunnel goes to the address it checked. Without this the proxy, which runs outside the container, would be the way round the container's loopback and LAN block.
- **Only `allow` opens a tunnel.** `ask`, a thrown check or an odd answer is a 403: nobody can answer an approval card in the middle of a TLS handshake.
- **One event per decision**, of type `egress.connect`, with the host, port, decision, reason and, when allowed, the address. Wiring it to the audit log comes with the runner.

Listens on `127.0.0.1` only. `close()` ends open tunnels too.

Checked on this machine on 2026-11-12 with [`spikes/h1-egress-proxy.mjs`](../spikes/h1-egress-proxy.mjs) (allow-list: `registry.npmjs.org:443`, plus `127.0.0.1:4273` and `localhost:4273` so the address rule has to stop those):

```text
curl allowed host              proxy allow, then 3x deny c.pki.goog:80 (plain HTTP)   exit 35 CRYPT_E_REVOCATION_OFFLINE
curl allowed host, --ssl-no-revoke   allow                                           HTTP 200
curl other host                deny example.com:443 (not on the allow-list)           CONNECT tunnel failed, response 403
node fetch allowed host        allow                                                  HTTP 200
curl plain http                deny example.com:80 (plain HTTP is not proxied)        HTTP 403
curl https://127.0.0.1:4273    deny (loopback address)                                CONNECT tunnel failed, response 403
curl https://localhost:4273    deny (resolves to ::1,127.0.0.1)                       CONNECT tunnel failed, response 403
curl --noproxy "*"             (never reaches the proxy)                              Failed to connect
```

**Windows' own TLS needs plain HTTP for revocation.** `curl.exe`, PowerShell's web cmdlets and anything else on schannel fetch certificate revocation lists over plain HTTP before trusting a certificate, and fail when they can't. Node and the agent CLIs don't. Until that is decided (a roadmap item), schannel tools need `--ssl-no-revoke` or their equivalent inside a session.

`launchRequest` sets `NODE_USE_ENV_PROXY=1` whenever there is a proxy port, so Node's own `fetch` uses the `HTTP_PROXY` and `HTTPS_PROXY` the container sets.

## 🚧 Not built yet

In roadmap order ([Harness H1](../docs/ROADMAP.md)): how schannel tools check revocation, the runner, the Control API on a named pipe, the identity registry, the abuse suite, and starting at logon.

Module rules that apply as those arrive: `policy` and `audit` import nothing from `runner` or `gateway`; only `vault` touches secret values; nothing binds beyond `127.0.0.1`; the Control API is a named pipe, never a port.

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="../docs/product/harness-requirements.md">Harness requirements</a> ·
  <a href="../docs/decisions/adr-004-core-companion-process.md">ADR-004 →</a>
</p>
