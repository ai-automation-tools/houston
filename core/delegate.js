// Brokered sub-agents (CORE-08, H5): a session asks the Core, through its gateway's built-in
// `harness.delegate` tool, to start a child. Only the Core makes the child: a `sub-agent`
// identity under the parent's, in its profile, holding the part of what it asked for that the
// parent's own grants cover (the parent's grant snapshot from its session start), and every deny
// the parent has. It runs unattended (an `ask` is a deny), ends no later than the parent's
// session, and is retired when its session ends. Depth is capped (runner.js). The parent needs
// a `session:delegate` grant with permission `spawn`; `ask` puts a card in front of the operator.

import { decide } from './policy.js';
import { pathKey } from './paths.js';

export const DELEGATE_RESOURCE = 'delegate';
const MAX_GRANTS = 50;
const DEFAULT_MINUTES = 30;
/** The action a grant's type and permission are checked as. */
const ACTION = {
  'file:read': 'file.read', 'file:write': 'file.write', 'file:list': 'file.list', 'net:connect': 'net.connect',
  'tool:call': 'tool.call', 'command:run': 'command.run', 'secret:use': 'secret.use', 'session:run': 'session.start', 'session:spawn': 'session.spawn', 'skill:use': 'skill.use',
};
const TYPE = { file: 'File', net: 'Host', tool: 'Tool', command: 'Command', secret: 'Secret', session: 'Session', skill: 'Skill' };

export class DelegationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DelegationError';
  }
}

/**
 * The child's grants: each requested one the parent's live allow grants cover, plus every deny
 * the parent has. Conservative on purpose: a request is kept when the parent holds the identical
 * allow grant; or it names one thing (no wildcard) and the parent's policy allows exactly that;
 * or it's a folder (`dir/**`) inside a folder the parent may read or write the same way (write
 * covers read). Anything else is dropped with the reason, never widened or guessed.
 *
 * @param {import('./policy.js').Grant[]} parent the parent session's frozen grants
 * @param {{ resource: string, permission: string }[] | undefined} requested undefined: all of the parent's allow grants
 * @param {{ globals: import('./policy.js').GlobalDeny[], policyVersion: string, now: Date, identity: string }} policy
 */
export function intersect(parent, requested, { globals, policyVersion, now, identity }) {
  const live = parent.filter((g) => g.expires_at == null || Date.parse(g.expires_at) > now.getTime());
  const allows = live.filter((g) => g.effect === 'allow');
  const denies = live.filter((g) => g.effect === 'deny').map((g) => ({ resource: g.resource, permission: /** @type {string} */ (g.permission) }));
  const asked = requested ?? allows.map((g) => ({ resource: g.resource, permission: /** @type {string} */ (g.permission) }));
  /** @type {{ resource: string, permission: string }[]} */
  const granted = [];
  /** @type {{ resource: string, permission: string, reason: string }[]} */
  const dropped = [];
  for (const r of asked) {
    const type = r.resource.slice(0, r.resource.indexOf(':'));
    const pattern = r.resource.slice(type.length + 1);
    const action = ACTION[/** @type {keyof typeof ACTION} */ (`${type}:${r.permission}`)];
    const drop = (/** @type {string} */ reason) => dropped.push({ ...r, reason });
    if (!action || !pattern) { drop('not a grant: <type>:<pattern> with a permission that type takes'); continue; }
    if (granted.some((g) => g.resource === r.resource && g.permission === r.permission)) continue;
    if (allows.some((g) => g.resource === r.resource && g.permission === r.permission)) { granted.push(r); continue; }
    if (!pattern.includes('*')) {
      const d = decide({ principal: { type: 'Identity', id: identity }, action, resource: { type: TYPE[/** @type {keyof typeof TYPE} */ (type)], id: pattern }, context: { session_id: null, attended: true } },
        { grants: live, globals, policyVersion, now });
      if (d.decision === 'allow') granted.push(r); else drop(d.decision === 'ask' ? 'the parent itself would be asked: a sub-agent runs unattended' : 'the parent may not');
      continue;
    }
    const dir = type === 'file' && /^[^*]+\/\*\*$/.test(pattern) ? pattern.slice(0, -3) : null;
    const within = (/** @type {string} */ a, /** @type {string} */ b) => { try { const x = pathKey(a); const y = pathKey(b); return x === y || x.startsWith(`${y}/`); } catch { return false; } };
    const cover = dir && allows.find((g) => {
      const m = /^file:([^*]+)\/\*\*$/.exec(g.resource);
      return m && (g.permission === r.permission || (g.permission === 'write' && r.permission === 'read')) && within(dir, m[1]);
    });
    if (cover) granted.push(r); else drop('a wildcard the parent\'s grants don\'t cover');
  }
  return { granted, dropped, denies };
}

