// The policy check: one request in, allow, ask or deny out, with the rule that decided it.
// Shapes: core/schemas/policy-request.schema.json. Imports nothing from runner or gateway.
//
// Precedence (harness-requirements.md, scope rules): a global deny, then any explicit
// deny, then the narrowest matching allow or ask. No match means deny. An unattended run
// treats ask as deny.

import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalPath, pathKey } from './paths.js';

/** action -> [grant resource type, grant permission, request resource.type] */
export const ACTIONS = {
  'file.read': ['file', 'read', 'File'],
  'file.write': ['file', 'write', 'File'],
  'file.list': ['file', 'list', 'File'],
  'net.connect': ['net', 'connect', 'Host'],
  // A tool is listed when a call to it would not be denied.
  'tool.list': ['tool', 'call', 'Tool'],
  'tool.call': ['tool', 'call', 'Tool'],
  'command.run': ['command', 'run', 'Command'],
  'secret.use': ['secret', 'use', 'Secret'],
  'session.start': ['session', 'run', 'Session'],
  'session.spawn': ['session', 'spawn', 'Session'],
};

/**
 * @typedef {{ id: string, resource: string, permission?: string, effect: 'allow' | 'ask' | 'deny', expires_at?: string | null }} Grant
 * @typedef {{ id: string, resource: string }} GlobalDeny  applies to every permission
 * @typedef {{ decision: 'allow' | 'ask' | 'deny', policy_version: string, determining_policies: string[], reasons: string[], approval_id: string | null }} Decision
 */

/**
 * Folders no grant can open (scope rules: credential folders, the Core's own data, every
 * profile's folder, beside the data folder). The runner adds the same list to every container's
 * denied paths.
 *
 * @param {{ home: string, coreDir: string, otherProfileDirs?: string[] }} where
 * @returns {GlobalDeny[]}
 */
export function globalDenies({ home, coreDir, otherProfileDirs = [] }) {
  const under = (...p) => `file:${canonicalPath(path.win32.join(home, ...p))}/**`;
  return [
    { id: 'global:core-data', resource: `file:${canonicalPath(coreDir)}/**` },
    // Every profile's folder (profiles.js), so no grant reaches another profile's data (H5). Not the
    // CLI homes beside it: launch.js refuses any folder a launch opens that overlaps a global deny,
    // and each session opens its own home there.
    { id: 'global:profiles', resource: `file:${canonicalPath(path.win32.join(path.win32.dirname(coreDir), 'houston-profiles'))}/**` },
    { id: 'global:ssh', resource: under('.ssh') },
    { id: 'global:gnupg', resource: under('.gnupg') },
    { id: 'global:aws', resource: under('.aws') },
    { id: 'global:azure', resource: under('.azure') },
    { id: 'global:kube', resource: under('.kube') },
    { id: 'global:docker', resource: under('.docker') },
    { id: 'global:gh', resource: under('AppData', 'Roaming', 'GitHub CLI') },
    { id: 'global:git-credentials', resource: under('.git-credentials') },
    { id: 'global:netrc', resource: under('_netrc') },
    { id: 'global:dpapi-keys', resource: under('AppData', 'Roaming', 'Microsoft', 'Protect') },
    { id: 'global:credential-manager', resource: under('AppData', 'Roaming', 'Microsoft', 'Credentials') },
    { id: 'global:credential-manager-local', resource: under('AppData', 'Local', 'Microsoft', 'Credentials') },
    { id: 'global:vault', resource: under('AppData', 'Local', 'Microsoft', 'Vault') },
    ...otherProfileDirs.map((d, i) => ({ id: `global:profile-${i + 1}`, resource: `file:${canonicalPath(d)}/**` })),
  ];
}

