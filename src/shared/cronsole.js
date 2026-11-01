// Cronsole in the app: its task list and run history through Cronsole's own MCP server
// (a stdio process, newline-delimited JSON-RPC), a run's output as an acc://run page,
// and its web UI in a pinned tab. No Electron here, and nothing Node-only either: the
// shell UI imports isCronsoleUrl. src/main/cronsole.js starts the process and holds the client.
export const DEFAULT_UI = 'http://localhost:7373';
export const RUN_PREFIX = 'acc://run/';
const TIMEOUT_MS = 20_000;
const MAX_TASKS = 500;
const MAX_TASK_ID = 200;
const MAX_RUNS = 5;
const MAX_OUTPUT = 20_000;
const PROTOCOL_VERSION = '2025-06-18';

/**
 * @typedef {{ id: string, name: string, platform: string, schedule: string | null, status: string,
 *   nextRunTime: string | null, lastRunStatus: string | null, lastRunAt: string | null }} CronTask
 * @typedef {{ id: string, status: string, triggeredAt: string | null, durationMs: number | null,
 *   log: string | null, platformRunId: string | null }} CronRun
 */

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Where Cronsole is. ACC_CRONSOLE_MCP is the path to its MCP server's entry script
 * (`mcp-server/dist/index.js` in a Cronsole checkout); unset means no task list.
 * ACC_CRONSOLE_UI is its web UI, http or https only, else Cronsole's default port.
 * @param {Record<string, string | undefined>} env
 */
export function cronsoleConfig(env) {
  const server = (env.ACC_CRONSOLE_MCP || '').trim().replace(/^"(.*)"$/, '$1');
  return { server, ui: uiOrigin(env.ACC_CRONSOLE_UI) };
}

/** @param {string | undefined} raw */
function uiOrigin(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch { /* fall through */ }
  return DEFAULT_UI;
}

/**
 * Whether a tab is showing Cronsole's UI, which makes it the pinned tab.
 * @param {string} url
 * @param {string} ui origin from cronsoleConfig
 */
export function isCronsoleUrl(url, ui) {
  try {
    return new URL(url).origin === ui;
  } catch {
    return false;
  }
}

/**
 * A JSON-RPC client over a stdio stream: `write` sends one line, `receive` takes
 * whatever the process printed. Lines that aren't JSON-RPC answers to a pending
 * request (server requests, notifications, stray logs) are ignored.
 * @param {(line: string) => void} write
 * @param {number} [timeoutMs]
 */
export function stdioRpc(write, timeoutMs = TIMEOUT_MS) {
  let nextId = 0;
  let buffer = '';
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();

  return {
    /** @param {string} method @param {object} [params] @returns {Promise<any>} */
    request(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Cronsole's MCP server didn't answer ${method} within ${timeoutMs / 1000} s`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },

    /** @param {string} method @param {object} [params] */
    notify(method, params = {}) {
      write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },

    /** @param {string} chunk */
    receive(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = /** @type {string} */ (lines.pop());
      for (const line of lines) {
        /** @type {any} */
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = typeof msg?.id === 'number' && !('method' in msg) ? pending.get(msg.id) : undefined;
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`Cronsole's MCP server: ${msg.error.message || 'error'}`));
        else p.resolve(msg.result);
      }
    },

    /** Fail everything still waiting, e.g. when the process exits. @param {Error} err */
    fail(err) {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
      buffer = '';
    },
  };
}

/** The handshake MCP requires before tools/call. @param {ReturnType<typeof stdioRpc>} rpc @param {string} version */
export async function initialize(rpc, version) {
  await rpc.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'ai-command-center', version },
  });
  rpc.notify('notifications/initialized');
}

/** @param {ReturnType<typeof stdioRpc>} rpc */
export async function listTasks(rpc) {
  return taskRows(await rpc.request('tools/call', { name: 'list_tasks', arguments: { limit: MAX_TASKS } }));
}

/**
 * A Cronsole task id as list_tasks returns it: short, printable, one line.
 * @param {unknown} value
 */
