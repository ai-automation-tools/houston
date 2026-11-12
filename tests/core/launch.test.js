import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchError, launchRequest } from '../../core/launch.js';
import { globalDenies } from '../../core/policy.js';

const HOME = 'C:\\Users\\dev';
const GLOBALS = globalDenies({ home: HOME, coreDir: 'C:\\Users\\dev\\AppData\\Local\\houston-core', otherProfileDirs: ['E:\\profiles\\quarantine'] });
const BASE = {
  command: 'node --test', workspace: 'D:\\work\\app', temp: 'D:\\houston-tmp\\s1', home: HOME, globals: GLOBALS,
  readonly: ['C:\\Program Files\\nodejs', 'C:\\Program Files\\Git'], pathDirs: ['C:\\Program Files\\nodejs'],
};

test('launchRequest: the spike defaults, in the shape the SDK takes', () => {
  const r = launchRequest(BASE);
  assert.equal(r.command, 'node --test');
  assert.equal(r.workingDirectory, 'D:\\work\\app');
  assert.deepEqual(r.ui, { disable: false });
  assert.deepEqual(r.filesystem, {
    readwritePaths: ['D:\\work\\app', 'D:\\houston-tmp\\s1'],
    readonlyPaths: ['C:\\Program Files\\nodejs', 'C:\\Program Files\\Git'],
    // The users folder covers every global deny under the profile; the one outside it is added.
    deniedPaths: ['C:\\Users', 'E:\\profiles\\quarantine'],
  });
  assert.deepEqual(r.containment, { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['D:\\', 'C:\\'] } } });
  assert.deepEqual(r.environment, {
    PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Program Files\\nodejs',
    TEMP: 'D:\\houston-tmp\\s1', TMP: 'D:\\houston-tmp\\s1', PYTHONNOUSERSITE: '1',
  });
  assert.deepEqual(r.network, { egress: { default: 'deny' } });
  assert.equal(r.inheritDefaultEnvironment, true);
});

test('launchRequest: a proxy port gives the one combination that leaves only that port reachable (S2)', () => {
  assert.equal(launchRequest({ ...BASE, proxyPort: 18080 }).environment.NODE_USE_ENV_PROXY, '1');
  assert.equal(launchRequest(BASE).environment.NODE_USE_ENV_PROXY, undefined);
  assert.deepEqual(launchRequest({ ...BASE, proxyPort: 18080 }).network, {
    egress: { default: 'deny' }, ingress: { default: 'allow', hostLoopback: 'allow' }, runtimeConfig: { networkProxy: 'http://127.0.0.1:18080' },
  });
  for (const bad of [0, 70000, 1.5, '8080']) assert.throws(() => launchRequest({ ...BASE, proxyPort: bad }), /port/);
});

test('launchRequest: paths are canonical and listed once, read-write winning over read-only', () => {
  const r = launchRequest({
    ...BASE, workspace: 'd:/work/./app/', readwrite: ['C:\\Users\\dev\\.claude', 'D:\\WORK\\APP'],
    readonly: ['C:\\Program Files\\nodejs\\', 'c:\\program files\\NODEJS', 'C:\\Users\\dev\\.claude'], denied: ['F:\\private', 'C:\\users'],
  });
  assert.deepEqual(r.filesystem.readwritePaths, ['D:\\work\\app', 'D:\\houston-tmp\\s1', 'C:\\Users\\dev\\.claude']);
  assert.deepEqual(r.filesystem.readonlyPaths, ['C:\\Program Files\\nodejs']);
  assert.deepEqual(r.filesystem.deniedPaths, ['C:\\Users', 'F:\\private', 'E:\\profiles\\quarantine']);
  assert.deepEqual(r.containment.config.filesystem.enumeratePaths, ['D:\\', 'C:\\']);
});

test('launchRequest refuses what would be unsafe or would not start', () => {
  const refused = [
    [{ command: '' }, /one non-empty line/],
    [{ command: 'node\r\ncalc' }, /one non-empty line/],
    [{ workspace: 'work\\app' }, /workspace: the path is not absolute/],
    [{ workspace: '\\\\server\\share\\app' }, /network/],
    [{ workspace: 'C:\\Users\\dev\\src\\app' }, /workspace .* is under the denied folder C:\\Users/],
    [{ temp: 'C:\\Users\\dev\\AppData\\Local\\Temp\\s1' }, /temp folder .* is under the denied folder/],
    [{ workspace: 'F:\\private\\app', denied: ['F:\\private'] }, /under the denied folder F:\\private/],
    [{ readonly: ['C:\\Users\\dev\\.ssh'] }, /overlaps a global deny/],
    [{ readwrite: ['C:\\Users\\dev'] }, /overlaps a global deny/],
    [{ readwrite: ['C:\\Users\\dev\\AppData\\Local\\houston-core\\audit'] }, /overlaps a global deny/],
    [{ readonly: ['E:\\profiles'] }, /overlaps a global deny/],
    [{ readonly: ['D:\\'] }, /whole drive/],
    [{ readonly: ['C:\\PROGRA~1\\nodejs'] }, /8.3/],
    [{ env: { PATH: 'C:\\evil' } }, /set by the launch defaults/],
    [{ env: { tmp: 'C:\\x' } }, /set by the launch defaults/],
    [{ env: { NODE_USE_ENV_PROXY: '0' } }, /set by the launch defaults/],
    [{ env: { 'BAD NAME': 'x' } }, /bad environment name/],
    [{ env: { X: 'a\nb' } }, /one-line string/],
    [{ env: { X: 1 } }, /one-line string/],
    [{ globals: [{ id: 'g', resource: 'net:x:1' }] }, /not a folder pattern/],
  ];
  for (const [change, want] of refused) {
    assert.throws(() => launchRequest({ ...BASE, ...change }), (e) => e instanceof LaunchError && want.test(e.message), JSON.stringify(change));
  }
});

test('launchRequest: a CLI config folder under the profile may be granted; the backend env passes through', () => {
  const r = launchRequest({ ...BASE, readwrite: ['C:\\Users\\dev\\.codex'], env: { CODEX_HOME: 'C:\\Users\\dev\\.codex' } });
  assert.ok(r.filesystem.readwritePaths.includes('C:\\Users\\dev\\.codex'));
  assert.equal(r.environment.CODEX_HOME, 'C:\\Users\\dev\\.codex');
  assert.ok(r.filesystem.deniedPaths.includes('C:\\Users'));
});
