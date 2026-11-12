// H1 check (run by hand from PowerShell): one agent identity made by hand with core/ctl.js
// against the real Core, taken through its lifecycle, with a real contained session at each
// step that allows one.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h1-identity.mjs
// It works in a houston-identity-check subfolder there, wiped first, and in
// %LOCALAPPDATA%\houston-core-check as the Core's data folder (in the profile, as a real one is), also wiped.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-identity-check');
const DATA = path.join(process.env.LOCALAPPDATA, 'houston-core-check');
for (const d of [ROOT, DATA]) fs.rmSync(d, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(WS, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, HOUSTON_CORE_DATA: DATA, HOUSTON_SESSION_TEMP: path.join(ROOT, 'sessions') };
const at = (/** @type {string} */ f) => fileURLToPath(new URL(f, import.meta.url));

const core = spawn(process.execPath, [at('../core/main.js')], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
let line = '';
core.stdout.on('data', (c) => { line += c; });
for (let i = 0; i < 60 && !line.includes('\n'); i++) await sleep(250);

/** Run ctl.js the way a person would, and print a one-line summary of the answer. @param {string} label @param {string[]} args @param {(r: any) => string} [show] */
function ctl(label, args, show = () => 'ok') {
  const r = spawnSync(process.execPath, [at('../core/ctl.js'), ...args], { env, encoding: 'utf8', windowsHide: true });
  const out = r.status === 0 ? show(JSON.parse(r.stdout)) : `-> ${r.stderr.trim()}`;
  console.log(`${label.padEnd(44)} ${out}`);
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}
const shell = ['session.start', 'identity=local:dev-shell', `workspace=${WS}`, 'command=cmd.exe /d /q /k'];

ctl('identity.create local:dev-shell', ['identity.create', 'id=local:dev-shell', 'kind=ai-agent', 'displayName=Dev shell', 'purpose=H1 identity check'], (r) => `${r.status}, owner ${r.owner}`);
ctl('session.start while draft', shell);
ctl('grant.add write on the workspace', ['grant.add', 'identity=local:dev-shell', `resource=file:${WS.replaceAll('\\', '/')}/**`, 'permission=write'], (r) => `${r.effect} ${r.permission}`);
ctl('grant.add on the user profile', ['grant.add', 'identity=local:dev-shell', 'resource=file:C:/Users/**', 'permission=read'], (r) => `${r.effect} ${r.permission} (the launch refuses it later)`);
ctl('identity.activate', ['identity.activate', 'id=local:dev-shell'], (r) => r.status);
const s1 = ctl('session.start while active', shell, (r) => 'started');
if (!s1) {
  const g = /** @type {any} */ (ctl('identity.get (to drop the profile grant)', ['identity.get', 'id=local:dev-shell'], (r) => `${r.grants.length} grants`));
  ctl('grant.remove the profile grant', ['grant.remove', `id=${g.grants.find((x) => x.resource === 'file:C:/Users/**').id}`], (r) => `removed ${r.resource}`);
}
ctl('session.start again', shell, (r) => 'started');
ctl('session.list', ['session.list'], (r) => `${r.length} running`);
ctl('identity.suspend', ['identity.suspend', 'id=local:dev-shell', 'reason=checking the stop'], (r) => `${r.identity.status}, stopped ${r.stopped}`);
ctl('session.list', ['session.list'], (r) => `${r.length} running`);
ctl('session.start while suspended', shell);
ctl('identity.activate', ['identity.activate', 'id=local:dev-shell'], (r) => r.status);
ctl('identity.retire', ['identity.retire', 'id=local:dev-shell'], (r) => `${r.identity.status}, stopped ${r.stopped}`);
ctl('identity.activate after retire', ['identity.activate', 'id=local:dev-shell']);
ctl('identity.create the same id again', ['identity.create', 'id=local:dev-shell', 'kind=ai-agent', 'displayName=Again']);
ctl('session.start while retired', shell);
ctl('identity.get', ['identity.get', 'id=local:dev-shell'], (r) => `${r.status}, lastUsedAt ${r.lastUsedAt ? 'set' : 'null'}, retiredAt ${r.retiredAt ? 'set' : 'null'}, ${r.grants.length} grant`);
console.log('--- audit ---');
const events = /** @type {any} */ (ctl('audit.query', ['audit.query', 'limit=100'], (r) => `${r.events.length} events`)).events;
for (const e of events.filter((/** @type {any} */ x) => x.type !== 'core.start')) {
  const what = e.lifecycle ? `${e.lifecycle.from}->${e.lifecycle.to}` : e.grant ? `${e.grant.effect} ${e.grant.permission} ${e.grant.resource.replace(WS.replaceAll('\\', '/'), '<ws>')}` : e.decision.reasons?.[0] ?? e.outcome?.error_code ?? '';
  console.log(`${e.type.padEnd(19)} ${e.action.padEnd(17)} ${e.decision.result.padEnd(5)} ${e.resource.type === 'Identity' ? e.resource.id : `<${e.resource.type.toLowerCase()}>`} ${what.replace(WS, '<ws>')}`);
}
core.kill();
await sleep(1000);