export function taskIdArg(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TASK_ID || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`task must be a Cronsole task id from cron_tasks (at most ${MAX_TASK_ID} characters)`);
  }
  return value.trim();
}

/**
 * Start a task now through Cronsole's run_task, for the cron_run tool. Cronsole runs
 * its native jobs inside the call, so the result can say the job ran and failed; that
 * is a finding, not a tool error.
 * @param {ReturnType<typeof stdioRpc>} rpc
 * @param {string} taskId
 */
export async function runTask(rpc, taskId) {
  const result = await rpc.request('tools/call', { name: 'run_task', arguments: { taskId } });
  const text = toolText(result);
  if (result?.isError) throw new Error(text || 'Cronsole refused run_task');
  return result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : { text };
}

/** The text parts of a tools/call result. @param {any} result */
function toolText(result) {
  return Array.isArray(result?.content) ? result.content.map((/** @type {any} */ c) => c?.text).filter(Boolean).join('\n') : '';
}

/**
 * list_tasks' result as rows for the sidebar. A tool error throws its text; anything
 * malformed in a row becomes null or is dropped, since this is another program's output.
 * @param {any} result
 * @returns {CronTask[]}
 */
export function taskRows(result) {
  if (result?.isError) throw new Error(toolText(result) || 'Cronsole refused list_tasks');
  const tasks = result?.structuredContent?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => str(t?.id) && str(t?.name))
    .map((t) => ({
      id: t.id,
      name: t.name,
      platform: str(t.platform) || 'UNKNOWN',
      schedule: str(t.schedule),
      status: str(t.status) || 'UNKNOWN',
      nextRunTime: str(t.nextRunTime),
      lastRunStatus: str(t.lastRunStatus),
      lastRunAt: str(t.lastRunAt),
    }));
}

/**
 * How the sidebar shows a task: an icon, a short note on the right (the next run, or
 * why it won't run) and the full details for the tooltip.
 * @param {CronTask} t
 * @param {number} now ms since the epoch
 */
export function taskSummary(t, now) {
  const failed = /fail|error/i.test(t.lastRunStatus || '');
  const icon = t.status === 'DISABLED' ? '⏸' : t.status === 'MISSING' ? '⚠' : failed ? '✗' : '⏱';
  const next = t.nextRunTime ? Date.parse(t.nextRunTime) : NaN;
  const sub = t.status !== 'ACTIVE' ? t.status.toLowerCase()
    : Number.isFinite(next) ? (next > now ? `in ${span(next - now)}` : 'due')
      : t.schedule || '';
  const title = [
    `${t.name}  [${t.platform}]`,
    t.schedule && `Schedule: ${t.schedule}`,
    `Status: ${t.status}`,
    t.nextRunTime && `Next run: ${t.nextRunTime}`,
    t.lastRunAt && `Last run: ${t.lastRunAt}${t.lastRunStatus ? ` (${t.lastRunStatus})` : ''}`,
  ].filter(Boolean).join('\n');
  return { icon, sub, title, failed };
}

/**
 * The tasks whose last run failed, for the Cron tab's label. A paused or missing task
 * won't run again as it is, so it isn't counted.
 * @param {CronTask[]} tasks
 */
export function failedTasks(tasks) {
  return tasks.filter((t) => t.status === 'ACTIVE' && taskSummary(t, 0).failed);
}

/** A whole word that names a docs job: doc, docs, documentation, readme, changelog, diagram(s). */
const DOCS_WORD = /(?:^|[^a-z])(?:docs?|documentation|readme|changelog|diagrams?)(?:[^a-z]|$)/i;

/**
 * The docs-upkeep jobs, for the Cron tab's Docs filter: tasks whose name says they keep
 * docs current ("Docs link check", "README refresh", "diagram-upkeep"). By name only,
 * since Cronsole has no tags; "Dockerfile lint" and "Roadmap routine" aren't docs jobs.
 * @param {CronTask[]} tasks
 */
export function docsTasks(tasks) {
  return tasks.filter((t) => DOCS_WORD.test(t.name));
}

