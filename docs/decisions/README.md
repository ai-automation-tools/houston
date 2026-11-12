<h1 align="center">⚖️ Decisions</h1>

<p align="center">
  <em>What the app has to do, how it's built, and the three choices that are costly to undo.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/ADRs-3-8B5CF6?style=for-the-badge" alt="3 ADRs">
  <a href="../README.md"><img src="https://img.shields.io/badge/↩-docs_home-6B7280?style=for-the-badge" alt="Back to docs"></a>
</p>

---

Read in order. The requirements set what matters, the options pick the shape, and each ADR records one decision with what it costs. ADRs aren't edited to look smarter afterwards; a changed decision gets a new ADR that supersedes the old one.

| Document | What it settles |
|:---|:---|
| [**📋 requirements.md**](requirements.md) | All 16 features ranked. Browser, terminal, sidebar and extensions are Phase 1 musts; the harness is Phase 2; the IDE pane and feeds are Phase 3. |
| [**🏗️ architecture-options.md**](architecture-options.md) | Electron shell vs. a BrowserOS fork vs. VS Code as the shell. Electron wins on cost; its weak spot is MV3 extensions. |
| [**🧱 adr-001-electron-shell.md**](adr-001-electron-shell.md) | The runtime, the GPL-3.0 extension library, and the spike. MV3 extension workers crashed until the 2026-10-20 update, which traced it to the `browser` namespace; what still doesn't work is listed there. |
| [**🔗 adr-002-hub-over-http.md**](adr-002-hub-over-http.md) | Files and bookmarks come from Project Hub's API, called from the main process so Hub's same-origin guard needs no change. |
| [**💻 adr-003-terminal-in-main.md**](adr-003-terminal-in-main.md) | node-pty with the bundled ConPTY, a fixed shell, and the renderer only picks a folder. Why the app calls `app.exit(0)` on quit, (2026-10-20) why `terminal_run` gets a fresh terminal of its own, and (2026-10-21) how a run's exit code becomes its result. |
| [**🛡️ adr-004-core-companion-process.md**](adr-004-core-companion-process.md) | A second process, the Core, launches agent CLIs as identities in OS containers, decides policy, runs the MCP gateway, holds secrets and writes audit. Houston is its client. Containment is pending spike H0-S1. |

---

<p align="center">
  <a href="../README.md">← Docs home</a> ·
  <a href="../ROADMAP.md">Roadmap →</a>
</p>
