// Agent work that waits on the confirm bar (terminal_run, cron_run, tab_click, tab_fill): one entry per ask,
// from the bar to its end, with what was asked and exactly where it goes. Pure; the main
// process keeps one Activity, updates it as each ask is answered and each run ends, and
// the MCP panel shows activityRows().

export const ACTIVITY_KEEP = 50;

/**
 * @typedef {'waiting' | 'running' | 'started' | 'succeeded' | 'failed' | 'cancelled' | 'denied' | 'expired' | 'withdrawn'} WorkState
 *   waiting: on the confirm bar, or queued behind it; started: handed to Cronsole, whose
 *   own history has how it went; expired: nobody answered in time; withdrawn: the asker
 *   went away (its client disconnected, the chat's Stop)
 * @typedef {'command' | 'task' | 'page'} WorkKind
 * @typedef {{ id: number, kind: WorkKind, asked: string, target: string, state: WorkState, askedAt: number, endedAt: number | null, run: number | null, exitCode: number | null, error: string | null }} Work
 *   asked: the command, the task's name, or the click or typing on a page; target: the command's folder, the task's id, or the page's host
 * @typedef {{ id: number, kind: WorkKind, state: WorkState, open: boolean, icon: string, label: string, text: string, where: string, run: number | null, askedAt: number, endedAt: number | null, error: string | null }} WorkRow
 */

/** @param {WorkState} s */
const isOpen = (s) => s === 'waiting' || s === 'running';

export class Activity {
  constructor() {
    /** @type {Work[]} oldest first */
    this.list = [];
    this.nextId = 1;
  }

  /** @param {{ kind: WorkKind, asked: string, target: string }} p @returns {Work} */
  ask({ kind, asked, target }, at = Date.now()) {
    /** @type {Work} */
    const w = { id: this.nextId++, kind, asked, target, state: 'waiting', askedAt: at, endedAt: null, run: null, exitCode: null, error: null };
    this.list.push(w);
    // Forget the oldest finished work past the cap; open work stays.
    while (this.list.length > ACTIVITY_KEEP) {
      const i = this.list.findIndex((x) => !isOpen(x.state));
      if (i < 0) break;
      this.list.splice(i, 1);
    }
    return w;
  }

  /** @param {number} id */
  get(id) {
    return this.list.find((w) => w.id === id);
  }

  /**
   * The confirm bar settled: true for Run, false for Deny, null when nobody answered.
   * @param {number} id @param {boolean | null} answer @param {boolean} withdrawn the asker went away
   */
  answered(id, answer, withdrawn, at = Date.now()) {
    const w = this.get(id);
    if (!w || w.state !== 'waiting') return w;
    if (answer === true) w.state = 'running';
    else Object.assign(w, { state: answer === false ? 'denied' : withdrawn ? 'withdrawn' : 'expired', endedAt: at });
    return w;
  }

  /** A command started as managed run `run`. @param {number} id @param {number} run */
  ranAs(id, run) {
    const w = this.get(id);
    if (w) w.run = run;
    return w;
  }

  /**
   * A managed run ended (shared/runs.js): its state and exit code are the work's.
   * @param {import('./runs.js').Run} r
   */
  runEnded(r) {
    const w = this.list.find((x) => x.run === r.run && x.state === 'running');
    if (w) Object.assign(w, { state: r.state, exitCode: r.exitCode, endedAt: r.endedAt });
    return w;
  }

  /**
   * Running work ended some other way: a task handed to Cronsole, a page action done, or an error.
   * @param {number} id @param {'started' | 'succeeded' | 'failed'} state @param {string | null} [error]
   */
  settle(id, state, error = null, at = Date.now()) {
    const w = this.get(id);
    if (w && w.state === 'running') Object.assign(w, { state, error, endedAt: at });
    return w;
  }
}

/**
 * The MCP panel's rows, newest first. The oldest waiting ask is the one on the bar;
 * the others are queued behind it.
 * @param {Work[]} list oldest first
 * @returns {WorkRow[]}
 */
export function activityRows(list) {
  const onBar = list.find((w) => w.state === 'waiting');
  return list.map((w) => ({
    id: w.id,
    kind: w.kind,
    state: w.state,
    open: isOpen(w.state),
    icon: ICONS[w.state],
    label: w === onBar ? 'waiting for approval' : w.state === 'waiting' ? 'queued' : label(w),
    text: w.asked,
    where: w.kind === 'command' ? `its own PowerShell in ${w.target}` : w.kind === 'page' ? `the attached tab at ${w.target}` : `Cronsole task ${w.target}`,
    run: w.run,
    askedAt: w.askedAt,
    endedAt: w.endedAt,
    error: w.error,
  })).reverse();
}

/** @type {Record<WorkState, string>} */
const ICONS = { waiting: '?', running: '◌', started: '↗', succeeded: '✓', failed: '✗', cancelled: '■', denied: '–', expired: '–', withdrawn: '–' };

/** @param {Work} w */
function label(w) {
  switch (w.state) {
    case 'running': return w.run === null ? 'starting' : `running (run ${w.run})`;
    case 'started': return 'started in Cronsole';
    case 'succeeded': return w.kind === 'page' ? 'done' : 'finished (exit 0)';
    case 'failed': return w.exitCode === null ? 'failed' : `failed (exit ${w.exitCode})`;
    case 'cancelled': return 'cancelled';
    case 'denied': return 'denied';
    case 'expired': return 'not answered in time';
    case 'withdrawn': return 'withdrawn by its asker';
    default: return w.state;
  }
}
