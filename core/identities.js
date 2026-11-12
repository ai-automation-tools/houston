// The identity registry: who may act, what they may touch, and where each one is in its
// lifecycle. Every change is an audit event (identity.lifecycle or grant.change) with the
// policy version it produced.
//
// Lifecycle (status in core/schemas/identity.schema.json):
//   draft -> active | retired
//   active -> suspended | retired
//   suspended -> active | retired
//   retired: final, and the id is never reused (the database enforces both).
// Only an active identity can start a session (the runner checks).

import crypto from 'node:crypto';
import { ACTIONS, compile, policyVersion } from './policy.js';

export const OPERATOR = 'local:operator';
const ID = /^local:[a-z0-9][a-z0-9/_-]{0,62}$/;
const KINDS = ['ai-agent', 'sub-agent', 'service-account', 'mcp-server'];
const CONTAINMENT = ['container', 'restricted-token', 'unconfined'];
const NEXT = { draft: ['active', 'retired'], active: ['suspended', 'retired'], suspended: ['active', 'retired'], retired: [] };
/** @type {Record<string, Set<string>>} the permissions each resource type takes, from the policy's actions */
const PERMISSIONS = {};
for (const [type, permission] of Object.values(ACTIONS)) (PERMISSIONS[type] ??= new Set()).add(permission);

