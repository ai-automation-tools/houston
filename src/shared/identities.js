// The Identity Center (SEC-02, H5): every identity the Core knows, with its attributes, grants,
// sessions, review dates and what its grants open now (the Core's identity.reach). Read-only, like
// Settings: app pages can't act, so the lifecycle actions are the Agents tab's (Activate, Suspend,
// Retire, Reviewed), and identities and grants are made with `npm run ctl`. No DOM and no Node
// imports: main gathers the data and serves acc://identities/; the browser demo renders it too.

export const IDENTITIES_URL = 'acc://identities/';
const DAY = 86_400_000;

/** The in-page anchor for an identity's section. @param {string} id */
export const identityAnchor = (id) => `id-${id.replace(/^local:/, '').replace(/[^a-z0-9_-]/g, '-')}`;

/**
 * Where an identity stands on review: never reviewed, due, or overdue.
 * @param {{ kind: string, status: string, reviewBy?: string | null }} i
 * @param {number} now
 * @returns {{ state: 'none' | 'never' | 'due' | 'overdue', text: string }}
 */
export function reviewState(i, now) {
  if (i.kind === 'operator' || i.status === 'retired') return { state: 'none', text: '—' };
  if (!i.reviewBy) return { state: 'never', text: 'never reviewed' };
  const days = Math.ceil((Date.parse(i.reviewBy) - now) / DAY);
  return days < 0 ? { state: 'overdue', text: `overdue by ${-days} day${days === -1 ? '' : 's'}` }
    : { state: 'due', text: days === 0 ? 'due today' : `due in ${days} day${days === 1 ? '' : 's'}` };
}

/** @param {string | null | undefined} t */
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
const TYPES = { file: 'Files', net: 'Network', tool: 'MCP tools', command: 'Commands', secret: 'Secrets', session: 'Sessions' };

/**
 * @typedef {{ id: string, kind: string, displayName: string, owner: string | null, parent: string | null, purpose: string | null,
 *   backend: string | null, status: string, containment: string, createdAt: string, lastUsedAt: string | null, expiresAt: string | null,
 *   retiredAt: string | null, reviewedAt?: string | null, reviewBy?: string | null, tags: string[],
 *   grants: { id: string, resource: string, permission: string, effect: string, grantedAt: string, grantedBy: string, expiresAt: string | null, lastUsedAt: string | null }[] }} Identity
 * @typedef {{ resource: string, permission: string }} Entry
 * @typedef {{ status: string, containment: string, enforced: boolean, types: Record<string, { allow: Entry[], ask: Entry[], deny: Entry[] }>, expired: number,
 *   notApplied: { resource: string | null, reason: string }[], alwaysDenied: string[],
 *   backend: null | { name: string, displayName: string, hosts: string[], missingHosts: string[] }, standing: { id: string, status: string, expiresAt: string }[] }} Reach
 * @typedef {{ id: string, identity: string, workspace: string, startedAt: string }} Session
 * @typedef {{ time: string, session_id: string | null, identity?: { subject?: string }, decision?: { result?: string, reasons?: string[] }, standing_grant?: string, resource?: { id?: string } }} StartEvent
 */

/**
 * The page's body.
 * @param {{ identities: Identity[], reach: Record<string, Reach | { error: string }>, sessions: Session[], starts: StartEvent[], now: number }} d
 * @param {(s: string) => string} esc
 */
export function identitiesBody({ identities, reach, sessions, starts, now }, esc) {
  const list = [...identities].sort((a, b) => Number(a.kind === 'operator') - Number(b.kind === 'operator')
    || Number(a.status === 'retired') - Number(b.status === 'retired') || a.id.localeCompare(b.id));
  const runs = (/** @type {Identity} */ i) => `${i.containment}${i.backend ? ` · ${i.backend}` : ''}`;
  const overdue = list.filter((i) => reviewState(i, now).state === 'overdue').length;
  const top = `<h1>Identity Center</h1><p class="note">${esc(`${list.length} identities, ${sessions.length} sessions running${overdue ? `, ${overdue} overdue for review` : ''}. `
    + 'Activate, Suspend, Retire and Reviewed are in the sidebar\'s Agents tab; identities and grants are made with npm run ctl (core/README.md). '
    + 'Suspending or retiring an identity ends its sessions.')}</p>`;
  const table = '<table><thead><tr><th>Identity</th><th>Kind</th><th>Status</th><th>Runs</th><th>Grants</th><th>Last used</th><th>Review</th></tr></thead><tbody>'
    + list.map((i) => `<tr><td><a href="#${identityAnchor(i.id)}">${esc(i.displayName)}</a><br><code>${esc(i.id)}</code></td><td>${esc(i.kind)}</td>`
      + `<td>${esc(i.status)}</td><td>${esc(runs(i))}</td><td>${i.grants.length}</td><td>${esc(when(i.lastUsedAt))}</td><td>${esc(reviewState(i, now).text)}</td></tr>`).join('')
    + '</tbody></table>';
  return top + table + list.map((i) => section(i, reach[i.id], sessions.filter((s) => s.identity === i.id), starts.filter((e) => e.identity?.subject === i.id).slice(0, 5), now, esc)).join('');
}

/**
 * @param {Identity} i @param {Reach | { error: string } | undefined} r @param {Session[]} running @param {StartEvent[]} recent
 * @param {number} now @param {(s: string) => string} esc
 */
