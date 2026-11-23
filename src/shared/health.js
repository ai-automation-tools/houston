// The health screen (acc://health/) and the local diagnostics bundle (H7). Main gathers the
// facts: the Connections rows, the Core's `core.health`, the app's versions and log; this file
// turns them into rows, the page and the bundle's text, so the wording and the scrubbing are
// tested. No DOM and no Node imports.

export const HEALTH_URL = 'acc://health/';
/** The log storage target in harness-requirements.md's targets table. */
export const LOG_TARGET_BYTES = 5 * 1024 ** 3;
/** Values shorter than this aren't scrubbed from text: they'd match ordinary words (the vault's rule). */
const MIN_SECRET = 8;

/** @typedef {import('./connections.js').Connection | { id: string, name: string, state: 'warn', detail: string, fix?: string }} HealthRow */
/**
 * What `core.health` answers.
 * @typedef {{ audit: { events: number, breaks: number, firstBreak: { segment: string, line: number, reason: string } | null }, storage: Record<string, number> & { total: number }, log: string[] }} CoreHealth
 */

/** @param {number} b */
export function bytes(b) {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

/**
 * The Core's own checks: its audit chain and the space its logs take.
 * @param {CoreHealth | { error: string, code?: string } | null} h null off Windows, where there is no Core
 * @returns {HealthRow[]}
 */
export function coreHealthRows(h) {
  if (!h) return [];
  if ('error' in h) {
    // Not running is the Core row's to say; a Core from before this method needs a restart.
    if (h.code === 'unknown_method') return [{ id: 'core-health', name: 'Core checks', state: 'bad', detail: 'The Core runs older code than the app', fix: 'End and Run the Houston Core task in Task Scheduler (or restart npm run core), then reload this page.' }];
    return [{ id: 'core-health', name: 'Core checks', state: 'off', detail: `Not checked: ${h.error}` }];
  }
  const { events, breaks, firstBreak } = h.audit;
  const b = firstBreak;
  const audit = breaks
    ? { id: 'audit', name: 'Audit chain', state: /** @type {const} */ ('bad'), detail: `${breaks} break${breaks === 1 ? '' : 's'} in ${events} events${b ? `; first: ${b.segment} line ${b.line}, ${b.reason}` : ''}`, fix: 'A line was edited, removed or reordered. Leave the audit folder as it is: the Core records each break as an audit.break event, and every event after it still verifies.' }
    : { id: 'audit', name: 'Audit chain', state: /** @type {const} */ ('ok'), detail: `${events} events, every hash checked` };
  const s = h.storage;
  const parts = Object.entries(s).filter(([k]) => k !== 'total').map(([k, v]) => `${k} ${bytes(v)}`).join(', ');
  const over = s.total > LOG_TARGET_BYTES;
  const storage = {
    id: 'storage', name: 'Core storage', state: /** @type {'ok' | 'warn'} */ (over ? 'warn' : 'ok'),
    detail: `${bytes(s.total)} in all${parts ? ` (${parts})` : ''}; target ${bytes(LOG_TARGET_BYTES)}`,
    ...(over ? { fix: 'Transcripts rotate on their own. Old database copies in the data folder\'s backups folder can be deleted by hand.' } : {}),
  };
  return [audit, storage];
}

/** @type {Record<string, string>} */
const MARK = { ok: '✓', warn: '!', bad: '✗', off: '–' };

/**
 * The page body: the app's versions, then one table row per check.
 * @param {{ app: Record<string, string>, rows: HealthRow[] }} s
 * @param {(t: string) => string} esc HTML escaping
 */
export function healthBody({ app, rows }, esc) {
  const bad = rows.filter((r) => r.state === 'bad').length;
  const warn = rows.filter((r) => r.state === 'warn').length;
  const summary = bad || warn ? [bad && `${bad} failing`, warn && `${warn} to look at`].filter(Boolean).join(', ') : 'everything checked is working';
  return `<h1>Health</h1><p class="note">Checked when this page opened: ${esc(summary)}. Reload it to check again. `
    + 'View › Save diagnostics bundle writes all of this and the newest log lines to a file on this machine, for a bug report: your user folder is written as %USERPROFILE% and secret values are left out.</p>'
    + '<h2>This install</h2><table><tbody>'
    + Object.entries(app).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')
    + '</tbody></table><h2>Checks</h2><table><thead><tr><th></th><th>What</th><th>Now</th><th>To fix</th></tr></thead><tbody>'
    + rows.map((r) => `<tr><td>${MARK[r.state] ?? ''}</td><td>${esc(r.name)}</td><td>${esc(r.detail)}</td><td>${esc(r.fix ?? '')}</td></tr>`).join('')
    + '</tbody></table>';
}

/** @param {string} s */
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with the user folder written as %USERPROFILE%, in any slash or case, also where it sits
 * JSON-escaped inside a log line; and each secret value (8 characters or more) as [REDACTED].
 * @param {string} text @param {{ home?: string, secrets?: string[] }} opts
 */
export function scrub(text, { home = '', secrets = [] } = {}) {
  let out = text;
  for (const v of [...secrets].filter((x) => typeof x === 'string' && x.length >= MIN_SECRET).sort((a, b) => b.length - a.length)) out = out.split(v).join('[REDACTED]');
  const parts = home.split(/[\\/]+/).filter(Boolean);
  if (parts.length > 1) out = out.replace(new RegExp(parts.map(literal).join('(?:\\\\{1,2}|/)') + '(?![^\\\\/\\s"\'])', 'gi'), '%USERPROFILE%');
  return out;
}

/**
 * The diagnostics bundle: one JSON file, every string scrubbed. It holds no setting's value
 * but what the health screen already shows.
 * @param {{ created: string, app: Record<string, string>, rows: HealthRow[], core: CoreHealth | { error: string } | null, appLog: string[] }} b
 * @param {{ home?: string, secrets?: string[] }} opts
 */
export function diagnosticsBundle({ created, app, rows, core, appLog }, opts) {
  const body = { bundle: 'houston.diagnostics/v1', created, app, checks: rows, core, appLog };
  return `${JSON.stringify(body, (_, v) => (typeof v === 'string' ? scrub(v, opts) : v), 2)}\n`;
}

/** The bundle's file name for a time. @param {Date} now */
export const bundleName = (now) => `houston-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.json`;
