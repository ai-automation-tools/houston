# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository ("Report a
vulnerability" under the Security tab). Don't open a public issue for anything that
could let a web page, an agent or another local process do more than the model below
allows. Expect an acknowledgement within a week.

The repository has been private since 2026-11-12. If you have access, the route above still applies.

## What the app promises

The full model, with file references, is in the README's
[security model](docs/guide/security-model.md) page and in `AGENTS.md`'s
security invariants, which every change has to keep. In short:

- **Web pages are untrusted.** Browser tabs run sandboxed with context isolation.
  The only preloads they get are the extension-API ones, which act only on
  `chrome-extension://` pages, and the ad blocker's, which only fetches the CSS that
  hides ad slots. They can't reach the shell UI's IPC, navigate to
  `javascript:`, `data:` or the app's own `acc://` pages, and every permission
  request (camera, microphone, location, notifications, devices) is denied unless it
  is on a short allowlist.
- **Nothing listens on the network** except the app's own MCP server, bound to
  `127.0.0.1` with a random port and a per-launch token. Calls without the token, or
  with a non-loopback `Host` or `Origin` header, are refused and logged. Malformed
  requests get a JSON-RPC error, never an unhandled exception.
- **No shell path or argument crosses a trust boundary.** Terminal shells are fixed
  profiles; the UI picks a folder and a profile id. An agent's `terminal_run` shows
  the command and folder and runs it only after the user clicks Run, in a new
  terminal opened for it; the command never leaves the main process.
- **Secrets stay out of the repo and the renderer.** The chat's API key is read from
  the gitignored `.env` (or the environment) by the main process, kept out of the
  terminals' and Cronsole's environment, and sent only to the model's API. The MCP
  token lives in `%APPDATA%\ai-command-center\mcp.json` with owner-only permissions
  and is deleted on quit.

**Not yet promised.** The agent harness planned in
[ADR-004](docs/decisions/adr-004-core-companion-process.md) (agents as identities in OS
containers, an MCP gateway, a vault, an audit log) is partly built under `core/`: the audit
log, the policy check, the container launch defaults and the egress proxy exist and are
tested, but nothing starts an agent with them yet. Nothing above changes until it ships, and its own threat model is in
[harness-requirements.md](docs/product/harness-requirements.md).

## Secret scanning

The whole history is scanned with [gitleaks](https://github.com/gitleaks/gitleaks)
before a release:

```powershell
gitleaks git --no-banner --redact .
```

Last run: 2026-10-05, 17 commits, no leaks found. GitHub secret scanning and push
protection are on for the repository as well.

## Supported versions

Only the latest commit on `main` is supported. Electron is bumped at least every
24 weeks so the app keeps Chromium's security fixes; `docs/decisions/adr-001-electron-shell.md`
has the upgrade checklist and the known open advisories.
