<h1 align="center">🛡️ The Core at logon</h1>

<p align="center">
  <em>Run the harness's Core in the background from the moment you log on, with no window, and check, stop or remove it.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runs_on-Windows_11-0078D4?style=for-the-badge" alt="Runs on Windows 11">
  <img src="https://img.shields.io/badge/milestone-Harness_H1-8B5CF6?style=for-the-badge" alt="Milestone: Harness H1">
  <a href="README.md"><img src="https://img.shields.io/badge/↩-user_guide-6B7280?style=for-the-badge" alt="Back to the user guide"></a>
</p>

---

The Core is the harness's background process ([what it does](../../core/README.md)). Agents start through it, and it has to be running before the window can ask it for anything (from H2). A Scheduled Task starts it when you log on, from this checkout, with no window.

## 🚀 Turn it on

From the repository folder, with `npm install` done:

```powershell
pwsh -NoProfile -File scripts\Register-HoustonCore.ps1 -StartNow
```

```text
Registered \Houston\Houston Core: at logon, C:\Program Files\nodejs\node.exe <repo>\core\main.js
core.log: {"time":"...","event":"core.start","pid":41656,"dir":"...\\houston-core","schema":{"from":3,"to":3},...}
```

The task runs as you, not elevated, from your next logon on. `-StartNow` also starts it now and waits for its first line in the log. Run the script again after moving the checkout or changing Node: it updates the task in place. `-TaskPath` and `-TaskName` put it somewhere else in Task Scheduler (default `\Houston\Houston Core`).

What the task runs: `conhost.exe --headless node.exe core\main.js --exit-with-parent`. `conhost --headless` gives Node a console nobody sees, so no window appears.

## 🔍 Check it

```powershell
npm run ctl -- session.list                      # [] means the Core is up and answering
Get-Content "$env:LOCALAPPDATA\houston-core\core.log" -Tail 3
```

`core.log` in the data folder has one line per start (`core.start`), stop (`core.stop`, with why) and failure to start (`core.error`). With no console, it's the only place a startup error shows.

Task Scheduler shows **Last Run Result** `0x41301` (the task is running) while the Core is up.

## ⏹️ Stop, start, remove

| To | Do |
|:---|:---|
| Stop it | **End** the task in Task Scheduler, or `Stop-ScheduledTask -TaskPath '\Houston\' -TaskName 'Houston Core'` |
| Start it again | **Run** the task, or `Start-ScheduledTask` with the same names |
| Remove it | `pwsh -NoProfile -File scripts\Register-HoustonCore.ps1 -Unregister` |

Ending the task stops the Core **cleanly**. Ending the task ends `conhost`, but not Node. `--exit-with-parent` makes the Core check every two seconds whether the process that started it still exists, so within a few seconds of the task ending it notices. It then stops every session, closes the Control API (deleting `control.json`), writes `core.stop` and exits.

Killing `node.exe` itself instead is a crash. The Core's containers end with it, and the next start records those sessions as `interrupted` ([why](../../core/README.md)).

## 🔄 After pulling new code

The task runs the files in this checkout, so a `git pull` takes effect at the next start. Stop and start the task, or log off and on. If `package.json` changed, run `npm install` first.

## 🩺 When it doesn't start

| `core.log` says | It means |
|:---|:---|
| `core.error` with `"alreadyRunning":true` | Another Core holds the data folder, maybe one you started with `npm run core`. Stop that one first |
| `core.error` with another message | Read the message. To watch it start, stop the task and run `npm run core` in a terminal |
| Nothing new after a start | Node didn't run at all: check the task's **Actions** still point at a real `node.exe` and `core\main.js`, and run the script again |

The script refuses to register if `node_modules` is missing (`Dependencies aren't installed`).

## 📁 Where things are

| What | Where |
|:---|:---|
| Data folder (database, audit log, `control.json`, `core.log`) | `%LOCALAPPDATA%\houston-core`, or `HOUSTON_CORE_DATA`. Only you and SYSTEM can open it |
| Session temp folders | `%ProgramData%\houston-core\sessions`, or `HOUSTON_SESSION_TEMP` |
| The task | `\Houston\Houston Core` in Task Scheduler |

`HOUSTON_CORE_DATA` and `HOUSTON_SESSION_TEMP` are read from the environment the task starts in. Leave them unset to use the defaults.

---

<p align="center">
  <a href="security-model.md">← Security model</a> ·
  <a href="README.md">User guide</a> ·
  <a href="contributing.md">Contributing →</a>
</p>
