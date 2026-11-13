// Skills (H6): discover, install and attach are three steps.
//   discover  a catalogue, read-only: Promptbook's MCP server behind the gateway (READ_ONLY=true),
//             or its web page. Nothing is copied.
//   install   the operator copies one skill folder into the profile's skills folder
//             (houston-skills\<profile>\<name>, beside the data folder), recording its content
//             hash; no links, at most 200 files and 5 MB.
//   attach    a `skill:<name>` grant with permission `use` on an identity.
// A session gets each attached skill of its profile read-only: the folder is added to its
// container's read-only paths and, for an agent CLI, linked into its home's `skills` folder,
// where Claude Code and Codex look. A skill whose files changed since install isn't mounted.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OPERATOR } from './identities.js';
import { DEFAULT_PROFILE, profileOf } from './profiles.js';

export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

export class SkillError extends Error {
  /** @param {string} code bad_request | not_found | conflict @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
  }
}

/** Beside the data folder, like houston-profiles; not a global deny, since sessions read it. @param {string} dir the Core's data folder */
export const skillsRoot = (dir) => path.join(path.dirname(dir), 'houston-skills');

/**
 * Every file under a skill folder, refusing links of any kind and anything too big.
 * @param {string} dir @returns {{ rel: string, size: number }[]}
 */
function walk(dir) {
  /** @type {{ rel: string, size: number }[]} */
  const out = [];
  let bytes = 0;
  const go = (/** @type {string} */ d, /** @type {string} */ rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new SkillError('bad_request', `${r} is a link; a skill is plain files`);
      if (st.isDirectory()) { go(p, r); continue; }
      if (!st.isFile()) throw new SkillError('bad_request', `${r} is not a plain file`);
      bytes += st.size;
      out.push({ rel: r, size: st.size });
      if (out.length > MAX_FILES || bytes > MAX_BYTES) throw new SkillError('bad_request', `a skill is at most ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MB`);
    }
  };
  go(dir, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The folder's content hash: each file's path and SHA-256, in order. @param {string} dir */
export function skillHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of walk(dir)) h.update(`${f.rel}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f.rel))).digest('hex')}\n`);
  return h.digest('hex');
}

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, audit: ReturnType<typeof import('./audit.js').openAudit>, root: string, now?: () => Date }} o
 */
