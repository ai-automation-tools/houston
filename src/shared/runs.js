// Managed runs: each terminal_run is one command in its own PowerShell session, and the
// session's exit code is the run's result. Nothing reads the output to decide whether it
// worked. Pure; the main process starts the sessions (src/main/terminal.js) and keeps
// one Runs for the app, saved to runs.json so the history outlives a restart.

import { appendOutput, cleanOutput } from './output.js';

export const RUNS_KEEP = 50;
/** Output kept per finished run, newest characters. */
export const RUN_OUTPUT_MAX = 50_000;
/** Changed files kept per run. */
export const CHANGED_MAX = 500;
export const RUN_LOG_PREFIX = 'acc://runlog/';

/**
 * The fixed script a run's PowerShell starts with (`-Command`). The command itself comes
 * in ACC_RUN_COMMAND, which the script reads and removes, so it never becomes a shell
 * argument and the command's own programs don't inherit it. It prints the command, runs
 * it in the session's scope, and exits with:
 *  - the code `exit N` gives, or 1 for a parse error or anything thrown;
 *  - else the last native program's exit code when it isn't 0;
 *  - else 1 if any PowerShell error was written, else 0.
 * The same in PowerShell 7 and Windows PowerShell 5.1.
 */
export const RUN_SCRIPT = [
  '$c = $env:ACC_RUN_COMMAND; Remove-Item Env:ACC_RUN_COMMAND',
  'Write-Host "> $c" -ForegroundColor DarkGray',
  '$global:LASTEXITCODE = 0; $Error.Clear()',
  'try { . ([scriptblock]::Create($c)) } catch { Write-Host $_ -ForegroundColor Red; exit 1 }',
  'exit $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($Error.Count) { 1 } else { 0 })',
].join('; ');

/**
 * @typedef {'running' | 'succeeded' | 'failed' | 'cancelled'} RunState
 * @typedef {{ run: number, terminal: number, command: string, cwd: string, state: RunState, exitCode: number | null, startedAt: number, endedAt: number | null, output: string | null, changed: string[] | null }} Run
 *   output: kept once it ends; while it runs, the terminal's buffer is the output.
 *   changed: the repo files whose git status the run changed, repo-relative; null when
 *   the folder isn't in a repo or the run hasn't ended
 * @typedef {{ run: number, command: string, cwd: string, state: RunState, exitCode: number | null, startedAt: number, endedAt: number | null, changed: string[] | null, match: string | null }} RunRow
 *   match: the first output line with the search text in it
 */

const STATES = ['running', 'succeeded', 'failed', 'cancelled'];

export class Runs {
  /** @param {unknown} [saved] runs.json as read, trusted for nothing */
  constructor(saved) {
    /** @type {Run[]} oldest first */
    this.list = cleanRuns(saved);
    this.nextId = Math.max(0, ...this.list.map((r) => r.run)) + 1;
  }

  /** @param {{ terminal: number, command: string, cwd: string }} p @returns {Run} */
  start({ terminal, command, cwd }, at = Date.now()) {
    const r = /** @type {Run} */ ({ run: this.nextId++, terminal, command, cwd, state: 'running', exitCode: null, startedAt: at, endedAt: null, output: null, changed: null });
    this.list.push(r);
    // Forget the oldest finished runs past the cap; a running one stays.
    while (this.list.length > RUNS_KEEP) {
      const i = this.list.findIndex((x) => x.state !== 'running');
      if (i < 0) break;
      this.list.splice(i, 1);
    }
    return r;
  }

  /** @param {number} [id] the newest run when left out */
  get(id) {
    return id === undefined ? this.list.at(-1) : this.list.find((r) => r.run === id);
  }

  /** @param {number} terminal */
  running(terminal) {
    return this.list.find((r) => r.terminal === terminal && r.state === 'running');
  }

  /**
   * The run's session exited: its code decides the result.
   * @param {number} terminal @param {number} exitCode @param {string | undefined} output
   */
  end(terminal, exitCode, output, at = Date.now()) {
    const r = this.running(terminal);
    if (r) Object.assign(r, { state: exitCode === 0 ? 'succeeded' : 'failed', exitCode, endedAt: at, output: keep(output) });
    return r;
  }

  /**
   * The user closed the run's terminal before it ended. There is no exit code to report.
   * @param {number} terminal @param {string | undefined} output
   */
  cancel(terminal, output, at = Date.now()) {
    const r = this.running(terminal);
    if (r) Object.assign(r, { state: 'cancelled', endedAt: at, output: keep(output) });
    return r;
  }
}

/** @param {string | undefined} raw */
const keep = (raw) => appendOutput('', raw ?? '', RUN_OUTPUT_MAX);

