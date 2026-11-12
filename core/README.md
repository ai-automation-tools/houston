<h1 align="center">🛡️ Core</h1>

<p align="center">
  <em>The harness's companion process. It will launch agents, decide policy, hold secrets and write audit; today it starts, locks and migrates its database and keeps a hash-chained audit log.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/milestone-Harness_H1-8B5CF6?style=for-the-badge" alt="Milestone: Harness H1">
  <img src="https://img.shields.io/badge/schema-v1-2ea44f?style=for-the-badge" alt="Schema v1">
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

## 🧱 Schema v1

| Table | Holds |
|:---|:---|
| `identities` | One row per principal, shaped like [`identity.schema.json`](schemas/identity.schema.json) with snake_case columns. Every identity but the operator needs an owner. A row can't be deleted, and `retired` can't be undone, because an id is never reused. |
| `grants` | One permission for one identity: a typed resource (`file:`, `net:`, `tool:`, `command:`, `secret:`, `session:`), a permission, and `allow` or `ask`. No row means deny. |
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

## 🚧 Not built yet

In roadmap order ([Harness H1](../docs/ROADMAP.md)): the policy check, launch policy defaults, the egress proxy, the runner, the Control API on a named pipe, the identity registry, the abuse suite, and starting at logon.

Module rules that apply as those arrive: `policy` and `audit` import nothing from `runner` or `gateway`; only `vault` touches secret values; nothing binds beyond `127.0.0.1`; the Control API is a named pipe, never a port.

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="../docs/product/harness-requirements.md">Harness requirements</a> ·
  <a href="../docs/decisions/adr-004-core-companion-process.md">ADR-004 →</a>
</p>