/**
 * A task's last few runs, newest first, through Cronsole's get_task_history. Only runs
 * Cronsole performed are there; a Windows task firing on its own trigger isn't.
 * @param {ReturnType<typeof stdioRpc>} rpc
 * @param {string} taskId
 */
export async function taskHistory(rpc, taskId) {
  return runRows(await rpc.request('tools/call', { name: 'get_task_history', arguments: { taskId, limit: MAX_RUNS } }));
}

/**
 * get_task_history's result as rows. A tool error throws its text; malformed rows are
 * dropped or nulled, like taskRows.
 * @param {any} result
 * @returns {CronRun[]}
 */
export function runRows(result) {
  if (result?.isError) throw new Error(toolText(result) || 'Cronsole refused get_task_history');
  const runs = result?.structuredContent?.runs;
  if (!Array.isArray(runs)) return [];
  return runs
    .filter((r) => str(r?.id))
    .slice(0, MAX_RUNS)
    .map((r) => ({
      id: r.id,
      status: str(r.status) || 'UNKNOWN',
      triggeredAt: str(r.triggeredAt),
      durationMs: Number.isFinite(r.durationMs) ? r.durationMs : null,
      log: str(r.log),
      platformRunId: str(r.platformRunId),
    }));
}

/**
 * What a platform run produced, through Cronsole's get_run_output: its steps, final
 * text and counts as Cronsole words them. Content from another program, shown as text.
 * @param {ReturnType<typeof stdioRpc>} rpc
 * @param {string} taskId
 * @param {string} platformRunId
 */
export async function runOutput(rpc, taskId, platformRunId) {
  const result = await rpc.request('tools/call', { name: 'get_run_output', arguments: { taskId, runId: platformRunId, maxChars: MAX_OUTPUT } });
  const text = toolText(result);
  if (result?.isError) throw new Error(text || 'Cronsole refused get_run_output');
  return text;
}

/** The page showing one run's output. @param {string} taskId @param {string} runId */
export function runUrl(taskId, runId) {
  return `${RUN_PREFIX}${encodeURIComponent(taskId)}/${encodeURIComponent(runId)}`;
}

/**
 * The task and run an acc://run URL names. Throws for anything else.
 * @param {string} url
 */
export function runFromUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'acc:' || u.host !== 'run') throw new Error('not a run URL');
  const parts = u.pathname.slice(1).split('/');
  if (parts.length !== 2) throw new Error('a run URL is acc://run/<task id>/<run id>');
  let ids;
  try {
    ids = parts.map(decodeURIComponent);
  } catch {
    throw new Error('badly encoded run URL');
  }
  return { taskId: taskIdArg(ids[0]), runId: taskIdArg(ids[1]) };
}

/**
 * How the sidebar shows a run under its task: an icon, when and how it went, and a tooltip.
 * @param {CronRun} r
 * @param {number} now ms since the epoch
 */
export function runSummary(r, now) {
  const failed = /fail|error|timeout/i.test(r.status);
  const icon = failed ? '✗' : r.status === 'SUCCESS' ? '✓' : r.status === 'PENDING' ? '…' : '•';
  const at = r.triggeredAt ? Date.parse(r.triggeredAt) : NaN;
  const when = Number.isFinite(at) ? (now - at < 60_000 ? 'just now' : `${span(now - at)} ago`) : 'unknown time';
  const took = r.durationMs !== null ? ` · ${duration(r.durationMs)}` : '';
  const text = `${when} · ${r.status.toLowerCase()}${took}`;
  const title = [r.triggeredAt && `Started: ${r.triggeredAt}`, `Status: ${r.status}`, r.durationMs !== null && `Took: ${duration(r.durationMs)}`, 'Click to show its output']
    .filter(Boolean).join('\n');
  return { icon, text, title, failed };
}

/** @param {number} ms */
function duration(ms) {
  if (ms < 1000) return `${Math.max(Math.round(ms), 0)} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** @param {number} ms */
function span(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