export function createSkills({ db, audit, root, now = () => new Date() }) {
  const shape = (/** @type {any} */ r) => ({
    name: r.name, profile: r.profile_id, source: r.source, hash: r.hash, files: r.files, bytes: r.bytes,
    installedAt: r.installed_at, installedBy: r.installed_by, folder: path.join(root, r.profile_id, r.name),
  });
  const fail = (/** @type {string} */ c, /** @type {string} */ m) => new SkillError(c, m);
  const row = (/** @type {string} */ profile, /** @type {string} */ name) => /** @type {any} */ (db.prepare('SELECT * FROM skills WHERE profile_id = ? AND name = ?').get(profile, name));
  const event = (/** @type {string} */ action, /** @type {string} */ profile, /** @type {string} */ name, /** @type {string} */ reason, /** @type {object} */ extra = {}) => audit.append({
    type: 'skill.change', action, identity: { subject: OPERATOR }, session_id: null, resource: { type: 'Skill', id: name }, profile,
    decision: { result: 'allow', policy_version: 'none', reasons: [reason] }, ...extra,
  });

  return {
    /** @param {unknown} [profile] */
    list(profile = undefined) {
      const p = profile === undefined ? null : profileOf(db, profile, fail);
      return /** @type {any[]} */ (db.prepare('SELECT * FROM skills ORDER BY profile_id, name').all()).filter((r) => !p || r.profile_id === p).map(shape);
    },

    /**
     * Copy a skill folder in. `from` holds a SKILL.md; `source` says where it came from (a Promptbook id, say).
     * @param {any} spec from, name (default: the folder's name), profile (default 'default'), source
     */
    install(spec) {
      const { from, source = null } = spec && typeof spec === 'object' ? spec : /** @type {any} */ ({});
      const profile = profileOf(db, spec?.profile ?? DEFAULT_PROFILE, fail);
      if (typeof from !== 'string' || !path.isAbsolute(from)) throw fail('bad_request', 'from is the skill\'s folder, an absolute path');
      if (source !== null && (typeof source !== 'string' || source.length > 300 || /[\0\r\n]/.test(source))) throw fail('bad_request', 'source is one line of text, e.g. promptbook:3_Skills/Development/Git/git-commit-helper');
      let real;
      try { real = fs.realpathSync.native(from); } catch { throw fail('not_found', `no folder ${from}`); }
      if (!fs.statSync(real).isDirectory() || !fs.existsSync(path.join(real, 'SKILL.md'))) throw fail('bad_request', `${from} is not a skill folder: it has no SKILL.md`);
      const name = spec.name ?? path.basename(real).toLowerCase();
      if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw fail('bad_request', 'name is lower-case letters, digits, - and _, up to 64');
      if (row(profile, name)) throw fail('conflict', `${name} is installed in ${profile}; remove it first`);
      const files = walk(real);
      const dest = path.join(root, profile, name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(dest, f.rel)), { recursive: true });
        fs.copyFileSync(path.join(real, f.rel), path.join(dest, f.rel));
      }
      const hash = skillHash(dest);
      const bytes = files.reduce((n, f) => n + f.size, 0);
      db.prepare('INSERT INTO skills (profile_id, name, source, hash, files, bytes, installed_at, installed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(profile, name, source, hash, files.length, bytes, now().toISOString(), OPERATOR);
      event('skill.install', profile, name, `installed ${files.length} files`, { skill: { source, hash } });
      return shape(row(profile, name));
    },

    /** @param {unknown} name @param {unknown} [profile] */
    remove(name, profile = DEFAULT_PROFILE) {
      const p = profileOf(db, profile, fail);
      if (typeof name !== 'string' || !row(p, name)) throw fail('not_found', `no skill ${String(name)} in ${p}`);
      db.prepare('DELETE FROM skills WHERE profile_id = ? AND name = ?').run(p, name);
      fs.rmSync(path.join(root, p, name), { recursive: true, force: true });
      event('skill.remove', p, name, 'removed');
      return { removed: name };
    },

    /**
     * The skills a session of this identity gets: installed in its profile, a `use` its policy
     * allows, and unchanged since install. The rest are skipped, with why.
     * @param {string} profile @param {(name: string) => { decision: string }} allowed
     */
    forSession(profile, allowed) {
      /** @type {{ name: string, folder: string }[]} */
      const mounted = [];
      /** @type {{ name: string, reason: string }[]} */
      const skipped = [];
      for (const r of /** @type {any[]} */ (db.prepare('SELECT * FROM skills WHERE profile_id = ? ORDER BY name').all(profile))) {
        if (allowed(r.name).decision !== 'allow') continue;
        const folder = path.join(root, profile, r.name);
        let hash = null;
        try { hash = skillHash(folder); } catch { /* gone or changed into something else */ }
        if (hash === r.hash) mounted.push({ name: r.name, folder });
        else skipped.push({ name: r.name, reason: 'its files changed since it was installed; install it again' });
      }
      return { mounted, skipped };
    },

    link: linkSkills,
  };
}

/**
 * Link a session's skills into an agent CLI's home, `<home>\skills\<name>`, replacing the links
 * Houston made before (a detached skill's goes). Anything else there is the agent's own and stays.
 * @param {string} home @param {{ name: string, folder: string }[]} mounted
 * @returns {{ name: string, reason: string }[]} the ones that couldn't be linked
 */
export function linkSkills(home, mounted) {
  const dir = path.join(home, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    // Only links: unlink removes the link, never what it points at.
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
  }
  /** @type {{ name: string, reason: string }[]} */
  const failed = [];
  for (const s of mounted) {
    try { fs.symlinkSync(s.folder, path.join(dir, s.name), 'junction'); } catch (e) {
      failed.push({ name: s.name, reason: /** @type {any} */ (e).code === 'EEXIST' ? `the home has its own ${s.name}` : /** @type {Error} */ (e).message });
    }
  }
  return failed;
}
