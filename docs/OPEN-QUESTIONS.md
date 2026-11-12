# Open questions

Decisions only the owner can make, asked by the roadmap routine. Fill in an `- Answer:` line and the next run applies it.

## Open

### Provider adapters: which second provider, and may the app start a CLI agent itself?

- Asked: 2026-10-26 by ai-command-center-roadmap
- Context: Milestone D's "Provider adapters" puts the model API and CLI agents behind one contract (health, capabilities, invoke, cancel, events), Claude first. With Claude's Messages API as the only provider, the contract is an interface with one implementation, and the chat already works through `src/shared/chat.js`. The CLI half means Houston launching `claude`, `codex` or `opencode` itself, a new kind of process start: today the only things the app runs are fixed shells (`src/shared/shells.js`), the managed run's fixed script, Cronsole's server and the Dev tab's package manager, each pinned in AGENTS.md. Options: (a) build the contract with the API adapter only, and add CLI adapters later; (b) name the second provider (a CLI agent run headless in a workspace folder, or another model API) and write an ADR for how the app may start it (fixed executable from PATH's absolute entries, fixed arguments, prompt passed how, which tools it gets); (c) drop it: CLI agents already run in Houston's terminals and reach the app over MCP. Recommendation: (c) for now, or (b) if you want the chat pane to drive a CLI agent.
- Partly answered 2026-11-12 by [ADR-004](decisions/adr-004-core-companion-process.md): the Core starts agent CLIs and Houston asks it to. The second-provider half is still open.
- Answer:

### Harness: which fallback if process containers fail on Windows 11 Home?

- Asked: 2026-11-12 with ADR-004
- Context: spike H0-S1 tests Microsoft Execution Containers on Home. If it fails, the options are (a) dedicated local Windows accounts plus firewall rules, which need a one-time admin setup, or (b) shrink the harness to the gateway, identities and audit with no file containment. Only needed if S1 fails.
- Note 2026-11-12: S1 ran and containers work on Home ([results](decisions/spikes/2026-11-12-h0-spike-results.md)). This only matters if the slowdown below is rejected.
- Answer:

### Harness: is the container slowdown acceptable?

- Asked: 2026-11-12 with the H0 spike results
- Context: the bar was 1.3x. Measured: `git status` 1.19x, `node --test` 1.15x, `pytest` 1.45x, `npm install` 1.58x on 163 packages (about 1.5 seconds extra) and 1.96x on 2. Recommendation: accept it; the cost is seconds on installs and nothing suggests worse than 2x.
- Answer:

### Harness: may a test container be granted an agent's sign-in folder?

- Asked: 2026-11-12 with the H0 spike results
- Context: spike S3's last step runs Claude Code and Codex signed in, inside a container, for 10 minutes each. Their sign-in files are in the user profile, so the container needs read and write on each CLI's own config folder. ADR-004 already accepts that an agent can read its own model credential. Recommendation: yes, for those two folders only.
- Answer:

### Harness: are the draft Core schemas right?

- Asked: 2026-11-12 with the H0 spike results
- Context: `core/schemas/` holds draft identity, policy-request and audit-event schemas. Three choices to confirm: a third decision value `ask`, no tenant field, and identity ids shaped `local:<slug>`. Recommendation: accept all three.
- Answer:

### Harness: is a one-time admin setup acceptable later?

- Asked: 2026-11-12 with ADR-004
- Context: per-agent Windows accounts and runs while logged off both need admin rights once. The MVP needs none. Recommendation: not before H4 is in use.
- Answer:

### Harness: which backends after Codex and Claude Code?

- Asked: 2026-11-12 with ADR-004
- Context: H2 ships adapters for Codex and Claude Code. Each further agent CLI is a manifest and a contract test. Recommendation: decide after a week of H2 use.
- Answer:

## Answered

### Should Houston build the per-client MCP tool switch, and what is it for?

- Asked: 2026-10-25 by ai-command-center-roadmap
- Context: Milestone D's "MCP clients by name" is done: every call in the MCP tab now names its client. The other half, a switch for which tools each client may call, can only key on the name a client gives itself, and every client shares the one per-launch token, so any local process could claim to be `claude-code`. Options: (a) build it as a preference, clearly labelled as not a security boundary (useful to stop, say, a second agent calling `terminal_run` at all); (b) per-client tokens, so a switch means something: each registration gets its own token in `mcp.json` or the bridge, which changes the "one token per launch" rule and needs an ADR; (c) drop it, since the acting tools already wait for a click. Recommendation: (c) for now, or (a) if you want it to cut confirm-bar noise from a client you don't use for running things.
- Answer: (c) Drop it for now: the acting tools already wait for a click, and a switch keyed on a self-declared client name is not a boundary. Revisit only with per-client tokens (b) and an ADR. (Mike, 2026-10-26)
- Applied: 2026-10-26 by ai-command-center-roadmap (the roadmap row is struck through as dropped)
