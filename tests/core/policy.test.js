import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate } from '../../core/db.js';
import { PathError, canonicalPath, pathKey, resolvePath } from '../../core/paths.js';
import { ACTIONS, check, compile, decide, globalDenies, policyVersion } from '../../core/policy.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const PAST = '2026-01-01T00:00:00Z';
const FUTURE = '2027-01-01T00:00:00Z';
const TYPES = Object.fromEntries(Object.entries(ACTIONS).map(([a, [, , t]]) => [a, t]));

/** A request for `action` on `id`, attended unless said otherwise. */
const req = (action, id, attended = true) => ({
  principal: { type: 'Identity', id: 'local:dev-codex' }, action, resource: { type: TYPES[action], id }, context: { session_id: 's1', attended },
});

test('canonicalPath: one spelling for each path', () => {
  const same = [
    ['d:\\Work\\App\\', 'D:/Work/App'],
    ['D:/work//./app/../app/x.txt', 'D:/work/app/x.txt'],
    ['\\\\?\\D:\\work\\x', 'D:/work/x'],
    ['\\\\.\\D:\\work\\x', 'D:/work/x'],
    ['C:\\..\\..\\Windows', 'C:/Windows'],
    ['c:', 'C:/'],
    ['C:\\', 'C:/'],
  ];
  for (const [input, want] of same) assert.equal(canonicalPath(input), want, input);
  assert.equal(pathKey('D:\\Work\\APP'), pathKey('d:/work/app'));
});

test('canonicalPath refuses every spelling that could name another file (AT-03)', () => {
  const refused = {
    '': /empty/,
    'work\\app': /not absolute/,
    '\\work': /not absolute/,
    'D:work': /not absolute/,
    '\\\\server\\share\\x': /network/,
    '\\\\localhost\\C$\\Users\\me\\.ssh': /network/,
    '\\\\?\\UNC\\server\\share': /device and volume/,
    '\\\\?\\Volume{0}\\x': /device and volume/,
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1': /device and volume/,
    'C:\\Users\\me\\.ssh\\id_rsa::$DATA': /data streams/,
    'D:\\work\\notes.txt:hidden': /data streams/,
    'C:\\Users\\me\\.ssh.\\id_rsa': /dot or a space/,
    'C:\\Users\\me\\.ssh \\id_rsa': /dot or a space/,
    'D:\\work\\nul': /device names/,
    'D:\\work\\COM1.txt': /device names/,
    'C:\\PROGRA~1\\x': /8.3/,
    'C:\\Users\\me\\SSHKEY~1.PUB': /8.3/,
    'D:\\work\\*': /wildcard/,
    'D:\\work\\a?b': /wildcard/,
    'D:\\work\\a\u0000b': /control/,
  };
  for (const [input, want] of Object.entries(refused)) assert.throws(() => canonicalPath(input), (e) => e instanceof PathError && want.test(e.message), input);
});

test('resolvePath follows a junction out of the workspace (AT-02) and keeps the part that does not exist', { skip: process.platform !== 'win32' && 'junctions are Windows only' }, (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-paths-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'work'));
  fs.mkdirSync(path.join(root, 'secret'));
  fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'work', 'link'), 'junction');
  assert.equal(resolvePath(path.join(root, 'work', 'link', 'key.txt')), canonicalPath(path.join(root, 'secret', 'key.txt')));
  assert.equal(resolvePath(path.join(root, 'work', 'new', 'deeper')), canonicalPath(path.join(root, 'work', 'new', 'deeper')));
  assert.throws(() => resolvePath(path.join(root, 'work', 'NOFILE~1.TXT')), /8.3/);
});

