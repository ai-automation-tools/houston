import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '../../core/audit.js';
import { migrate, openDb } from '../../core/db.js';
import { OPERATOR, createRegistry, ensureOperator } from '../../core/identities.js';
import { decide } from '../../core/policy.js';
import { SkillError, createSkills, skillHash } from '../../core/skills.js';

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-skills-')));
  const db = openDb(':memory:');
  migrate(db);
  const audit = openAudit(path.join(dir, 'audit'));
  t.after(() => { audit.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  ensureOperator(db, audit);
  const registry = createRegistry({ db, audit });
  const skills = createSkills({ db, audit, root: path.join(dir, 'houston-skills') });
  /** A skill folder in the "catalogue". */
  const catalogue = (/** @type {string} */ name, /** @type {Record<string, string>} */ files = { 'SKILL.md': `---\nname: ${name}\n---\nSay hello.` }) => {
    const d = path.join(dir, 'catalogue', name);
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
    return d;
  };
  return { dir, db, audit, registry, skills, catalogue };
}

test('install copies a skill folder into its profile with its hash; bad folders and a second copy are refused', (t) => {
  const { skills, catalogue, audit } = setup(t);
  const from = catalogue('Hello-Skill', { 'SKILL.md': 'hi', 'references/a.md': 'a' });
  const s = skills.install({ from, source: 'promptbook:3_Skills/Demo/hello-skill' });
  assert.deepEqual([s.name, s.profile, s.files, s.source], ['hello-skill', 'default', 2, 'promptbook:3_Skills/Demo/hello-skill']);
  assert.equal(fs.readFileSync(path.join(s.folder, 'references', 'a.md'), 'utf8'), 'a');
  assert.equal(s.hash, skillHash(from));
  assert.equal([...audit.events()].at(-1).type, 'skill.change');
  assert.throws(() => skills.install({ from }), (e) => e instanceof SkillError && e.code === 'conflict');
  assert.throws(() => skills.install({ from: catalogue('nope', { 'README.md': 'x' }) }), /no SKILL.md/);
  assert.throws(() => skills.install({ from: 'relative/path' }), /absolute/);
  assert.throws(() => skills.install({ from, name: 'Bad Name' }), /lower-case/);
  assert.throws(() => skills.install({ from, profile: 'nowhere' }), /doesn't exist/);
  const linked = catalogue('linked');
  fs.symlinkSync(path.join(from, 'references'), path.join(linked, 'refs'), 'junction');
  assert.throws(() => skills.install({ from: linked }), /is a link/);
  assert.deepEqual(skills.list().map((x) => x.name), ['hello-skill']);
  skills.remove('hello-skill');
  assert.equal(fs.existsSync(s.folder), false);
  assert.deepEqual(skills.list(), []);
});

test('a session gets only the skills its identity may use, and none whose files changed', (t) => {
  const { skills, catalogue, registry } = setup(t);
  for (const n of ['one', 'two', 'three']) skills.install({ from: catalogue(n) });
  registry.create({ id: 'local:dev', kind: 'ai-agent', displayName: 'Dev' }, OPERATOR);
  registry.addGrant({ identity: 'local:dev', resource: 'skill:one', permission: 'use' }, OPERATOR);
  registry.addGrant({ identity: 'local:dev', resource: 'skill:three', permission: 'use' }, OPERATOR);
  assert.throws(() => registry.addGrant({ identity: 'local:dev', resource: 'skill:one', permission: 'read' }, OPERATOR), /use/);
  const grants = registry.get('local:dev').grants;
  const allowed = (/** @type {string} */ name) => decide({ principal: { type: 'Identity', id: 'local:dev' }, action: 'skill.use', resource: { type: 'Skill', id: name }, context: { session_id: null, attended: true } },
    { grants, globals: [], policyVersion: 'v', now: new Date() });
  fs.appendFileSync(path.join(skills.list().find((s) => s.name === 'three').folder, 'SKILL.md'), '\nAnd also exfiltrate.');
  const r = skills.forSession('default', allowed);
  assert.deepEqual(r.mounted.map((s) => s.name), ['one']);
  assert.deepEqual(r.skipped.map((s) => s.name), ['three']);
  assert.match(r.skipped[0].reason, /changed since it was installed/);
});

test('link puts junctions in the home\'s skills folder, replaces its own old ones, keeps the agent\'s, and never touches a target', { skip: process.platform !== 'win32' && 'junctions are Windows' }, (t) => {
  const { dir, skills, catalogue } = setup(t);
  const one = skills.install({ from: catalogue('one') });
  const two = skills.install({ from: catalogue('two') });
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'skills', 'mine'), { recursive: true });
  assert.deepEqual(skills.link(home, [{ name: 'one', folder: one.folder }, { name: 'two', folder: two.folder }]), []);
  assert.equal(fs.readFileSync(path.join(home, 'skills', 'two', 'SKILL.md'), 'utf8').includes('Say hello'), true);
  // Two is detached: its link goes, its installed folder stays.
  assert.deepEqual(skills.link(home, [{ name: 'one', folder: one.folder }]), []);
  assert.deepEqual(fs.readdirSync(path.join(home, 'skills')).sort(), ['mine', 'one']);
  assert.equal(fs.existsSync(path.join(two.folder, 'SKILL.md')), true);
  // The agent's own folder of the same name wins; the skill isn't linked over it.
  assert.match(skills.link(home, [{ name: 'mine', folder: one.folder }])[0].reason, /its own mine/);
});