/**
 * What run_status reports, without the output, which the tool cleans and trims.
 * durationMs is null for a run the app quit during, which has no end time.
 * @param {Run} r
 */
export function runInfo(r, now = Date.now()) {
  const { output, ...rest } = r;
  return { ...rest, durationMs: r.endedAt === null && r.state !== 'running' ? null : (r.endedAt ?? now) - r.startedAt };
}

/**
 * runs.json as read: well-formed runs only, oldest first, capped. The file is
 * user-editable, so nothing in it is trusted. A run still marked running is one the app
 * quit during; it comes back cancelled, with no end time.
 * @param {unknown} raw
 * @returns {Run[]}
 */
export function cleanRuns(raw) {
  if (!Array.isArray(raw)) return [];
  const int = (/** @type {unknown} */ n) => Number.isSafeInteger(n);
  /** @type {Run[]} */
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object' || !int(r.run) || r.run < 1 || typeof r.command !== 'string' || typeof r.cwd !== 'string'
      || !STATES.includes(r.state) || !int(r.startedAt) || out.some((x) => x.run === r.run)) continue;
    const running = r.state === 'running';
    out.push({
      run: r.run,
      terminal: int(r.terminal) ? r.terminal : 0,
      command: r.command,
      cwd: r.cwd,
      state: running ? 'cancelled' : r.state,
      exitCode: int(r.exitCode) && !running ? r.exitCode : null,
      startedAt: r.startedAt,
      endedAt: int(r.endedAt) && !running ? r.endedAt : null,
      output: typeof r.output === 'string' ? r.output.slice(-RUN_OUTPUT_MAX) : null,
      changed: Array.isArray(r.changed) ? r.changed.filter((/** @type {unknown} */ f) => typeof f === 'string').slice(0, CHANGED_MAX) : null,
    });
  }
  return out.sort((a, b) => a.run - b.run).slice(-RUNS_KEEP);
}

/**
 * The files a run changed: every path whose `git status` entry differs between the
 * snapshot before it started and the one after it ended, sorted. Null without both.
 * ponytail: a file already modified before the run and modified again keeps the same
 * status, so it isn't listed; hashing the changed files' contents would catch it.
 * @param {import('./git.js').GitFile[] | null} before
 * @param {import('./git.js').GitFile[] | null} after
 * @returns {string[] | null}
 */
export function changedFiles(before, after) {
  if (!before || !after) return null;
  const key = (/** @type {import('./git.js').GitFile} */ f) => JSON.stringify([f.path, f.from, f.staged, f.unstaged, f.kind]);
  const was = new Set(before.map(key));
  const now = new Set(after.map(key));
  const paths = new Set([...after.filter((f) => !was.has(key(f))), ...before.filter((f) => !now.has(key(f)))].map((f) => f.path));
  return [...paths].sort().slice(0, CHANGED_MAX);
}

/**
 * The run history the MCP panel lists, newest first. With a query, only the runs whose
 * command, folder, changed files or output contain it (any case). A run found by its
 * output alone comes with the first line that has it; the output starts with the command
 * echoed, so one found by its command would only repeat that.
 * @param {Run[]} list oldest first
 * @param {string} [query]
 * @returns {RunRow[]}
 */
export function runRows(list, query = '') {
  const q = query.trim().toLowerCase();
  /** @type {RunRow[]} */
  const rows = [];
  for (const r of [...list].reverse()) {
    let match = null;
    if (q && ![r.command, r.cwd, ...(r.changed ?? [])].some((s) => s.toLowerCase().includes(q))) {
      const line = r.output && cleanOutput(r.output).split('\n').find((l) => l.toLowerCase().includes(q));
      if (!line) continue;
      match = line.trim().slice(0, 200);
    }
    rows.push({ run: r.run, command: r.command, cwd: r.cwd, state: r.state, exitCode: r.exitCode, startedAt: r.startedAt, endedAt: r.endedAt, changed: r.changed, match });
  }
  return rows;
}

/** A run's output page. @param {number} run */
export const runLogUrl = (run) => `${RUN_LOG_PREFIX}${run}`;

/** The run id in an acc://runlog/<id> address, or null. @param {string} url */
export function runIdFromUrl(url) {
  const m = /^acc:\/\/runlog\/(\d{1,9})\/?$/i.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * A run in a few words: running, how it ended and its exit code, or cancelled.
 * @param {{ state: RunState, exitCode: number | null }} r
 */
export function runStateText({ state, exitCode }) {
  if (state === 'running' || state === 'cancelled') return state;
  return `${state === 'succeeded' ? 'finished' : 'failed'}${exitCode === null ? '' : ` (exit ${exitCode})`}`;
}