test('compile: patterns per resource type, narrowest by literal length', () => {
  const cases = [
    ['file', 'D:/work/**', ['D:/work', 'd:/WORK/a/b.txt'], ['D:/workshop', 'D:/']],
    ['file', 'D:/work/*', ['d:/work/a.txt'], ['D:/work/a/b.txt', 'D:/work']],
    ['file', 'C:/**', ['c:/', 'c:/x/y'], []],
    ['file', 'D:/work/**/.env', ['D:/work/.env', 'D:/work/a/b/.ENV'], ['D:/work/x.env', 'D:/work/.env/x']],
    ['file', 'D:/work/app.js', ['d:/work/app.js'], ['d:/work/app.jsx']],
    ['net', 'api.openai.com:443', ['api.openai.com:443'], ['api.openai.com:80', 'xapi.openai.com:443']],
    ['net', '*.example.com:*', ['a.example.com:443', 'a.b.example.com:1'], ['example.com:443', 'example.com.evil:443']],
    ['tool', 'github/*', ['github/create_issue'], ['github/a/b', 'gitlab/create_issue']],
    ['tool', 'github/create_issue', ['github/create_issue'], ['github/Create_issue']],
    ['command', 'git push*', ['git push', 'git push origin main'], ['git  push', 'Git push']],
    ['secret', 'github-token', ['github-token'], ['github-token2']],
  ];
  for (const [type, pattern, hits, misses] of cases) {
    const { re } = compile(type, pattern);
    const v = (x) => (type === 'file' ? pathKey(x) : x);
    for (const h of hits) assert.ok(re.test(v(h)), `${pattern} should match ${h}`);
    for (const m of misses) assert.ok(!re.test(v(m)), `${pattern} should not match ${m}`);
  }
  assert.ok(compile('file', 'D:/work/app/**').score > compile('file', 'D:/work/**').score);
  for (const [type, bad] of [['net', 'api.openai.com'], ['file', 'work/**'], ['file', 'D:/a~1/**'], ['blob', 'x'], ['tool', '']]) assert.throws(() => compile(type, bad), `${type}:${bad}`);
});

const GRANTS = [
  { id: 'work', resource: 'file:D:/work/**', permission: 'read', effect: 'allow' },
  { id: 'work-w', resource: 'file:D:/work/**', permission: 'write', effect: 'allow' },
  { id: 'app-ask', resource: 'file:D:/work/app/**', permission: 'write', effect: 'ask' },
  { id: 'env', resource: 'file:D:/work/**/.env', permission: 'read', effect: 'deny' },
  { id: 'old', resource: 'file:D:/old/**', permission: 'read', effect: 'allow', expires_at: PAST },
  { id: 'soon', resource: 'file:D:/soon/**', permission: 'read', effect: 'allow', expires_at: FUTURE },
  { id: 'junk-date', resource: 'file:D:/junk/**', permission: 'read', effect: 'allow', expires_at: 'tomorrow' },
  { id: 'openai', resource: 'net:api.openai.com:443', permission: 'connect', effect: 'allow' },
  { id: 'gh', resource: 'tool:github/*', permission: 'call', effect: 'allow' },
  { id: 'gh-del', resource: 'tool:github/delete_repo', permission: 'call', effect: 'deny' },
  { id: 'gh-pr', resource: 'tool:github/merge_pr', permission: 'call', effect: 'ask' },
  { id: 'push', resource: 'command:git push*', permission: 'run', effect: 'ask' },
  { id: 'broken', resource: 'file:work', permission: 'list', effect: 'allow' },
];
const GLOBALS = globalDenies({ home: 'C:\\Users\\dev', coreDir: 'C:\\Users\\dev\\AppData\\Local\\houston-core', otherProfileDirs: ['D:\\profiles\\quarantine'] });
const policy = { grants: GRANTS, globals: GLOBALS, policyVersion: 'v-test', now: NOW };

