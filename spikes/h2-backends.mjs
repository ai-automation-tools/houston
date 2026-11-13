// H2 check (run by hand from PowerShell): each backend manifest starts its real CLI in a real
// container, with its own home under the profile, and gets as far as the CLI's first screen.
// Nothing is typed, so neither CLI signs in or sends a prompt.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h2-backends.mjs
// It works in a houston-backends-check subfolder there and in %LOCALAPPDATA%\houston-agents-check,
// both wiped first and the second removed after.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKENDS } from '../core/backends.js';
import { OPERATOR, createRegistry } from '../core/identities.js';
import { secureDir, start } from '../core/main.js';
import { createRunner } from '../core/runner.js';

if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-backends-check');
const AGENTS = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'houston-agents-check');
for (const d of [ROOT, AGENTS]) fs.rmSync(d, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(AGENTS, { recursive: true });
secureDir(AGENTS);

const home = os.homedir();
const anon = (s) => String(s).replaceAll(home, '%USERPROFILE%').replaceAll(ROOT, '<root>');
// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?/g, '').replace(/\r/g, '');

const core = start(path.join(ROOT, 'core'));
const reg = createRegistry({ db: core.db, audit: core.audit });
const runner = createRunner({ db: core.db, audit: core.audit, coreDir: core.dir, tempRoot: path.join(ROOT, 'sessions'), agentsRoot: AGENTS });
console.log(JSON.stringify(runner.backends().map(({ name, installed }) => ({ name, installed }))));

for (const name of Object.keys(BACKENDS)) {
  const id = `local:check-${name}`;
  reg.create({ id, kind: 'ai-agent', displayName: `Check ${name}`, backend: name }, OPERATOR);
  reg.addGrant({ identity: id, resource: `file:${WS.replaceAll('\\', '/')}/**`, permission: 'write' }, OPERATOR);
  for (const h of BACKENDS[name].hosts) reg.addGrant({ identity: id, resource: `net:${h}`, permission: 'connect' }, OPERATOR);
  reg.setStatus(id, 'active', OPERATOR);

  const session = await runner.start({ identity: id, workspace: WS, size: { rows: 40, columns: 120 } });
  let out = '';
  session.output.on('data', (c) => { out += c.toString('utf8'); });
  await new Promise((r) => setTimeout(r, 25_000));
  const end = await session.stop();
  const lines = plain(out).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  console.log(`\n=== ${name}: end ${end.reason}, ${out.length} bytes of terminal output ===`);
  console.log(anon([...new Set(lines)].slice(-25).join('\n')));
  const files = fs.readdirSync(path.join(AGENTS, `check-${name}`, name));
  console.log(`home now holds: ${files.join(', ') || '(nothing)'}`);
}

console.log('\n--- audit ---');
for (const e of core.audit.events()) {
  if (!['session.start', 'egress.connect', 'session.end'].includes(e.type)) continue;
  const extra = e.launch ? ` cmd=${anon(e.launch.command)} rw=${anon(e.launch.readwrite.join(','))} ro=${anon(e.launch.readonly.join(','))} missing=${JSON.stringify(e.launch.backend?.missingHosts)}`
    : e.egress ? ` ${e.decision.reasons[0]}` : e.outcome ? ` ${e.outcome.error_code ?? e.outcome.status}` : ` ${e.decision.reasons?.[0] ?? ''}`;
  console.log(`${e.audit.seq} ${e.type} ${e.identity.subject} ${e.decision.result}${e.type === 'egress.connect' ? ` ${e.resource.id}` : ''}${extra}`);
}
core.close();
fs.rmSync(AGENTS, { recursive: true, force: true });
