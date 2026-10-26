# Open questions

Decisions only Mike can make, asked by the roadmap routine. Fill in an `- Answer:` line and the next run applies it.

## Open

### Should Houston build the per-client MCP tool switch, and what is it for?

- Asked: 2026-10-25 by ai-command-center-roadmap
- Context: Milestone D's "MCP clients by name" is done: every call in the MCP tab now names its client. The other half, a switch for which tools each client may call, can only key on the name a client gives itself, and every client shares the one per-launch token, so any local process could claim to be `claude-code`. Options: (a) build it as a preference, clearly labelled as not a security boundary (useful to stop, say, a second agent calling `terminal_run` at all); (b) per-client tokens, so a switch means something: each registration gets its own token in `mcp.json` or the bridge, which changes the "one token per launch" rule and needs an ADR; (c) drop it, since the acting tools already wait for a click. Recommendation: (c) for now, or (a) if you want it to cut confirm-bar noise from a client you don't use for running things.
- Answer:

## Answered