function section(i, r, running, recent, now, esc) {
  const rows = /** @type {[string, string][]} */ ([
    ['Id', i.id], ['Kind', i.kind], ['Status', i.status],
    ['Runs', i.containment === 'unconfined' ? 'unconfined: outside any container, with the operator\'s own access' : i.containment],
    ['Backend', i.backend ?? '—'], ['Owner', i.owner ?? '—'], ['Parent', i.parent ?? '—'], ['Purpose', i.purpose ?? '—'],
    ['Tags', i.tags.join(', ') || '—'], ['Created', when(i.createdAt)], ['Last used', when(i.lastUsedAt)], ['Expires', when(i.expiresAt)],
    ...(i.retiredAt ? /** @type {[string, string][]} */ ([['Retired', when(i.retiredAt)]]) : []),
    ['Reviewed', when(i.reviewedAt)], ['Review', reviewState(i, now).text],
  ]);
  const attrs = `<table><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  const grants = i.kind === 'operator' ? '<p class="note">The operator is unconfined and takes no grants.</p>'
    : i.grants.length ? '<table><thead><tr><th>Resource</th><th>Permission</th><th>Effect</th><th>Granted</th><th>Expires</th><th>Last used</th></tr></thead><tbody>'
      + i.grants.map((g) => `<tr><td><code>${esc(g.resource)}</code></td><td>${esc(g.permission)}</td><td>${esc(g.effect)}</td>`
        + `<td>${esc(`${when(g.grantedAt)} by ${g.grantedBy}`)}</td><td>${esc(when(g.expiresAt))}</td><td>${esc(when(g.lastUsedAt))}</td></tr>`).join('')
      + '</tbody></table>'
      : i.containment === 'unconfined' ? '<p class="note">No grants, and it runs unconfined, so grants wouldn\'t hold it.</p>'
        : '<p class="note">No grants: it can reach nothing beyond a session\'s own temp folder.</p>';
  const sessions = (running.length ? `<ul>${running.map((s) => `<li>${esc(`Running since ${when(s.startedAt)} in ${s.workspace}`)} <code>${esc(s.id)}</code></li>`).join('')}</ul>` : '')
    + (recent.length ? `<p class="note">Latest starts, newest first:</p><ul>${recent.map((e) => `<li>${esc([when(e.time), e.decision?.result === 'deny' ? `refused: ${(e.decision.reasons ?? []).join('; ')}` : 'started',
      e.standing_grant ? `standing grant ${e.standing_grant}` : ''].filter(Boolean).join(' · '))}${e.session_id ? ` <code>${esc(e.session_id)}</code>` : ''}</li>`).join('')}</ul>` : '')
    || '<p class="note">No sessions in the recent audit log.</p>';
  return `<h2 id="${identityAnchor(i.id)}">${esc(i.displayName)}</h2>${attrs}<h3>Grants</h3>${grants}<h3>What it can reach</h3>${reachBody(i, r, esc)}<h3>Sessions</h3>${sessions}`;
}

/** @param {Identity} i @param {Reach | { error: string } | undefined} r @param {(s: string) => string} esc */
function reachBody(i, r, esc) {
  if (i.kind === 'operator' || i.containment === 'unconfined') return '<p class="note">Everything the operator can: an unconfined identity isn\'t held to its grants by a container.</p>';
  if (!r) return '<p class="note">Not asked.</p>';
  if ('error' in r) return `<p class="note">${esc(`The Core couldn't say: ${r.error}`)}</p>`;
  const out = [];
  if (!r.enforced) out.push(`<p class="note">${esc(`It runs ${r.containment}, which this build can't start: nothing below is enforced yet.`)}</p>`);
  const lines = Object.entries(r.types).flatMap(([type, e]) => /** @type {const} */ (['allow', 'ask', 'deny'])
    .filter((k) => e[k].length).map((k) => `<li><strong>${esc(`${TYPES[/** @type {keyof typeof TYPES} */ (type)] ?? type}, ${k === 'allow' ? 'allowed' : k === 'ask' ? 'asks first' : 'denied'}:`)}</strong> `
      + e[k].map((x) => `<code>${esc(x.resource)}</code> ${esc(x.permission)}`).join(', ') + '</li>'));
  out.push(lines.length ? `<ul>${lines.join('')}</ul>` : '<p class="note">Nothing: no live grants. A session still gets its workspace only if a write grant covers it, so it can\'t start.</p>');
  if (r.notApplied.length) out.push(`<p class="note">Not applied inside a container:</p><ul>${r.notApplied.map((n) => `<li>${n.resource ? `<code>${esc(n.resource)}</code>: ` : ''}${esc(n.reason)}</li>`).join('')}</ul>`);
  if (r.expired) out.push(`<p class="note">${esc(`${r.expired} expired grant${r.expired === 1 ? '' : 's'} left out.`)}</p>`);
  if (r.backend?.missingHosts.length) out.push(`<p class="note">${esc(`${r.backend.displayName} needs ${r.backend.missingHosts.join(', ')}, which no allow grant covers: those calls are refused.`)}</p>`);
  if (r.standing.length) out.push(`<p class="note">${esc(`Standing grants: ${r.standing.map((s) => `${s.id} (${s.status}, expires ${when(s.expiresAt)})`).join('; ')}.`)}</p>`);
  out.push(`<p class="note">${esc(`Never reachable, whatever the grants: every user profile, and ${r.alwaysDenied.length} folders no grant opens (credential folders and the Core's own data).`)}</p>`);
  return out.join('');
}
