// H5 check (run by hand from PowerShell): a broad-access identity. A throwaway Core (data in
// %LOCALAPPDATA%\houston-core-h5broad, work in <H1_ROOT>\houston-h5broad, both wiped):
//   its session runs on the host: it writes outside the folder it's granted (no container stops it),
//   still reaches its gateway with its token, and every record of it says unconfined
//   a standing grant for it is refused until switched on for that identity; then `harness run` runs it,
//   and switched off again, the next run is refused
//   Stop All ends its whole process tree
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h5-broad-access.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, sleep } from '../abuse/harness.js';

if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const HARNESS = fileURLToPath(new URL('../core/harness.js', import.meta.url));
const NODE_DIR = path.dirname(process.execPath);
const ID = 'local:h5-broad';
const fwd = (/** @type {string} */ p) => p.replaceAll('\\', '/');
const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-h5broad'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-h5broad') });
let pass = false;
try {
  await h.startCore();
  const dir = path.join(h.ws, 'broad');
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(h.root, 'outside-the-workspace.txt');
  await h.call('identity.create', { id: ID, kind: 'ai-agent', displayName: 'H5 broad access', containment: 'unconfined', purpose: 'Work that does not fit in a container' });
  await h.call('grant.add', { identity: ID, resource: `file:${fwd(dir)}/**`, permission: 'write' });
  await h.call('identity.activate', { id: ID });

  // One session: write outside its workspace, call its gateway, then wait to be stopped.
  fs.writeFileSync(path.join(dir, 'broad.mjs'), `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(outside)}, 'written by a broad-access session');
const r = await fetch(process.env.HOUSTON_MCP_URL, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.HOUSTON_MCP_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }).then((x) => x.status, (e) => String(e));
fs.writeFileSync('gateway.txt', String(r));
setInterval(() => {}, 1000);
`);
  const s = await h.call('session.start', { identity: ID, workspace: dir, command: `"${process.execPath}" "${path.join(dir, 'broad.mjs')}"`, program: { pathDirs: [NODE_DIR] } });
  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, 'gateway.txt')); i++) await sleep(250);
  const wrote = fs.existsSync(outside);
  const gateway = fs.existsSync(path.join(dir, 'gateway.txt')) ? fs.readFileSync(path.join(dir, 'gateway.txt'), 'utf8') : 'no answer';
  const start = await h.startEvent(s.id);
  const listed = (await h.call('session.list')).find((/** @type {any} */ x) => x.id === s.id);
  const pids = () => spawnSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*broad.mjs*' }).Count"], { encoding: 'utf8' }).stdout.trim();
  const before = pids();
  const stopped = await h.call('stop.all');
  await h.waitEnd(s.id, 15_000);
  await sleep(1500);
  const after = pids();
  console.log(`session: wrote outside its workspace ${wrote}; gateway answered ${gateway}; start event containment ${start?.identity?.containment}, launch ${start?.launch?.containment} (${start?.launch?.note}); listed as ${listed?.containment}`);
  console.log(`Stop All stopped ${stopped.stopped}; its processes before ${before}, after ${after}`);

  // Standing grants: off until switched on for this identity.
  const spec = { id: 'broad-nightly', identity: ID, workspace: dir, command: 'cmd.exe /d /c echo ran> standing.txt', maxMinutes: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const refused = await h.call('standing.create', spec).then(() => 'created (wrong)', (e) => `refused: ${e.message}`);
  await h.call('identity.allowStanding', { id: ID, allowed: true });
  await h.call('standing.create', spec);
  await h.call('standing.resume', { id: 'broad-nightly' }).catch(() => {});
  const run = (/** @type {string} */ grant) => new Promise((resolve) => {
    const p = spawn(process.execPath, [HARNESS, 'run', '--grant', grant], { env: { ...process.env, HOUSTON_CORE_DATA: h.data }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('exit', (code) => resolve({ code, out: out.trim().split('\n').at(-1) }));
  });
  const first = /** @type {any} */ (await run('broad-nightly'));
  const ran = fs.existsSync(path.join(dir, 'standing.txt'));
  await h.call('identity.allowStanding', { id: ID, allowed: false });
  const second = /** @type {any} */ (await run('broad-nightly'));
  console.log(`standing grant before the switch: ${refused}`);
  console.log(`switched on: harness run exit ${first.code}, wrote standing.txt ${ran}; switched off: exit ${second.code} (${second.out})`);

  pass = wrote && gateway === '200' && start?.identity?.containment === 'unconfined' && start?.launch?.containment === 'unconfined' && listed?.containment === 'unconfined'
    && stopped.stopped === 1 && Number(after) === 0 && refused.startsWith('refused') && first.code === 0 && ran && second.code !== 0;
} finally {
  await h.close();
  for (const d of [h.root, h.data]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(pass ? '\nPASS' : '\nFAIL');
process.exit(pass ? 0 : 1);
