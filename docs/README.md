<a id="docs-top"></a>

<h1 align="center">📚 Houston Docs</h1>

<p align="center">
  <em>Why the app is built the way it is, what's left, and what changed.</em>
</p>

<p align="center">
  <a href="ROADMAP.md"><img src="https://img.shields.io/badge/plan-ROADMAP-8B5CF6?style=for-the-badge" alt="Roadmap"></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.0-2ea44f?style=for-the-badge" alt="Version 0.1.0"></a>
  <a href="../README.md"><img src="https://img.shields.io/badge/↩-repository_root-6B7280?style=for-the-badge" alt="Repository root"></a>
</p>

---

Start with the roadmap if you want to know what's next, or the decisions folder if you want to know why the app looks like this. The business analysis that argued against building it, and the override that started the build, are kept outside this repo with the original build prompt. How to use the app is in the [guide](guide/README.md); how the code is laid out is in [src/](../src/README.md).

## 📖 Using the app

| Folder | What's inside |
|:---|:---|
| [**📖 guide/**](guide/README.md) | Setup, every feature in full, connecting Claude Code, the Chat and Cron tabs, the security model, and contributing. |
| [**🤖 mcp-server.md**](mcp-server.md) | The app's MCP server on one page: entry file, transport, install line, all sixteen tools and the variables they read. |

## 🗺️ Planning

| Document | What's inside |
|:---|:---|
| [**🗺️ ROADMAP.md**](ROADMAP.md) | What's done and what's next. The workbench milestones A to D are done or under way. Since 2026-11-12 the main line of work is the agent harness, milestones H0 to H7: H0 (the spikes) and H1 (the Core skeleton) closed that day, H3 (the MCP gateway and vault) on 2026-11-13; H2 waits on the owner's items, and H4 (standing grants) on the first nightly job's 5 nights. H5 (profiles, the Identity Center, sub-agents, quarantine profiles, broad-access identities) and H6 (Roundtable seats, skills, memory, local models, the Feed and start page) closed on 2026-11-13; H7 (hardening and release readiness) is under way: the abuse suite is a release gate and schema upgrades are tested with a backup first; the fallback containment rung waits on the owner. The `houston-roadmap` job works it one item per run. |
| [**📋 CHANGELOG.md**](CHANGELOG.md) | Every change, newest first. Everything since 0.1.0 (the 2026-09-29 Phase 1 slice) is still under Unreleased. |
| [**🔭 UPSTREAMS.md**](UPSTREAMS.md) | The outside services, protocols and packages the app depends on, what the code assumes about each, and where to check that it still holds. The biweekly upstream check works from it. |
| [**❓ OPEN-QUESTIONS.md**](OPEN-QUESTIONS.md) | Decisions the roadmap routine needs from Mike; an answered one is applied on the next run. Three harness questions are open and three were answered on 2026-11-12. |

## ⚖️ Design

| Folder | What's inside |
|:---|:---|
| [**🎯 product/**](product/README.md) | The spec (must stories with acceptance criteria, the Won't list), the agent-harness requirements, and the build plan with its stop points. |
| [**⚖️ decisions/**](decisions/README.md) | Requirements, three architecture options, four ADRs (the Electron shell, Project Hub over HTTP, the terminal, and the Core companion process for the agent harness), and the harness spike results. |
| [**🧭 diagrams/**](diagrams/README.md) | The architecture diagram the [homepage](https://houston.ai-automation-tools.dev/#architecture) shows, with every component linked to its code, and how to rebuild it when the code moves. |

<p align="right">(<a href="#docs-top">back to top</a>)</p>

---

<p align="center">
  <a href="../README.md">← Repository home</a> ·
  <a href="decisions/README.md">Decisions</a> ·
  <a href="ROADMAP.md">Next: Roadmap →</a>
</p>