/** The tools a session sees when it may delegate. */
export const TOOLS = [
  {
    name: 'delegate',
    description: 'Start a sub-agent: a child session that runs one task unattended, with no more access than this session has. '
      + 'It gets only the grants you ask for that your own grants cover (all of yours when you name none), every deny you have, and ends when you do. '
      + 'Returns its session id, what it was granted and what was dropped; poll harness.delegate_status for its result.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['task'],
      properties: {
        task: { type: 'string', description: 'For an agent CLI, the prompt; for a plain identity, one command line', maxLength: 8000 },
        grants: { type: 'array', maxItems: MAX_GRANTS, description: 'What it may touch, e.g. { "resource": "file:D:/work/app/docs/**", "permission": "write" }',
          items: { type: 'object', required: ['resource', 'permission'], properties: { resource: { type: 'string' }, permission: { type: 'string' } } } },
        workspace: { type: 'string', description: 'Its working folder; yours by default. It needs a write grant there' },
        minutes: { type: 'integer', minimum: 1, maximum: 1440, description: `Its budget; ${DEFAULT_MINUTES} by default, never past your own end` },
      },
    },
  },
  {
    name: 'delegate_status',
    description: 'A sub-agent you started: running or ended, its exit code, and the end of its transcript (secrets already redacted).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['session'], properties: { session: { type: 'string' } } },
  },
];

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   registry: ReturnType<typeof import('./identities.js').createRegistry>,
 *   runner: Pick<ReturnType<typeof import('./runner.js').createRunner>, 'start' | 'get'>,
 *   transcripts?: { read: (id: string) => { text: string } | null },
 *   tap?: (s: any) => void,  the Control API's: reads the child's output (so it never stalls) and keeps its transcript
 *   now?: () => Date,
 * }} o
 */
export function createDelegation({ db, registry, runner, transcripts, tap, now = () => new Date() }) {
  return {
    /**
     * Start a child of session `s`. Throws DelegationError with a reason the parent can read.
     * @param {{ id: string, identity: string, workspace: string, policy: { grants: any[], globals: any[], policyVersion: string } }} s
     * @param {any} args the tool's arguments
     */
    async delegate(s, args) {
      const { task, grants, workspace = s.workspace, minutes = DEFAULT_MINUTES } = args;
      if (typeof task !== 'string' || !task.trim() || task.length > 8000 || task.includes('\0')) throw new DelegationError('task is text of 1 to 8000 characters');
      if (grants !== undefined && (!Array.isArray(grants) || grants.length > MAX_GRANTS
        || !grants.every((g) => g && typeof g.resource === 'string' && typeof g.permission === 'string' && g.resource.length <= 500))) {
        throw new DelegationError(`grants is a list of up to ${MAX_GRANTS} { resource, permission }`);
      }
      if (typeof workspace !== 'string' || !workspace) throw new DelegationError('workspace is a folder');
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new DelegationError('minutes is a whole number from 1 to 1440');
      const parent = /** @type {any} */ (db.prepare('SELECT * FROM identities WHERE id = ?').get(s.identity));
      if (!parent) throw new DelegationError('this session has no identity');
      const headless = Boolean(parent.backend);
      if (!headless && /[\r\n]/.test(task)) throw new DelegationError('a plain identity\'s task is one command line');

      const at = now();
      const { granted, dropped, denies } = intersect(s.policy.grants, grants, { ...s.policy, now: at, identity: s.identity });
      const n = /** @type {any} */ (db.prepare("SELECT count(*) AS n FROM identities WHERE parent = ? AND kind = 'sub-agent'").get(s.identity)).n + 1;
      const id = `${s.identity}/sub-${n}`;
      if (id.length > 69) throw new DelegationError('too deep to name another sub-agent');
      const until = new Date(at.getTime() + (minutes + 1) * 60_000);
      const expires = parent.expires_at && Date.parse(parent.expires_at) < until.getTime() ? parent.expires_at : until.toISOString();
      registry.create({
        id, kind: 'sub-agent', displayName: `${parent.display_name} sub-agent ${n}`, owner: s.identity, parent: s.identity, profile: parent.profile_id,
        backend: parent.backend, purpose: `Delegated by session ${s.id}: ${task.slice(0, 200)}`, expiresAt: expires,
      }, s.identity);
      for (const g of granted) registry.addGrant({ identity: id, resource: g.resource, permission: g.permission }, s.identity);
      for (const g of denies) registry.addGrant({ identity: id, resource: g.resource, permission: g.permission, effect: 'deny' }, s.identity);
      registry.setStatus(id, 'active', s.identity, `delegated by session ${s.id}`);
      const retire = (/** @type {string} */ why) => { try { registry.setStatus(id, 'retired', s.identity, why); } catch { /* already */ } };

      let child;
      try {
        child = await runner.start({
          identity: id, workspace, attended: false, timeoutMs: minutes * 60_000, parentSession: s.id,
          ...(headless ? { prompt: task } : { command: task }),
        });
      } catch (e) {
        retire('its session did not start');
        throw new DelegationError(`the sub-agent did not start: ${/** @type {Error} */ (e).message}`);
      }
      tap?.(child);
      child.done.then(() => retire('its session ended'), () => retire('its session ended'));
      return { session: child.id, identity: id, granted, dropped, denies: denies.length, expiresAt: expires };
    },

    /**
     * A child (or grandchild) of session `s`, running or ended.
     * @param {{ id: string }} s @param {any} args
     */
    status(s, args) {
      const sid = typeof args.session === 'string' ? args.session : '';
      const get = (/** @type {string} */ id) => /** @type {any} */ (db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
      const row = get(sid);
      // Only its own descendants: walk up from the asked-for session until this one turns up.
      let mine = false;
      for (let up = row, i = 0; up?.parent_session_id && i < 4 && !mine; up = get(up.parent_session_id), i++) mine = up.parent_session_id === s.id;
      if (!row || !mine) throw new DelegationError('no sub-agent of this session has that id');
      let tail = '';
      try { tail = (transcripts?.read(row.id)?.text ?? '').slice(-4000); } catch { /* none yet */ }
      return { session: row.id, identity: row.identity_id, state: row.ended_at ? 'ended' : 'running', end: row.end_reason ?? null, transcript: tail };
    },
  };
}
