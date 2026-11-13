// The Connections view: one row for each thing the app talks to, whether it's working,
// and what to set when it isn't. The main process gathers the facts; this file only
// turns them into rows, so the wording is tested.

/** @typedef {'ok' | 'off' | 'bad'} ConnState ok: working; off: not set up or not installed; bad: set up but failing */
/** @typedef {{ id: string, name: string, state: ConnState, detail: string, fix?: string }} Connection */

/** The shells the app looks for, in the order the terminal menu lists them, and how to get each. */
export const SHELLS = [
  { id: 'pwsh', label: 'PowerShell 7', fix: 'Install PowerShell 7 (winget install Microsoft.PowerShell), then Retry.' },
  { id: 'powershell', label: 'Windows PowerShell', fix: 'Part of Windows; it should be in System32\\WindowsPowerShell\\v1.0.' },
  { id: 'cmd', label: 'Command Prompt', fix: 'Part of Windows; it should be System32\\cmd.exe.' },
  { id: 'git-bash', label: 'Git Bash', fix: 'Install Git for Windows (winget install Git.Git), then Retry.' },
];

/**
 * @param {string} url where the app looks for Project Hub
 * @param {{ ok: boolean, state: string }} health
 * @returns {Connection}
 */
export function hubRow(url, health) {
  if (health.ok) return { id: 'hub', name: 'Project Hub', state: 'ok', detail: `${url} · ${health.state || 'ready'}` };
  return {
    id: 'hub', name: 'Project Hub', state: 'bad', detail: `${url} · ${health.state || 'not answering'}`,
    fix: 'Start Project Hub. If it runs elsewhere, set hubUrl in settings.json (or ACC_HUB_URL), then restart the app.',
  };
}

/**
 * @param {{ configured: boolean, ui: string }} info
 * @param {{ count: number } | { error: string } | null} result null when it isn't set up, so not tried
 * @returns {Connection}
 */
export function cronsoleRow(info, result) {
  const name = 'Cronsole';
  if (!info.configured || !result) {
    return { id: 'cronsole', name, state: 'off', detail: 'Not set up', fix: 'Set ACC_CRONSOLE_MCP in .env to <cronsole>/mcp-server/dist/index.js, then restart the app.' };
  }
  if ('error' in result) {
    return { id: 'cronsole', name, state: 'bad', detail: result.error, fix: "Check Cronsole's backend is running and CRONSOLE_TOKEN is set, then Retry." };
  }
  return { id: 'cronsole', name, state: 'ok', detail: `${result.count} task${result.count === 1 ? '' : 's'} · UI at ${info.ui}` };
}

/**
 * One row per known shell: installed or not.
 * @param {{ id: string }[]} found the profiles the terminal panel offers
 * @returns {Connection[]}
 */
export function shellRows(found) {
  const have = new Set(found.map((s) => s.id));
  return SHELLS.map((s) => (have.has(s.id)
    ? { id: `shell:${s.id}`, name: s.label, state: /** @type {const} */ ('ok'), detail: 'Installed' }
    : { id: `shell:${s.id}`, name: s.label, state: /** @type {const} */ ('off'), detail: 'Not installed', fix: s.fix }));
}

/**
 * The chat model. Never calls the API: a check would cost a request.
 * @param {{ model: string, missing: string[] }} config
 * @returns {Connection}
 */
export function chatRow(config) {
  if (config.missing.length) {
    return { id: 'chat', name: 'Chat model', state: 'off', detail: 'Not set up', fix: `Set ${config.missing.join(' and ')} in .env, then restart the app.` };
  }
  return { id: 'chat', name: 'Chat model', state: 'ok', detail: `${config.model} · key set (not tried against the API)` };
}

/**
 * The harness's Core and the containment rung its sessions run on.
 * @param {{ pid: number, containment: string, sessions: number } | { error: string, code?: string } | null} status null off Windows
 * @returns {Connection}
 */
export function coreRow(status) {
  const base = { id: 'core', name: 'Houston Core' };
  if (!status) return { ...base, state: 'off', detail: 'Windows only: its sessions run in Windows containers' };
  if ('error' in status) {
    // No control.json, or one a crashed Core left naming a pipe that's gone.
    if (status.code === 'ENOENT' || status.code === 'ECONNREFUSED') {
      return { ...base, state: 'off', detail: 'Not running', fix: 'Run the Houston Core task in Task Scheduler, or npm run core. To start it at every logon: scripts\\Register-HoustonCore.ps1 -StartNow.' };
    }
    // The task runs the checkout's code from when it started, so after a pull it can be behind the app.
    if (status.code === 'unknown_method') {
      return { ...base, state: 'bad', detail: 'Running older code than the app', fix: 'End and Run the Houston Core task in Task Scheduler (or restart npm run core), then Retry.' };
    }
    return { ...base, state: 'bad', detail: status.code ? `${status.code}: ${status.error}` : status.error, fix: 'Retry. If it still fails, read core.log in the Core\'s data folder (%LOCALAPPDATA%\\houston-core).' };
  }
  const n = status.sessions;
  return { ...base, state: 'ok', detail: `Running · containment: ${status.containment} · ${n} session${n === 1 ? '' : 's'} · pid ${status.pid}` };
}

/**
 * @param {{ url: string } | null} server
 * @returns {Connection}
 */
export function mcpRow(server) {
  if (server) return { id: 'mcp', name: 'MCP server', state: 'ok', detail: `${server.url} · token in mcp.json` };
  return { id: 'mcp', name: 'MCP server', state: 'bad', detail: "Didn't start", fix: 'See logs\\app.log for why, then restart the app.' };
}
