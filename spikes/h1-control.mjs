// H1 check (run by hand from PowerShell): the real Core (`node core/main.js`) serves the Control
// API on its pipe; sessions start, list and stop through it; a bad token is refused; the pipe's
// ACL is printed; and a contained shell can reach neither the pipe nor the token file.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h1-control.mjs
// It works in a houston-control-check subfolder there, wiped first. The Core's data folder must be
// the real kind (in the user profile, so sessions are denied it), so it uses
// %LOCALAPPDATA%\houston-core-check, also wiped first.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callControl } from '../core/control.js';
import { OPERATOR, createRegistry } from '../core/identities.js';
import { start } from '../core/main.js';

if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-control-check');
const DATA = path.join(process.env.LOCALAPPDATA, 'houston-core-check');
for (const d of [ROOT, DATA]) fs.rmSync(d, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(WS, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const anon = (/** @type {string} */ s) => s.replaceAll(process.env.LOCALAPPDATA ?? '', '%LOCALAPPDATA%').replaceAll(ROOT, '<root>');

// Seed one contained identity with a workspace, then let the real Core take the database.
const seed = start(DATA);
const reg = createRegistry({ db: seed.db, audit: seed.audit });
reg.create({ id: 'local:dev-shell', kind: 'ai-agent', displayName: 'Dev shell' }, OPERATOR);
reg.addGrant({ identity: 'local:dev-shell', resource: `file:${WS.replaceAll('\\', '/')}/**`, permission: 'write' }, OPERATOR);
reg.setStatus('local:dev-shell', 'active', OPERATOR);
seed.close();

const main = fileURLToPath(new URL('../core/main.js', import.meta.url));
const core = spawn(process.execPath, [main], { env: { ...process.env, HOUSTON_CORE_DATA: DATA, HOUSTON_SESSION_TEMP: path.join(ROOT, 'sessions') }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
let line = '';
core.stdout.on('data', (c) => { line += c; });
for (let i = 0; i < 60 && !line.includes('\n'); i++) await sleep(250);
const started = JSON.parse(line.split('\n')[0]);
console.log(`core.start: pipe ${started.pipe.replace(/[0-9a-f]{32}$/, '<random>')}`);

const call = (/** @type {string} */ m, /** @type {object} */ p = {}) => callControl(DATA, m, p);
const pipe = started.pipe;
const sessions = [];
const begin = async (/** @type {string} */ command) => { const s = await call('session.start', { identity: 'local:dev-shell', workspace: WS, command }); sessions.push(s.id); return s; };

// Two shells that wait for input until stopped.
await begin('cmd.exe /d /q /k');
await begin('cmd.exe /d /q /k');
const tryPipe = await begin(`cmd.exe /d /c echo hi> ${pipe}`);
const tryToken = await begin(`cmd.exe /d /c type "${path.join(DATA, 'control.json')}"`);
console.log(`session.list: ${(await call('session.list')).length} running`);

const raw = await new Promise((resolve) => {
  const sock = net.connect(pipe, () => sock.write(`${JSON.stringify({ id: 1, token: 'guess', method: 'session.list' })}\n`));
  sock.on('data', (c) => { resolve(String(c).trim()); sock.destroy(); });
});
console.log(`wrong token: ${raw}`);

await sleep(6000);
const t0 = Date.now();
const stopped = await call('stop.all');
console.log(`stop.all: ${JSON.stringify(stopped)} in ${Date.now() - t0} ms; then session.list: ${(await call('session.list')).length}`);

const ends = (await call('audit.query', { type: 'session.end' })).events;
for (const [label, id] of [['contained shell writes to the Core pipe', tryPipe.id], ['contained shell reads control.json', tryToken.id]]) {
  const e = ends.find((x) => x.session_id === id);
  console.log(`${label}: exit ${e?.outcome.error_code}`);
}
const denied = (await call('audit.query', { type: 'control.denied' })).events;
console.log(`audit: ${denied.length} control.denied (${denied[0]?.decision.reasons[0]}), ${ends.length} session.end`);

// Windows PowerShell can't load Get-Acl with PowerShell 7's module path, so drop it.
const { PSModulePath: _, ...psEnv } = process.env;
const user = process.env.USERNAME ?? '';
const named = (/** @type {string} */ s) => anon(s).replaceAll(`\\${user}`, '\\<operator>').replace(/^[\w-]+(?=\\<operator>)/gm, '<machine>');
// Get-Acl can't read a pipe (error 87), so connect as a client and ask the pipe for its own.
const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${pipe.slice(9)}', [System.IO.Pipes.PipeDirection]::InOut); $c.Connect(5000); `
  + "$c.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.NTAccount]) | ForEach-Object { '{0}: {1} {2}' -f $_.IdentityReference, $_.AccessControlType, $_.PipeAccessRights }; $c.Dispose()"], { encoding: 'utf8', windowsHide: true, env: psEnv });
console.log('--- pipe ACL ---');
console.log(named(acl.stdout.trim() || acl.stderr.trim()));
console.log('--- data folder ACL ---');
console.log(named(spawnSync('icacls', [DATA], { encoding: 'utf8' }).stdout.replace(DATA, '').split('\n').map((l) => l.trim()).filter((l) => l.includes(':(')).join('\n')).replace(/\b[\w-]+(?=\\<operator>)/g, '<machine>'));

core.kill();
await sleep(1000);
