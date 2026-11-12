// H1 check (run by hand from PowerShell): the runner starts a real contained shell on a PTY
// from an identity's grants, the shell can do what the grants say and nothing else, and
// stopping the session closes the container.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h1-runner.mjs
// It works in a houston-runner-check subfolder there, wiped first. Needs internet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../core/main.js';
import { createRunner } from '../core/runner.js';

if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-runner-check');
fs.rmSync(ROOT, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'outside.txt'), 'not granted\n');

const home = os.homedir();
const anon = (s) => String(s).replaceAll(home, '%USERPROFILE%').replaceAll(ROOT, '<root>');
const core = start(path.join(ROOT, 'core'));
const at = new Date().toISOString();
core.db.exec(`INSERT INTO identities (id, kind, display_name, containment, created_at, status) VALUES ('local:operator', 'operator', 'Operator', 'unconfined', '${at}', 'active');
  INSERT INTO identities (id, kind, display_name, owner, containment, created_at, status) VALUES ('local:dev-shell', 'ai-agent', 'Dev shell', 'local:operator', 'container', '${at}', 'active');`);
const grant = core.db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES (?, 'local:dev-shell', ?, ?, 'allow', ?, 'local:operator')");
for (const [id, resource, permission] of [
  ['ws', `file:${WS.replaceAll('\\', '/')}/**`, 'write'],
  ['node', 'file:C:/Program Files/nodejs/**', 'read'],
  ['npm-registry', 'net:registry.npmjs.org:443', 'connect'],
  ['revocation', 'net:c.pki.goog:80', 'connect'],
]) grant.run(id, resource, permission, at);

const runner = createRunner({ db: core.db, audit: core.audit, coreDir: core.dir, tempRoot: path.join(ROOT, 'sessions') });
const session = await runner.start({
  identity: 'local:dev-shell', workspace: WS, command: 'cmd.exe /d /q /k prompt $G',
  program: { pathDirs: ['C:\\Program Files\\nodejs'] }, size: { rows: 30, columns: 120 },
});
let out = '';
session.output.on('data', (c) => { out += c.toString('utf8'); });
const send = async (line, ms = 4000) => { session.input.write(`${line}\r`); await new Promise((r) => setTimeout(r, ms)); };

await send('node --version');
await send('echo written> here.txt & type here.txt');
await send(`type "${path.join(ROOT, 'outside.txt')}"`);
await send(`dir /b "${path.join(home, '.ssh')}"`);
await send('curl.exe -sS -o NUL -w "registry HTTP %{http_code}\\n" https://registry.npmjs.org/', 8000);
await send('curl.exe -sS -o NUL -w "HTTP %{http_code}\\n" https://example.com/', 6000);
const end = await session.stop();
core.close();

// eslint-disable-next-line no-control-regex
const plain = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
console.log('--- terminal ---');
console.log(anon(plain.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n')));
console.log(`--- end: ${end.reason} ---`);
console.log('--- audit ---');
const log = fs.readFileSync(path.join(ROOT, 'core', 'audit', 'audit-000001.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
for (const e of log) {
  const extra = e.launch ? ` denied=${anon(e.launch.denied.join(','))} network=${JSON.stringify(e.launch.network)}` : e.egress ? ` ${e.egress.scheme} ${e.decision.reasons[0]}` : e.outcome ? ` ${e.outcome.error_code ?? e.outcome.status}` : '';
  console.log(`${e.audit.seq} ${e.type} ${e.decision.result} ${e.resource.id === session.id ? '<session>' : e.resource.id}${extra}`);
}
console.log(`session row: ${JSON.stringify(new (await import('node:sqlite')).DatabaseSync(path.join(ROOT, 'core', 'core.db')).prepare('SELECT end_reason FROM sessions').get())}`);
console.log(`temp folder left: ${fs.existsSync(path.join(ROOT, 'sessions', session.id))}`);
