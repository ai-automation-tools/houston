<h1 align="center">💻 ADR-003: Terminal in the Main Process</h1>

<p align="center">
  <em>node-pty runs PowerShell in the main process; the renderer can choose a folder and nothing else.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-accepted-2ea44f?style=for-the-badge" alt="Status: accepted">
  <img src="https://img.shields.io/badge/door-two--way-2ea44f?style=for-the-badge" alt="Two-way door">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-decisions-6B7280?style=for-the-badge" alt="Back to decisions"></a>
</p>

---

**Date:** 2026-09-29

## Decision

- **node-pty 1.1.0** spawns `C:\Program Files\PowerShell\7\pwsh.exe -NoLogo` (falling back to `pwsh.exe`, then Windows PowerShell) in the main process, through ConPTY using the **bundled `conpty.dll`** (`useConptyDll: true`).
- **xterm.js 6** renders it in the shell, with the fit addon for resizing.
- The renderer can ask for a new terminal with a **starting folder**. The executable and its arguments are fixed in `src/main/terminal.js`. A folder that doesn't exist falls back to the home folder.

## Why

- **No page can start a shell with chosen arguments.** Browser tabs have no IPC access, and even the shell can only pick a folder. This carries over the rule from the Project Control Center's ADR-004, written after looking at how ttyd's URL arguments could be abused.
- **No native build step.** node-pty 1.1.0 ships N-API prebuilds that load in Electron 44 and 45 without `electron-rebuild` (verified on this machine; 45 on 2026-10-27). That removes the Visual Studio toolchain from setup.
- **The bundled ConPTY avoids two bugs found in testing.** With Windows' own ConPTY, killing a session forks node-pty's console-list helper, which crashed with `AttachConsole failed` during app shutdown and left the app running. The bundled `conpty.dll` path kills without the helper.

## Consequences

- **The app calls `app.exit(0)` on quit.** Even with the bundled ConPTY, node-pty's output reader thread outlives its session and the process never exits on its own. By the `quit` event every window is closed and every session killed, so exiting explicitly is safe. Found by `npm run smoke` timing out.
- **Keyboard ownership.** PowerShell uses Ctrl+L (clear) and Ctrl+R (history search), so the app menu doesn't take them. Browser tabs map Ctrl+L and Ctrl+R themselves; the address bar also answers to Alt+D. Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+V pastes.
- **Two-way door.** Swapping the renderer or the pty library touches `src/main/terminal.js` and `src/renderer/terminal.js` only.

## Update 2026-10-20: where `terminal_run` types

Until now an approved command went into the active terminal, picked by the renderer when Run was clicked. That terminal could hold half-typed input, be running `claude` or another program that would take the line as its own input, or have changed folder, and switching tabs while the bar was up changed the target after the bar had named it.

**Now:** the main process fixes the command and the folder (the agent's `cwd`, else the folder the active terminal started in, else home) when the ask is made, and the bar names both. Run opens a new PowerShell terminal in that folder; main types the command only if the id that comes back is a terminal opened after the ask, still running PowerShell, in that folder (`isFreshRunTarget` in `src/shared/confirm.js`), and refuses otherwise. The click-to-run rule is unchanged. The cost is a terminal tab per run; a managed runner with exit codes (roadmap Milestone D) is the longer-term answer.

## Update 2026-10-21: managed runs

Typing a command into an interactive shell never tells the app when it finished or how. Agents read the output and guessed.

**Now:** each `terminal_run` is a run with an id. On Run, main opens the run's own PowerShell session (the 2026-10-20 rule, minus the round trip: the renderer no longer opens the terminal, it attaches a tab to the one main opened). Instead of `-NoLogo` and a prompt, that session starts with `-NoLogo -Command <RUN_SCRIPT>`, a fixed script in `src/shared/runs.js`, and the confirmed command goes in the `ACC_RUN_COMMAND` environment variable, which the script removes before running it. The shell's arguments stay fixed; only main sets the variable, from the command it held since the ask. The script echoes the command, runs it, and exits; the session's exit code is the run's result:

- `exit N` gives N; a parse error or anything thrown gives 1;
- otherwise the last native program's exit code when it isn't 0;
- otherwise 1 if PowerShell wrote any error, else 0.

The same rule holds in PowerShell 7 and 5.1 (checked case by case). `run_status` reports the state (running, succeeded, failed, cancelled), exit code, times and the last lines of output. Closing a run's tab while it runs is its Cancel: the app ends the session's process tree by its pid, and the run is cancelled with no exit code. `isFreshRunTarget` is gone, since nothing is typed into a shell the renderer chose.

**Trade-offs:** a run's terminal is no longer interactive once the command ends, and the command runs in a script block rather than at a prompt, so PSReadLine and prompt functions don't apply. Ctrl+C still interrupts the command, which then counts as failed.

---

<p align="center">
  <a href="adr-002-hub-over-http.md">← ADR-002</a> ·
  <a href="README.md">Decisions →</a>
</p>