test('decide: precedence, narrowness, expiry and unattended runs', () => {
  const cases = [
    // [request, decision, determining policies, reason]
    [req('file.read', 'D:\\work\\src\\a.js'), 'allow', ['work'], /allow grant/],
    [req('file.read', 'd:/WORK/src/../src/a.js'), 'allow', ['work'], /allow grant/],
    [req('file.read', 'D:\\work\\.env'), 'deny', ['env'], /explicit deny/],
    [req('file.read', 'D:\\work\\app\\.ENV'), 'deny', ['env'], /explicit deny/],
    [req('file.write', 'D:\\work\\.env'), 'allow', ['work-w'], /allow grant/],
    [req('file.write', 'D:\\work\\app\\x.js'), 'ask', ['app-ask'], /ask grant/],
    [req('file.write', 'D:\\work\\app\\x.js', false), 'deny', ['app-ask'], /unattended/],
    [req('file.write', 'D:\\work\\x.js', false), 'allow', ['work-w'], /allow grant/],
    [req('file.list', 'D:\\work'), 'deny', [], /no grant/],
    [req('file.read', 'D:\\elsewhere\\a'), 'deny', [], /no grant/],
    [req('file.read', 'D:\\old\\a'), 'deny', [], /no grant/],
    [req('file.read', 'D:\\soon\\a'), 'allow', ['soon'], /allow grant/],
    [req('file.read', 'D:\\junk\\a'), 'deny', [], /no grant/],
    [req('file.read', 'D:\\work\\a.txt:secret'), 'deny', [], /resource refused: alternate data streams/],
    [req('file.read', 'D:\\WORK~1\\a.js'), 'deny', [], /resource refused: 8.3/],
    [req('net.connect', 'API.openai.com.:443'), 'allow', ['openai'], /allow grant/],
    [req('net.connect', 'api.openai.com:80'), 'deny', [], /no grant/],
    [req('net.connect', 'api.openai.com'), 'deny', [], /host:port/],
    [req('tool.call', 'github/create_issue'), 'allow', ['gh'], /allow grant/],
    [req('tool.list', 'github/create_issue'), 'allow', ['gh'], /allow grant/],
    [req('tool.call', 'github/delete_repo'), 'deny', ['gh-del'], /explicit deny/],
    [req('tool.call', 'github/merge_pr'), 'ask', ['gh-pr'], /ask grant/],
    [req('tool.call', 'slack/post'), 'deny', [], /no grant/],
    [req('command.run', 'git push --force'), 'ask', ['push'], /ask grant/],
    [req('secret.use', 'github-token'), 'deny', [], /no grant/],
  ];
  for (const [r, decision, ids, reason] of cases) {
    const d = decide(r, policy);
    assert.equal(d.decision, decision, `${r.action} ${r.resource.id}`);
    assert.deepEqual(d.determining_policies, ids, `${r.action} ${r.resource.id}`);
    assert.match(d.reasons.join(' '), reason, `${r.action} ${r.resource.id}`);
    assert.equal(d.policy_version, 'v-test');
    assert.equal(d.approval_id, null);
  }
});

test('decide: a global deny beats any grant, including one for the whole drive (AT-01)', () => {
  const wide = { ...policy, grants: [{ id: 'all', resource: 'file:C:/**', permission: 'read', effect: 'allow' }, { id: 'q', resource: 'file:D:/**', permission: 'read', effect: 'allow' }] };
  const cases = [
    ['C:\\Users\\dev\\.ssh\\id_ed25519', 'global:ssh'],
    ['c:/users/DEV/.SSH', 'global:ssh'],
    ['C:\\Users\\dev\\AppData\\Local\\houston-core\\core.db', 'global:core-data'],
    ['C:\\Users\\dev\\AppData\\Local\\houston-core\\audit\\audit-000001.jsonl', 'global:core-data'],
    ['D:\\profiles\\quarantine\\x', 'global:profile-1'],
    ['C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5\\key', 'global:dpapi-keys'],
    ['C:\\Users\\dev\\.git-credentials', 'global:git-credentials'],
  ];
  for (const [p, id] of cases) {
    const d = decide(req('file.read', p), wide);
    assert.deepEqual([d.decision, d.determining_policies, d.reasons], ['deny', [id], ['global deny']], p);
  }
  assert.equal(decide(req('file.read', 'C:\\Users\\dev\\project\\a.js'), wide).decision, 'allow');
  assert.equal(decide(req('file.read', 'C:\\Users\\dev\\.sshfoo'), wide).decision, 'allow');
});

