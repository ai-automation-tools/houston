import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anonymize, attempt, firstLine, removeDir } from '../abuse/harness.js';

test('removeDir deletes links, never what they point at', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-abuse-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, 'precious');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  const dir = path.join(base, 'ws', 'at02');
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.symlinkSync(target, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(target, path.join(dir, 'nested', 'link2'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(dir, 'a.out'), 'x');
  removeDir(path.join(base, 'ws'));
  assert.equal(fs.existsSync(path.join(base, 'ws')), false);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  removeDir(path.join(base, 'missing'));
});

test('attempt keeps stdout, stderr and the exit code, with the redirection inside the parentheses', () => {
  assert.deepEqual(attempt('a1', 'more < "C:\\x"'), ['(more < "C:\\x") > a1.out 2> a1.err', 'echo %errorlevel%> a1.code']);
});

test('anonymize replaces the data folder, the scratch root, the profile, the user and the machine, either slash', () => {
  const home = os.homedir();
  const h = { data: path.join(home, 'AppData', 'Local', 'houston-core-abuse'), root: path.join(os.tmpdir(), 'scratch-root'), home };
  const user = os.userInfo().username;
  const s = anonymize(h, `${h.data}\\control.json ${h.root}/ws ${home.replaceAll('\\', '/')}/.ssh ${user.toUpperCase()}`);
  assert.equal(s.includes(user), false);
  assert.equal(s.toLowerCase().includes(user.toLowerCase()), false);
  assert.match(s, /<core-data>[\\/]control\.json <root>\/ws %USERPROFILE%\/\.ssh <user>/);
  assert.equal(firstLine('\r\n  Access is denied.\r\nmore'), 'Access is denied.');
});
