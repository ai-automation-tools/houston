# Open questions

Decisions only Mike can make, asked by the roadmap routine. Fill in an `- Answer:` line and the next run applies it.

## Open

### Provider adapters: which second provider, and may the app start a CLI agent itself?

- Asked: 2026-10-26 by ai-command-center-roadmap
- Context: Milestone D's "Provider adapters" puts the model API and CLI agents behind one contract (health, capabilities, invoke, cancel, events), Claude first. With Claude's Messages API as the only provider, the contract is an interface with one implementation, and the chat already works through `src/shared/chat.js`. The CLI half means Houston launching `claude`, `codex` or `opencode` itself, a new kind of process start: today the only things the app runs are fixed shells (`src/shared/shells.js`), the managed run's fixed script, Cronsole's server and the Dev tab's package manager, each pinned in AGENTS.md. Options: (a) build the contract with the API adapter only, and add CLI adapters later; (b) name the second provider (a CLI agent run headless in a workspace folder, or another model API) and write an ADR for how the app may start it (fixed executable from PATH's absolute entries, fixed arguments, prompt passed how, which tools it gets); (c) drop it: CLI agents already run in Houston's terminals and reach the app over MCP. Recommendation: (c) for now, or (b) if you want the chat pane to drive a CLI agent.
- Answer:

## Answered

### Should Houston build the per-client MCP tool switch, and what is it for?

- Asked: 2026-10-25 by ai-command-center-roadmap
- Context: Milestone D's "MCP clients by name" is done: every call in the MCP tab now names its client. The other half, a switch for which tools each client may call, can only key on the name a client gives itself, and every client shares the one per-launch token, so any local process could claim to be `claude-code`. Options: (a) build it as a preference, clearly labelled as not a security boundary (useful to stop, say, a second agent calling `terminal_run` at all); (b) per-client tokens, so a switch means something: each registration gets its own token in `mcp.json` or the bridge, which changes the "one token per launch" rule and needs an ADR; (c) drop it, since the acting tools already wait for a click. Recommendation: (c) for now, or (a) if you want it to cut confirm-bar noise from a client you don't use for running things.
- Answer: (c) Drop it for now: the acting tools already wait for a click, and a switch keyed on a self-declared client name is not a boundary. Revisit only with per-client tokens (b) and an ADR. (Mike, 2026-10-26)
- Applied: 2026-10-26 by ai-command-center-roadmap (the roadmap row is struck through as dropped)
