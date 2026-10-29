<h1 align="center">⏱️ Cronsole in the Sidebar</h1>

<p align="center">
  <em>Cronsole's scheduled tasks in the Cron tab, and its UI in a pinned tab.</em>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-guide-6B7280?style=for-the-badge" alt="Back to the guide"></a>
</p>

---

## Set it up

Point the app at the MCP server's entry script in a [Cronsole](https://github.com/ai-automation-tools/cronsole) checkout, in `.env`, then restart the app:

```ini
ACC_CRONSOLE_MCP=<cronsole>/mcp-server/dist/index.js
```

- Cronsole's backend has to be running.
- The server runs on the app's own Electron binary in Node mode. It gets the app's environment and `.env` minus the chat key, so it finds `CRONSOLE_TOKEN` and `CRONSOLE_API_URL` the way it does under Claude Code.
- Cronsole's UI opens from `http://localhost:7373`. Set `ACC_CRONSOLE_UI` if yours is elsewhere.

## What the Cron tab shows

| Do | What happens |
|:---|:---|
| Look at the tab's label | A red count of active tasks whose last run failed, checked at start and every minute with the Hub dot; hover it for their names. Paused and missing tasks aren't counted |
| Open the tab | Lists `list_tasks`: next run, paused, missing or failed, details on hover |
| Click a task | Unfolds its last five runs: when, how it went, how long |
| Click a run | Opens `acc://run/<task>/<run>` in a tab: the run's log, or for a platform run (a Claude routine, a GitHub Action) what `get_run_output` returns |
| **Open Cronsole** | Shows Cronsole's UI in a pinned tab, first in the strip, with no close button (Ctrl+W still closes it) |
| **Refresh** | Asks Cronsole again |
| **Docs** | The docs upkeep view: only the tasks with doc, docs, documentation, readme, changelog or diagram as a word in their name. Click a task for its runs and a run for its report. Click **Docs** again for every task |

- Only runs Cronsole performed are listed. A Windows task that fires on its own trigger shows none here; Cronsole's UI has those.
- A tab on Cronsole's address is the pinned tab. **Open Cronsole** goes back to it instead of opening another.
- With `ACC_CRONSOLE_MCP` set, the server starts with the app, for the count, and stops when the app quits.

## Agents

- `cron_tasks` gives an agent the same list.
- `cron_run` starts a task by id once you click Run on the bar over the terminal, which shows the task's name.

---

<p align="center">
  <a href="chat.md">← Chat</a> ·
  <a href="security-model.md">Next: Security model →</a>
</p>