export class RegistryError extends Error {
  /** @param {string} code bad_request | not_found | conflict @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

const bad = (/** @type {string} */ m) => new RegistryError('bad_request', m);
/** @param {unknown} v @param {string} name @param {number} max */
const text = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${name} is text of 1 to ${max} characters`);
  return v;
};
/** @param {unknown} v @param {string} name @param {Date} now */
const future = (v, name, now) => {
  if (v == null) return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw bad(`${name} is a date and time`);
  if (t <= now.getTime()) throw bad(`${name} is in the past`);
  return new Date(t).toISOString();
};

/**
 * Make sure the operator exists: the identity every other one is owned by. The Core calls
 * this at every start; the first start creates `local:operator`, active and unconfined.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof import('./audit.js').openAudit>} audit
 * @param {() => Date} [now]
 * @returns {string} the operator's id
 */
export function ensureOperator(db, audit, now = () => new Date()) {
  const have = /** @type {any} */ (db.prepare("SELECT id FROM identities WHERE kind = 'operator'").get());
  if (have) return have.id;
  db.prepare("INSERT INTO identities (id, kind, display_name, status, containment, created_at) VALUES (?, 'operator', 'Operator', 'active', 'unconfined', ?)")
    .run(OPERATOR, now().toISOString());
  audit.append({
    type: 'identity.lifecycle', action: 'identity.create', identity: { subject: OPERATOR, containment: 'unconfined' }, session_id: null,
    resource: { type: 'Identity', id: OPERATOR }, decision: { result: 'allow', policy_version: 'none', reasons: ['the Core made the operator'] },
    lifecycle: { from: null, to: 'active' },
  });
  return OPERATOR;
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, audit: ReturnType<typeof import('./audit.js').openAudit>, globals?: import('./policy.js').GlobalDeny[], now?: () => Date }} opts
 */
export function createRegistry({ db, audit, globals = [], now = () => new Date() }) {
  /** @param {string} type @param {string} action @param {string} actor @param {{ type: string, id: string }} resource @param {object} extra */
  const event = (type, action, actor, resource, extra) => audit.append({
    type, action, identity: { subject: actor }, session_id: null, resource,
    decision: { result: 'allow', policy_version: policyVersion(db, globals) }, ...extra,
  });

  /** @param {string} id */
  const row = (id) => /** @type {any} */ (db.prepare('SELECT * FROM identities WHERE id = ?').get(id));
  /** @param {string} id */
  const must = (id) => {
    const r = typeof id === 'string' ? row(id) : null;
    if (!r) throw new RegistryError('not_found', `no identity ${String(id)}`);
    return r;
  };

  /** The identity as identity.schema.json shapes it, with its grants. @param {any} r */
  const shape = (r) => ({
    id: r.id, kind: r.kind, displayName: r.display_name, owner: r.owner, parent: r.parent, purpose: r.purpose, backend: r.backend,
    status: r.status, containment: r.containment, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at, retiredAt: r.retired_at, tags: JSON.parse(r.tags),
    grants: /** @type {any[]} */ (db.prepare('SELECT * FROM grants WHERE identity_id = ? ORDER BY granted_at, id').all(r.id)).map((g) => ({
      id: g.id, resource: g.resource, permission: g.permission, effect: g.effect,
      grantedAt: g.granted_at, grantedBy: g.granted_by, expiresAt: g.expires_at, lastUsedAt: g.last_used_at,
    })),
  });

  return {
    /** @param {string} id */
    get: (id) => shape(must(id)),

    /** @param {{ status?: string }} [filter] */
    list({ status } = {}) {
      if (status !== undefined && !(status in NEXT)) throw bad(`status is one of ${Object.keys(NEXT).join(', ')}`);
      const rows = status ? db.prepare('SELECT * FROM identities WHERE status = ? ORDER BY id').all(status) : db.prepare('SELECT * FROM identities ORDER BY id').all();
      return rows.map(shape);
    },

    /**
     * A new identity, in draft: it can't start a session until it is activated.
     * @param {any} spec id, kind, displayName; optional owner (default: the caller), parent, purpose, backend, containment (default container), expiresAt, tags
     * @param {string} actor who asked
     */
    create(spec, actor) {
      if (!spec || typeof spec !== 'object') throw bad('the identity is an object');
      const { id, kind, displayName, owner = actor, parent = null, purpose = null, backend = null, containment = 'container', expiresAt, tags = [] } = spec;
      if (typeof id !== 'string' || !ID.test(id)) throw bad("id is 'local:' then a lowercase name: letters, digits, / _ -");
      if (!KINDS.includes(kind)) throw bad(`kind is one of ${KINDS.join(', ')} (there is one operator, made by the Core)`);
      text(displayName, 'displayName', 80);
      if (purpose !== null) text(purpose, 'purpose', 300);
      if (backend !== null) text(backend, 'backend', 40);
      if (!CONTAINMENT.includes(containment)) throw bad(`containment is one of ${CONTAINMENT.join(', ')}`);
      if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string' && t.length <= 40) || tags.length > 20) throw bad('tags is a list of up to 20 short strings');
      const expires = future(expiresAt, 'expiresAt', now());
      for (const [name, ref] of /** @type {const} */ ([['owner', owner], ['parent', parent]])) {
        if (ref === null && name === 'parent') continue;
        const r = typeof ref === 'string' ? row(ref) : null;
        if (!r) throw bad(`${name} ${String(ref)} is not an identity`);
        if (r.status === 'retired') throw bad(`${name} ${ref} is retired`);
      }
      if (kind === 'sub-agent' && parent === null) throw bad('a sub-agent names its parent');
      if (row(id)) throw new RegistryError('conflict', `${id} exists${row(id).status === 'retired' ? ' (retired: ids are never reused)' : ''}`);
      db.prepare(`INSERT INTO identities (id, kind, display_name, owner, parent, purpose, backend, status, containment, created_at, expires_at, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`).run(id, kind, displayName, owner, parent, purpose, backend, containment, now().toISOString(), expires, JSON.stringify(tags));
      event('identity.lifecycle', 'identity.create', actor, { type: 'Identity', id }, { lifecycle: { from: null, to: 'draft' } });
      return shape(row(id));
    },

    /**
     * Move an identity along its lifecycle.
     * @param {string} id @param {'active' | 'suspended' | 'retired'} to @param {string} actor @param {string} [reason]
     */
    setStatus(id, to, actor, reason) {
      const r = must(id);
      if (r.kind === 'operator') throw bad("the operator's status doesn't change");
      if (!NEXT[r.status]?.includes(to)) throw new RegistryError('conflict', `${id} is ${r.status}; it can become ${NEXT[r.status].join(' or ') || 'nothing else'}`);
      if (reason !== undefined) text(reason, 'reason', 300);
      db.prepare('UPDATE identities SET status = ?, retired_at = ? WHERE id = ?').run(to, to === 'retired' ? now().toISOString() : null, id);
      event('identity.lifecycle', `identity.${to === 'active' ? 'activate' : to === 'suspended' ? 'suspend' : 'retire'}`, actor, { type: 'Identity', id },
        { lifecycle: { from: r.status, to, ...(reason ? { reason } : {}) } });
      return shape(row(id));
    },

    /**
     * @param {any} spec identity, resource ('<type>:<pattern>'), permission; optional effect (default allow), expiresAt
     * @param {string} actor
     */
    addGrant(spec, actor) {
      if (!spec || typeof spec !== 'object') throw bad('the grant is an object');
      const { identity, resource, permission, effect = 'allow', expiresAt } = spec;
      const r = must(identity);
      if (r.status === 'retired') throw new RegistryError('conflict', `${identity} is retired`);
      if (r.kind === 'operator') throw bad('the operator is unconfined and takes no grants');
      const m = typeof resource === 'string' ? /^([a-z]+):(.+)$/.exec(resource) : null;
      if (!m || !PERMISSIONS[m[1]]) throw bad(`resource is '<type>:<pattern>' with type ${Object.keys(PERMISSIONS).join(', ')}`);
      if (!PERMISSIONS[m[1]].has(permission)) throw bad(`a ${m[1]} grant's permission is ${[...PERMISSIONS[m[1]]].join(' or ')}`);
      if (!['allow', 'ask', 'deny'].includes(effect)) throw bad('effect is allow, ask or deny');
      try { compile(m[1], m[2]); } catch (e) { throw bad(`resource: ${/** @type {Error} */ (e).message}`); }
      const expires = future(expiresAt, 'expiresAt', now());
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, identity, resource, permission, effect, now().toISOString(), actor, expires);
      const grant = { id, identity, resource, permission, effect, expiresAt: expires };
      event('grant.change', 'grant.add', actor, { type: 'Grant', id }, { grant });
      return grant;
    },

    /** @param {string} id @param {string} actor */
    removeGrant(id, actor) {
      const g = /** @type {any} */ (typeof id === 'string' ? db.prepare('SELECT * FROM grants WHERE id = ?').get(id) : null);
      if (!g) throw new RegistryError('not_found', `no grant ${String(id)}`);
      db.prepare('DELETE FROM grants WHERE id = ?').run(id);
      const grant = { id, identity: g.identity_id, resource: g.resource, permission: g.permission, effect: g.effect, expiresAt: g.expires_at };
      event('grant.change', 'grant.remove', actor, { type: 'Grant', id }, { grant });
      return grant;
    },
  };
}
