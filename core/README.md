<h1 align="center">🛡️ Core</h1>

<p align="center">
  <em>The harness's companion process. It will launch agents, decide policy, hold secrets and write audit; today it starts, locks and migrates its database.</em>
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

It prints one JSON line (`core.start`, with the data folder and the schema versions it moved between) and then waits. Ctrl+C stops it. A second copy started on the same data folder exits with code 2 and says the Core is already running.

## 📁 What's here

| File | What it does |
|:---|:---|
| [**main.js**](main.js) | The entry point. Picks the data folder, creates it, opens the database, runs the migrations, then holds the process open. `start(dir)` is the same thing as a function, for tests. |
| [**db.js**](db.js) | `openDb` opens the database in SQLite's exclusive locking mode, which is also the single-instance lock. `migrate` applies the schema steps a database is missing. |
| [**migrations.js**](migrations.js) | The schema, one SQL string per version. |
| [**schemas/**](schemas/) | The JSON contracts the owner accepted on 2026-11-12: identity, policy request and decision, audit event. |

Tests are in [`tests/core/`](../tests/core/) and run with `npm test`.

## 🗄️ Data folder

| Order | Where |
|:---|:---|
| 1 | `HOUSTON_CORE_DATA`, if set. It must be an absolute path. |
| 2 | `%LOCALAPPDATA%\houston-core` |
| 3 | `~/.houston-core`, when there is no `LOCALAPPDATA` (CI on Linux) |

It sits under the user profile on purpose. A session container is denied the profile, so an agent cannot read the database or, later, the vault. Abuse test AT-01 will check that. Don't point `HOUSTON_CORE_DATA` at a folder any identity is granted.

The folder holds `core.db` and, while the Core runs, its `-wal` file.

## 🔒 Single-instance lock

There is no lock file. The Core opens `core.db` with `PRAGMA locking_mode = EXCLUSIVE` and writes once, and SQLite then holds the file for that process until it closes. The operating system releases it when the process ends, crash included, so there is never a stale lock to clean up.

The cost: nothing else can open `core.db` while the Core runs, the `sqlite3` command line included. That is the intent. Other programs ask the Core; they don't read its database.

## 🧱 Schema v1

| Table | Holds |
|:---|:---|
| `identities` | One row per principal, shaped like [`identity.schema.json`](schemas/identity.schema.json) with snake_case columns. Every identity but the operator needs an owner. A row can't be deleted, and `retired` can't be undone, because an id is never reused. |
| `grants` | One permission for one identity: a typed resource (`file:`, `net:`, `tool:`, `command:`, `secret:`, `session:`), a permission, and `allow` or `ask`. No row means deny. |
| `sessions` | One launch of an identity: workspace, containment rung, attended or not, the policy version it ran under, start and end. |

The enums are `CHECK` constraints, so a bad row is refused by the database whatever code wrote it. Audit events are not in the database: they go to JSON-lines files, which the audit module adds next.

### Changing the schema

1. Add a new SQL string to the end of `MIGRATIONS` in [`migrations.js`](migrations.js). Never edit one that has merged.
2. Add a test in [`tests/core/core.test.js`](../tests/core/core.test.js) for what the new step must refuse or keep.

`PRAGMA user_version` is the schema version. Each step runs in one transaction with its version bump, so a step that fails changes nothing. A Core that meets a database newer than itself refuses to start.

## 🚧 Not built yet

In roadmap order ([Harness H1](../docs/ROADMAP.md)): the audit log, the policy check, launch policy defaults, the egress proxy, the runner, the Control API on a named pipe, the identity registry, the abuse suite, and starting at logon.

Module rules that apply as those arrive: `policy` and `audit` import nothing from `runner` or `gateway`; only `vault` touches secret values; nothing binds beyond `127.0.0.1`; the Control API is a named pipe, never a port.

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="../docs/product/harness-requirements.md">Harness requirements</a> ·
  <a href="../docs/decisions/adr-004-core-companion-process.md">ADR-004 →</a>
</p>
