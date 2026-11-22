// Profile export and restore (H7; SET-01, SET-02, SEC-08's export): what a profile holds in the
// Core as one JSON document with no secret in it, and back. A secret leaves as its name only, and
// every other string the export carries goes through the vault's exact-value redaction first.
//
// Restore never writes rows itself. It replays the document through the same calls the operator
// makes (profiles.create, registry.create and addGrant, gateway.add, standing.create, memory.add),
// so every check and quarantine rule applies and every change is audited as it is anywhere else.
// What comes back needs the operator again before it acts: identities are drafts, servers are
// discovered (install and pin them again), standing grants are paused, and secrets and skills are
// listed for the operator to set and reinstall. Anything a check refuses is skipped with its reason.

import { OPERATOR } from './identities.js';
import { ProfileError } from './profiles.js';

export const FORMAT = 'houston-profile';
export const VERSION = 1;
/** The identities an export carries: a server's comes with its server, and a sub-agent dies with its session. */
const KINDS = ['ai-agent', 'service-account'];

/**
 * @typedef {{
 *   audit: ReturnType<typeof import('./audit.js').openAudit>,
 *   profiles?: ReturnType<typeof import('./profiles.js').createProfiles>,
 *   registry: ReturnType<typeof import('./identities.js').createRegistry>,
 *   gateway?: ReturnType<typeof import('./gateway.js').createGateway>,
 *   standing?: ReturnType<typeof import('./standing.js').createStanding>,
 *   memory?: ReturnType<typeof import('./memory.js').createMemory>,
 *   skills?: ReturnType<typeof import('./skills.js').createSkills>,
 *   vault?: { list: (profile?: unknown) => { name: string }[], redact: (s: string) => string },
 * }} Parts
 */

/** @param {Parts} parts @returns {NonNullable<Parts['profiles']>} */
function profilesOf(parts) {
  if (!parts.profiles) throw new ProfileError('not_found', 'this Core has no profiles');
  return parts.profiles;
}

/**
 * @param {Parts['audit']} audit @param {string} action @param {string} id @param {string} reason
 */
const event = (audit, action, id, reason) => audit.append({
  type: 'profile.change', action, identity: { subject: OPERATOR }, session_id: null, resource: { type: 'Profile', id }, profile: id,
  decision: { result: 'allow', policy_version: 'none', reasons: [reason] },
});

/**
 * The profile as a document: its identities with their live grants, its MCP servers with their
 * identities' grants, its standing grants that aren't revoked, its approved memory, and the names
 * of its skills and secrets. Expired grants and retired identities are left out.
 * @param {Parts} parts @param {unknown} id @param {Date} [now]
 */
export function exportProfile(parts, id, now = new Date()) {
  const p = profilesOf(parts).get(id);
  const { registry, gateway, standing, memory, skills, vault } = parts;
  const clean = vault ? vault.redact : (/** @type {string} */ s) => s;
  /** @param {any[]} list */
  const grants = (list) => list.filter((g) => g.expiresAt == null || Date.parse(g.expiresAt) > now.getTime())
    .map((g) => ({ resource: g.resource, permission: g.permission, effect: g.effect, expiresAt: g.expiresAt }));
  const doc = {
    format: FORMAT, version: VERSION, exportedAt: now.toISOString(),
    profile: { id: p.id, displayName: p.displayName, preset: p.preset },
    identities: registry.list({ profile: p.id }).filter((i) => KINDS.includes(i.kind) && i.status !== 'retired').map((i) => ({
      id: i.id, kind: i.kind, displayName: i.displayName, owner: i.owner, parent: i.parent, purpose: i.purpose, backend: i.backend,
      containment: i.containment, expiresAt: i.expiresAt, tags: i.tags, status: i.status, grants: grants(i.grants),
    })),
    servers: (gateway?.list(p.id) ?? []).map((s) => ({
      name: s.name, transport: s.transport, ...(s.transport === 'http' ? { url: s.url } : { command: clean(s.command) }),
      env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, clean(String(v))])), pathDirs: s.pathDirs, state: s.state,
      grants: grants(registry.get(s.identity).grants),
    })),
    standing: (standing?.list(p.id) ?? []).filter((s) => s.status !== 'revoked').map((s) => ({
      id: s.id, identity: s.identity, workspace: s.workspace, ...(s.prompt == null ? { command: clean(s.command) } : { prompt: clean(s.prompt) }),
      pathDirs: s.pathDirs, maxMinutes: s.maxMinutes, expiresAt: s.expiresAt, status: s.status,
    })),
    memory: (memory?.list({ profile: p.id, state: 'approved' }) ?? []).reverse().map((m) => clean(m.text)),
    skills: (skills?.list(p.id) ?? []).map((s) => ({ name: s.name, source: s.source, hash: s.hash })),
    secrets: (vault?.list(p.id) ?? []).map((s) => s.name),
  };
  event(parts.audit, 'profile.export', p.id, `exported by the operator, without secret values: ${doc.identities.length} identities, ${doc.servers.length} servers, ${doc.standing.length} standing grants, ${doc.memory.length} memory items`);
  return doc;
}

/** @param {unknown} v @returns {any[]} */
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : (() => { throw new ProfileError('bad_request', 'identities, servers, standing, memory, skills and secrets are lists'); })());
/** @param {unknown} v */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Bring an exported profile back. The profile is made if it isn't here; if it is, its preset must
 * match. Refused whole, before anything is written, when an identity, server or standing grant in
 * the document already exists (ids are never reused).
 * @param {Parts} parts @param {unknown} doc an exportProfile() document
 */