const escape = (/** @type {string} */ s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile one grant pattern for its resource type.
 *
 * - file: an absolute path; `*` is one name, `**` any depth, and `dir/**` also matches `dir`.
 *   Case-insensitive, and compared in canonical form.
 * - net: `host:port`; `*` stands for any run of labels (`*.example.com` is not `example.com`)
 *   or any port. Case-insensitive.
 * - tool, secret, session: `*` is one `/`-separated part, `**` anything. Case-sensitive.
 * - command: `*` is anything. Case-sensitive. A command grant is only as good as the
 *   checker that runs it, which is the gateway's job.
 *
 * @param {string} type
 * @param {string} pattern
 * @returns {{ re: RegExp, score: number }} score: literal characters, so the narrowest wins
 * @throws {Error} on a malformed pattern
 */
export function compile(type, pattern) {
  let p = pattern;
  let flags = '';
  /** @type {[string, string][]} */
  let wild = [['**', '.*'], ['*', '[^/]*']];
  if (type === 'file') {
    p = canonicalPath(pattern, { pattern: true });
    flags = 'i';
  } else if (type === 'net') {
    if (!/^[^:\s]+:(\*|[0-9]{1,5})$/.test(p)) throw new Error('a net grant is host:port');
    p = p.toLowerCase();
    wild = [['*', '[^:/]*']];
    flags = 'i';
  } else if (type === 'command') {
    wild = [['*', '.*']];
  } else if (!['tool', 'secret', 'session'].includes(type)) {
    throw new Error(`unknown resource type '${type}'`);
  }
  if (!p) throw new Error('the pattern is empty');
  let body = escape(p).split('**').map((part) => part.replaceAll('*', wild.at(-1)[1])).join(wild[0][1]);
  // `a/**/b` covers `a/b`; `dir/**` covers `dir` itself, and `C:/**` covers `C:/`.
  if (type !== 'command') body = body.replaceAll('/.*/', '/(?:.*/)?');
  if (type === 'file') body = body.replace(/\/\.\*$/, '(?:/.*)?');
  return { re: new RegExp(`^${body}$`, flags), score: p.replaceAll('*', '').length };
}

/**
 * The value a request names, in the form patterns are matched against.
 * @param {string} type
 * @param {string} id
 */
function canonicalValue(type, id) {
  if (type === 'file') return pathKey(id);
  if (type === 'net') {
    const m = /^(.+):([0-9]{1,5})$/.exec(id.trim().toLowerCase());
    if (!m) throw new Error('a host is host:port');
    return `${m[1].replace(/\.$/, '')}:${Number(m[2])}`;
  }
  return id;
}

/** @param {string | null | undefined} at @param {Date} now */
const expired = (at, now) => at != null && !(Date.parse(at) > now.getTime());

/**
 * Decide one request against one identity's grants. Pure: no database, no disk.
 *
 * @param {any} request see #/$defs/request
 * @param {{ grants: Grant[], globals?: GlobalDeny[], policyVersion: string, now?: Date }} policy
 * @returns {Decision}
 */
export function decide(request, { grants, globals = [], policyVersion, now = new Date() }) {
  /** @param {Decision['decision']} decision @param {string[]} ids @param {string[]} reasons */
  const answer = (decision, ids, ...reasons) => ({ decision, policy_version: policyVersion, determining_policies: ids, reasons, approval_id: null });

  const spec = ACTIONS[/** @type {keyof typeof ACTIONS} */ (request?.action)];
  const id = request?.resource?.id;
  if (!spec || typeof id !== 'string' || !id || typeof request?.context?.attended !== 'boolean') return answer('deny', [], 'malformed request');
  const [type, permission, resourceType] = spec;
  if (request.resource.type !== resourceType) return answer('deny', [], `${request.action} takes a ${resourceType}, not a ${request.resource.type}`);

  let value;
  try { value = canonicalValue(type, id); } catch (e) { return answer('deny', [], `resource refused: ${/** @type {Error} */ (e).message}`); }

  /** @param {{ resource: string }} g @returns {{ hit: boolean, score: number }} */
  const match = (g) => {
    if (!g.resource.startsWith(`${type}:`)) return { hit: false, score: 0 };
    const { re, score } = compile(type, g.resource.slice(type.length + 1));
    return { hit: re.test(value), score };
  };

  const global = globals.filter((g) => match(g).hit).map((g) => g.id);
  if (global.length) return answer('deny', global, 'global deny');

  const mine = grants.filter((g) => g.resource.startsWith(`${type}:`) && g.permission === permission);
  /** @type {string[]} */
  const denies = [];
  /** @type {{ g: Grant, score: number }[]} */
  const positive = [];
  for (const g of mine) {
    let m;
    try { m = match(g); } catch (e) {
      // A deny that can't be read fails closed. A broken allow or ask is ignored.
      if (g.effect === 'deny') return answer('deny', [g.id], `deny grant ${g.id} is malformed: ${/** @type {Error} */ (e).message}`);
      continue;
    }
    if (!m.hit) continue;
    if (g.effect === 'deny') {
      // An expiry on a deny is honoured only when it parses.
      if (!(g.expires_at != null && Date.parse(g.expires_at) <= now.getTime())) denies.push(g.id);
    } else if (!expired(g.expires_at, now)) {
      positive.push({ g, score: m.score });
    }
  }
  if (denies.length) return answer('deny', denies, 'explicit deny');
  if (!positive.length) return answer('deny', [], 'no grant matches');

  // Narrowest wins; on a tie, ask beats allow.
  positive.sort((a, b) => b.score - a.score || Number(b.g.effect === 'ask') - Number(a.g.effect === 'ask'));
  const best = positive[0].g;
  if (best.effect === 'ask' && !request.context.attended) return answer('deny', [best.id], 'ask is deny in an unattended run');
  return answer(best.effect === 'ask' ? 'ask' : 'allow', [best.id], `${best.effect} grant`);
}

/**
 * The version of everything a decision is made against: every grant row and the global
 * denies. Any change to either gives a new version.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {GlobalDeny[]} globals
 */
export function policyVersion(db, globals) {
  const rows = db.prepare('SELECT id, identity_id, resource, permission, effect, expires_at FROM grants ORDER BY id').all();
  return crypto.createHash('sha256').update(JSON.stringify([rows, globals])).digest('hex').slice(0, 16);
}

/**
 * The check the gateway and runner call: the identity must exist and be active, then
 * `decide` runs over its grants.
 *
 * ponytail: hashes the grant table on every call; cache the version per write once the
 * gateway's call rate makes that show.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} request
 * @param {{ globals?: GlobalDeny[], now?: Date }} [opts]
 * @returns {Decision}
 */
export function check(db, request, { globals = [], now = new Date() } = {}) {
  const version = policyVersion(db, globals);
  const principal = request?.principal;
  const deny = (/** @type {string} */ reason) => ({ decision: /** @type {const} */ ('deny'), policy_version: version, determining_policies: [], reasons: [reason], approval_id: null });
  if (principal?.type !== 'Identity' || typeof principal.id !== 'string') return deny('malformed request');
  const who = /** @type {any} */ (db.prepare('SELECT status, expires_at FROM identities WHERE id = ?').get(principal.id));
  if (!who) return deny('unknown identity');
  if (who.status !== 'active') return deny(`the identity is ${who.status}`);
  if (expired(who.expires_at, now)) return deny('the identity has expired');
  const grants = /** @type {Grant[]} */ (db.prepare('SELECT id, resource, permission, effect, expires_at FROM grants WHERE identity_id = ?').all(principal.id));
  return decide(request, { grants, globals, policyVersion: version, now });
}
