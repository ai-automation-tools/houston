<h1 align="center">🛡️ ADR-004: A Core Companion Process</h1>

<p align="center">
  <em>A second process, the Core, launches agents, decides policy, holds secrets and writes audit. Houston shows and asks; it never enforces.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-accepted-2ea44f?style=for-the-badge" alt="Status: accepted">
  <img src="https://img.shields.io/badge/door-one--way_once_data_exists-F59E0B?style=for-the-badge" alt="One-way once data exists">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-decisions-6B7280?style=for-the-badge" alt="Back to decisions"></a>
</p>

---

**Date:** 2026-11-12 · **Decided by:** Mike · **Serves:** [harness-requirements.md](../product/harness-requirements.md)

## Context

Houston is a workbench: browser, shells, files, workspaces, an MCP server that waits for a click. The [harness requirements](../product/harness-requirements.md) add agents that run as identities with enforced permissions, an MCP gateway, secrets, audit and unattended runs.

Three facts shape the decision:

- **Unattended work must run with the window closed.** Houston's main process ends when the app quits.
- **Secrets should not live in the process that renders web pages.** The shell view runs with `sandbox: false` today.
- **A control inside the thing it governs is not a control.** Houston's MCP server has one shared per-launch token and self-reported client names; the per-client switch was dropped on 2026-10-26 for exactly that reason (see [OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md)).

`AGENTS.md` says nothing but the MCP server listens on a port, and its Won't list has no notion of a companion process. This ADR is the "new ADR" that list asks for.

## Options considered

1. **A Core process in this repo, under `core/`, plain JavaScript on Node 24 (chosen).** One repo, one language, one fleet. The Core talks to Houston only over a named pipe.
2. **A Core in Rust.** Memory safety and a small footprint suit a security service. Cost: a second language in a repo whose rules forbid even a TypeScript build, and nothing here to copy from.
3. **Everything inside Houston's main process.** Smallest diff. Cost: secrets and enforcement in the desktop process, and nothing runs when the window is shut.
4. **Fork an existing agent harness.** Gets an agent loop for free. Cost: tracking a fast-moving upstream, and enforcement would still sit inside the process being governed.

## Decision

Option 1.

- **The Core** is a background process started at logon. It owns the identity registry, grants, the policy decision, session launch, the MCP gateway, the secrets vault and the audit log. Its state is one SQLite database plus JSON-lines logs under its own data folder, which no session container can read.
- **Houston** is the Core's client. It lists identities and sessions, shows approval cards, and sends the operator's decisions over a named pipe whose ACL admits only the operator. It cannot start an agent, read a secret or execute an approved action itself.
- **Agents are other people's CLIs.** Codex and Claude Code first, then others, each described by a small adapter manifest. The app does not get its own agent loop. This also answers the open question "may the app start a CLI agent itself?": the Core starts them; Houston asks it to.
- **Containment is the operating system's.** Each session runs in a Microsoft Execution Containers process container with default-deny file and network policy. Where that is unavailable, sessions run on a write-restricted token and are labelled "limited containment". This half of the decision is **pending spike H0-S1**; if it fails on Windows 11 Home, a new ADR picks the fallback.
- **Identities and grants are rows.** Policy is a default-deny table. Each check takes `(principal, action, resource, context)` and returns allow, ask or deny with a rule id, so a policy engine can replace the table later without touching callers.
- **The gateway** is the only MCP endpoint a session sees: loopback HTTP, a random per-session bearer token, Host and Origin checked. It filters tool lists per identity, checks every call, starts stdio servers in their own containers with credentials in their environment, and never forwards an agent's token upstream or an upstream token to an agent.
- **Schedules stay with Cronsole.** A scheduled run calls `harness run --grant <id>`; the Core checks the standing grant and treats every "ask" as "deny".

## What changes in the rules

`AGENTS.md` is updated in the same change:

- A second listener is allowed: the Core's gateway on `127.0.0.1`. The Control API is a named pipe, not a port.
- `core/` follows the same conventions as `src/`: ES modules, JSDoc types, `node:test`, no bundler, no TypeScript build.
- New module rules for `core/`: `policy` and `audit` import nothing from `runner` or `gateway`; only `vault` touches secret values.
- The Won't list gains: a built-in agent loop, a home-made sandbox, chat-channel gateways, and installing code from a feed.

Nothing else on the Won't list moves. Electron stays, Project Hub and Cronsole are integrated and not rebuilt, and there is still no hosted backend, account, sync or telemetry.

## Exit cost

- Before H2: about two weeks. The spikes and the skeleton are small.
- After H2: identities, sessions and audit events reference each other and a policy version. Changing the model means migrating history; budget one to two weeks.
- Swapping the container mechanism: one to two weeks. Grants are stored in the Core's own format and compiled to the mechanism at launch.

## Cost

No hosting and no required service. Dependencies added to `core/`: the Execution Containers Node SDK (MIT), an MCP server library, a DPAPI binding, and SQLite. Each must be GPL-3.0-compatible and is named in the PR that adds it. Official Execution Containers builds send required diagnostic data to Microsoft; Settings must say so.

## Consequences

- An application identity is a container policy, not a Windows account. Two sessions are separated by policy, under the same user. The Identity Center shows which rung each identity runs on.
- A backend's in-process sub-agents share their parent's container and token. Only sub-agents the Core starts are separately contained.
- An agent can read the model credential its own CLI needs. Brokered credentials for MCP servers are out of its reach.
- A contained process may be able to reach other local services on loopback. Spike H0-S2 decides how that is closed, and abuse test AT-05 gates every contained launch.
- A host administrator, or malware running as the operator outside a container, can defeat all of this. The design defends the operator against their agents, not against their own account.
- Some work will not fit in a container. A broad-access identity runs unconfined, is marked as such everywhere it appears, and for it the gateway is an audit convenience, not a control.

---

<p align="center">
  <a href="README.md">← Decisions</a> ·
  <a href="adr-003-terminal-in-main.md">ADR-003</a> ·
  <a href="../product/harness-requirements.md">Harness requirements →</a>
</p>