export function restoreProfile(parts, doc) {
  const profiles = profilesOf(parts);
  const { registry, gateway, standing, memory } = parts;
  if (!isObj(doc)) throw new ProfileError('bad_request', 'export is the document profile.export made');
  const d = /** @type {any} */ (doc);
  if (d.format !== FORMAT || d.version !== VERSION) throw new ProfileError('bad_request', `export is a ${FORMAT} document, version ${VERSION}`);
  if (!isObj(d.profile)) throw new ProfileError('bad_request', 'export has no profile');
  const identities = list(d.identities); const servers = list(d.servers); const grantsToRun = list(d.standing); const memories = list(d.memory);
  const pid = d.profile.id;
  const preset = d.profile.preset ?? null;

  // Refuse the whole thing before writing anything, so a restore never half-lands on what's here.
  let existing = null;
  try { existing = profiles.get(pid); } catch (e) { if (!(e instanceof ProfileError && e.code === 'not_found')) throw e; }
  if (existing && (existing.preset ?? null) !== preset) throw new ProfileError('conflict', `profile ${pid} is here with preset ${existing.preset ?? 'none'}, and the export's is ${preset ?? 'none'}`);
  const has = (/** @type {() => unknown} */ get) => { try { get(); return true; } catch { return false; } };
  const taken = [
    ...identities.filter((i) => typeof i?.id === 'string' && has(() => registry.get(i.id))).map((i) => i.id),
    ...servers.filter((s) => typeof s?.name === 'string' && ((gateway && has(() => gateway.get(s.name))) || has(() => registry.get(`local:mcp/${s.name}`)))).map((s) => `server ${s.name}`),
    ...grantsToRun.filter((s) => typeof s?.id === 'string' && standing && has(() => standing.get(s.id))).map((s) => `standing grant ${s.id}`),
  ];
  if (taken.length) throw new ProfileError('conflict', `already here, and ids are never reused: ${taken.join(', ')}`);
  if (!existing) profiles.create({ id: pid, displayName: d.profile.displayName, preset });

  /** @type {{ what: string, reason: string }[]} */
  const skipped = [];
  /** @template T @param {string} what @param {() => T} fn @returns {T | undefined} */
  const attempt = (what, fn) => {
    try { return fn(); } catch (e) { skipped.push({ what, reason: /** @type {Error} */ (e).message }); return undefined; }
  };
  /** @param {string} identity @param {unknown} gs */
  const grant = (identity, gs) => {
    for (const g of Array.isArray(gs) ? gs : []) {
      attempt(`grant ${String(g?.resource)} for ${identity}`, () => registry.addGrant({ identity, resource: g.resource, permission: g.permission, effect: g.effect, expiresAt: g.expiresAt ?? undefined }, OPERATOR));
    }
  };

  // Owners and parents before what they own. An identity that waits on one that never comes is skipped.
  /** @type {string[]} */
  const made = [];
  let left = identities;
  while (left.length) {
    const waits = (/** @type {any} */ i) => [i?.owner, i?.parent].some((r) => r && left.some((o) => o !== i && o?.id === r));
    const ready = left.filter((i) => !waits(i));
    if (!ready.length) break;
    for (const i of ready) {
      const what = `identity ${String(i?.id)}`;
      if (!KINDS.includes(i?.kind)) { skipped.push({ what, reason: `a profile export carries ${KINDS.join(' and ')} identities only` }); continue; }
      const r = attempt(what, () => registry.create({
        id: i.id, kind: i.kind, displayName: i.displayName, owner: i.owner ?? undefined, parent: i.parent ?? null, purpose: i.purpose ?? null,
        backend: i.backend ?? null, containment: i.containment, expiresAt: i.expiresAt ?? undefined, tags: i.tags ?? [], profile: pid,
      }, OPERATOR));
      if (!r) continue;
      made.push(r.id);
      grant(r.id, i.grants);
    }
    left = left.filter((i) => !ready.includes(i));
  }
  for (const i of left) skipped.push({ what: `identity ${String(i?.id)}`, reason: 'its owner or parent is in the export but could not come first' });

  /** @type {string[]} */
  const registered = [];
  for (const s of servers) {
    const r = attempt(`server ${String(s?.name)}`, () => {
      if (!gateway) throw new Error('this Core has no gateway');
      return gateway.add({ name: s.name, transport: s.transport, command: s.command, url: s.url, env: s.env, pathDirs: s.pathDirs, profile: pid });
    });
    if (!r) continue;
    registered.push(r.name);
    grant(r.identity, s.grants);
  }

  /** @type {string[]} */
  const paused = [];
  for (const s of grantsToRun) {
    const r = attempt(`standing grant ${String(s?.id)}`, () => {
      if (!standing) throw new Error('this Core has no standing grants');
      const g = standing.create({ id: s.id, identity: s.identity, workspace: s.workspace, command: s.command ?? undefined, prompt: s.prompt ?? undefined, pathDirs: s.pathDirs, maxMinutes: s.maxMinutes, expiresAt: s.expiresAt });
      // It comes back paused: nothing runs unattended until the operator resumes it.
      return standing.pause(g.id);
    });
    if (r) paused.push(r.id);
  }

  let remembered = 0;
  for (const text of memories) {
    if (attempt('a memory item', () => { if (!memory) throw new Error('this Core has no memory'); return memory.add(text, pid); })) remembered++;
  }

  const result = {
    profile: pid, created: !existing, identities: made, servers: registered, standing: paused, memory: remembered,
    secrets: list(d.secrets).filter((n) => typeof n === 'string'), skills: list(d.skills).filter(isObj).map((s) => ({ name: s.name, source: s.source ?? null })),
    skipped,
  };
  event(parts.audit, 'profile.restore', pid, `restored by the operator: ${made.length} identities, ${registered.length} servers, ${paused.length} standing grants, ${remembered} memory items, ${skipped.length} skipped`);
  return result;
}