test('decide: malformed requests and grants fail closed', () => {
  for (const bad of [null, {}, { ...req('file.read', 'D:/work/a'), action: 'file.delete' }, { ...req('file.read', 'D:/work/a'), context: {} },
    { ...req('file.read', 'D:/work/a'), resource: { type: 'File' } }]) {
    assert.deepEqual(decide(bad, policy).reasons, ['malformed request']);
  }
  assert.match(decide({ ...req('file.read', 'D:/work/a'), resource: { type: 'Tool', id: 'D:/work/a' } }, policy).reasons[0], /takes a File/);
  // A broken allow is skipped; a broken deny denies.
  assert.equal(decide(req('file.list', 'D:/work'), policy).decision, 'deny');
  const brokenDeny = { ...policy, grants: [...GRANTS, { id: 'bad-deny', resource: 'file:relative/**', permission: 'read', effect: 'deny' }] };
  assert.deepEqual(decide(req('file.read', 'D:/work/a.js'), brokenDeny).determining_policies, ['bad-deny']);
  // An expired deny stops denying; one with an unreadable date keeps denying.
  const denyAt = (expires_at) => ({ ...policy, grants: [GRANTS[0], { id: 'd', resource: 'file:D:/work/**', permission: 'read', effect: 'deny', expires_at }] });
  assert.equal(decide(req('file.read', 'D:/work/a.js'), denyAt(PAST)).decision, 'allow');
  assert.equal(decide(req('file.read', 'D:/work/a.js'), denyAt('soon')).decision, 'deny');
});

test('decide: on equal narrowness ask beats allow', () => {
  const tie = { ...policy, grants: [
    { id: 'a', resource: 'tool:x/y', permission: 'call', effect: 'allow' },
    { id: 'b', resource: 'tool:x/y', permission: 'call', effect: 'ask' },
  ] };
  assert.equal(decide(req('tool.call', 'x/y'), tie).decision, 'ask');
});

test('check: the identity must exist, be active and not expired; the version follows every grant change', () => {
  const db = openDb(':memory:');
  migrate(db);
  const at = NOW.toISOString();
  db.prepare("INSERT INTO identities (id, kind, display_name, containment, created_at, status) VALUES ('local:me', 'operator', 'Me', 'unconfined', ?, 'active')").run(at);
  db.prepare("INSERT INTO identities (id, kind, display_name, owner, containment, created_at, status) VALUES ('local:dev-codex', 'ai-agent', 'Codex', 'local:me', 'container', ?, 'draft')").run(at);
  db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES ('g1', 'local:dev-codex', 'file:D:/work/**', 'read', 'allow', ?, 'local:me')").run(at);
  const r = req('file.read', 'D:/work/a.js');
  const opts = { globals: GLOBALS, now: NOW };

  assert.deepEqual(check(db, r, opts).reasons, ['the identity is draft']);
  db.exec("UPDATE identities SET status = 'active' WHERE id = 'local:dev-codex'");
  const first = check(db, r, opts);
  assert.deepEqual([first.decision, first.determining_policies], ['allow', ['g1']]);
  assert.equal(first.policy_version, policyVersion(db, GLOBALS));

  db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES ('g2', 'local:dev-codex', 'file:D:/work/a.js', 'read', 'deny', ?, 'local:me')").run(at);
  const second = check(db, r, opts);
  assert.deepEqual([second.decision, second.determining_policies], ['deny', ['g2']]);
  assert.notEqual(second.policy_version, first.policy_version);

  db.exec(`UPDATE identities SET expires_at = '${PAST}' WHERE id = 'local:dev-codex'`);
  assert.deepEqual(check(db, r, opts).reasons, ['the identity has expired']);
  assert.deepEqual(check(db, { ...r, principal: { type: 'Identity', id: 'local:ghost' } }, opts).reasons, ['unknown identity']);
  assert.deepEqual(check(db, { ...r, principal: 'local:me' }, opts).reasons, ['malformed request']);
  // Another identity's grants never answer for this one.
  assert.deepEqual(check(db, { ...r, principal: { type: 'Identity', id: 'local:me' } }, opts).reasons, ['no grant matches']);
});
