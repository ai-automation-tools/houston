<h1 align="center">🌿 Contributing</h1>

<p align="center">
  <em>Branches, checks, and how the roadmap routine works alongside you.</em>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-guide-6B7280?style=for-the-badge" alt="Back to the guide"></a>
</p>

---

## The checks

```powershell
npm run lint     # node --check on every JS file
npm test         # unit tests over src/shared/
npm run smoke    # the real app on a throwaway profile; add -- --live for the Hub and Cronsole checks
npm run demo     # builds the browser demo into _site/
```

- Branch from `main` and open a pull request against `main`.
- Keep `npm run lint` and `npm test` green. CI runs both, plus `npm audit`, on every push. `main` won't take a merge until `test (ubuntu-latest)`, `test (windows-latest)` and `audit` pass (a repository ruleset), so a change that renames those jobs or the OS list must update the ruleset too, or every PR waits forever.
- Run `npm run smoke` when you touch the main process, the preload or the shell UI. What it checks is in [tests/](../../tests/README.md).
- [AGENTS.md](../../AGENTS.md) has the standards, the security invariants and the list of things this project won't do.
- `core/` is the harness's Core process and follows the same conventions as `src/`. `spikes/` holds scripts run by hand from PowerShell against the real container SDK (the H0 spikes and the `h1-*` checks): nothing may import from it, and the `h1-*` scripts need `H1_ROOT` set to a scratch folder outside the user profile.

## The roadmap routine

- A scheduled routine (job `houston-roadmap`) opens PRs from `roadmap/auto-<date>` branches, one [roadmap](../ROADMAP.md) item at a time.
- An org-wide sweep reviews and merges them.
- The routine never changes dependencies. When a PR you merge changes `package.json`, quit the app and run `npm install` yourself.

---

<p align="center">
  <a href="security-model.md">← Security model</a> ·
  <a href="README.md">Guide →</a>
</p>
