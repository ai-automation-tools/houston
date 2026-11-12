// Spike S1 (throwaway): do git, npm, node --test and pytest run inside a process container
// under a file policy that starts from nothing, and how wide must the read list be?
// Usage: node spikes/s1-containment.mjs [--learn] [--no-enumerate] [--no-ui] [--extra <path>]...
// Run it from PowerShell, not Git Bash: the SDK shells out to `whoami /user` and Git's whoami breaks it.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { run } from '@microsoft/mxc-sdk/v1';

const ROOT = process.env.S1_ROOT ?? 'D:\\AI_Agents\\_maintenance\\tmp\\houston-s1';
const WS = path.join(ROOT, 'ws');
const TMP = path.join(ROOT, 'tmp');
const flag = (f) => process.argv.includes(f);
const learn = flag('--learn');
const noEnum = flag('--no-enumerate');
const noUi = flag('--no-ui');
const extras = process.argv.flatMap((a, i, all) => (a === '--extra' ? [all[i + 1]] : []));

function makeWorkspace() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(path.join(WS, 'package.json'), JSON.stringify({
    name: 's1', version: '1.0.0', type: 'module', private: true, dependencies: process.env.S1_DEPS ? JSON.parse(process.env.S1_DEPS) : { 'is-odd': '3.0.1' },
  }, null, 2));
  writeFileSync(path.join(WS, 'a.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert';\nimport isOdd from 'is-odd';\ntest('odd', () => assert.equal(isOdd(3), true));\n");
  writeFileSync(path.join(WS, 'test_a.py'), 'def test_a():\n    assert 1 + 1 == 2\n');
  execSync('git init -q && git add -A', { cwd: WS, stdio: 'ignore' });
}

const TOOLCHAIN = ['C:\\Program Files\\Git', 'C:\\Program Files\\nodejs', 'C:\\Python312'];
// Node resolves real paths by lstat-ing every parent folder from the drive root down, so the
// roots need "enumerate" (names only, no contents). Enumerate is recursive: without the deny
// below a contained process can list every file name on the drive, including ~/.ssh.
const ENUMERATE = ['C:\\', 'D:\\'];
const DENIED = ['C:\\Users'];
const env = {
  TEMP: TMP, TMP: TMP,
  npm_config_cache: path.join(TMP, 'npm-cache'),
  npm_config_update_notifier: 'false',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONNOUSERSITE: '1', // the per-user site-packages folder is under the denied profile
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(TMP, 'gitconfig'),
  PATH: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\nodejs', 'C:\\Python312', 'C:\\Windows\\System32', 'C:\\Windows'].join(';'),
};

const COMMANDS = [
  ['echo', 'cmd.exe /d /c echo MXC_OK'],
  ['git status', 'git -c safe.directory=* status --short'],
  ['npm install', 'cmd.exe /d /c npm install --no-audit --no-fund'],
  ['node --test', 'node --test'],
  ['pytest', 'python -m pytest -q -p no:cacheprovider'],
];

function request(command, name) {
  const config = {};
  if (!noEnum) config.filesystem = { enumeratePaths: ENUMERATE };
  if (learn) config.captureDenials = { mode: 'block', outputPath: path.join(ROOT, `denials-${name.replace(/\W+/g, '-')}.json`) };
  return {
    command,
    workingDirectory: WS,
    environment: env,
    inheritDefaultEnvironment: true,
    timeoutMs: 180_000,
    filesystem: { readwritePaths: [WS, TMP], readonlyPaths: [...TOOLCHAIN, ...extras], ...(noEnum ? {} : { deniedPaths: DENIED }) },
    network: { egress: { default: 'allow' } }, // S1 is about files; S2 covers the network
    // Without this node, git and Python's _ssl die with 0xC0000142: user32 cannot initialise.
    // Clipboard and input injection stay denied.
    ...(noUi ? {} : { ui: { disable: false } }),
    containment: { type: 'processcontainer', config },
  };
}

function hostTime(command) {
  const t = performance.now();
  try { execSync(command, { cwd: WS, env: { ...process.env, ...env }, stdio: 'ignore' }); } catch { return NaN; }
  return performance.now() - t;
}

makeWorkspace();
const rows = [];
for (const [name, command] of COMMANDS) {
  let r;
  try { r = await run(request(command, name)); } catch (e) { r = { exitCode: -1, stdout: '', stderr: `${e.code ?? ''} ${e.message}`, warnings: [] }; }
  rows.push({ name, exit: r.exitCode });
  console.log(`\n=== ${name} -> exit ${r.exitCode} (0x${(r.exitCode >>> 0).toString(16)})`);
  console.log((r.stdout + r.stderr).trim().split('\n').slice(-8).join('\n'));
  if (r.warnings?.length) console.log('warnings:', r.warnings);
  if (r.outputMetadata) console.log('metadata:', JSON.stringify(r.outputMetadata));
}

if (rows.every((r) => r.exit === 0)) {
  // Timing: 5 alternating runs, contained then host, same env, warm npm cache. Median.
  const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  for (const row of rows) {
    const cmd = COMMANDS.find(([n]) => n === row.name)[1];
    const c = [], h = [];
    const clean = () => { if (row.name === 'npm install') rmSync(path.join(WS, 'node_modules'), { recursive: true, force: true }); };
    for (let i = 0; i < 5; i++) {
      clean(); const t = performance.now(); await run(request(cmd, row.name)); c.push(performance.now() - t);
      clean(); h.push(hostTime(cmd));
    }
    row.containedMs = Math.round(median(c)); row.hostMs = Math.round(median(h));
    row.slowdown = +(row.containedMs / row.hostMs).toFixed(2);
  }
}
console.log('\n' + JSON.stringify({ readwrite: [WS, TMP], readonly: [...TOOLCHAIN, ...extras], enumerate: noEnum ? [] : ENUMERATE, denied: noEnum ? [] : DENIED, ui: !noUi, rows }, null, 2));
