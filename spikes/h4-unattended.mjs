// H4 check (run by hand from PowerShell): a standing grant that runs an agent CLI (Claude Code or Codex)
// unattended, with its permission prompts off, as a scheduled task would: `harness run --grant <id>`.
// It needs a contained identity of that backend that has signed in once: its sign-in lives in
// %LOCALAPPDATA%\houston-agents\<id>\<backend>, beside any Core's data folder, so this
// throwaway Core (data in %LOCALAPPDATA%\houston-core-h4unattended, work in <H1_ROOT>\houston-h4unattended,
// both wiped) makes an identity of the same id and uses that sign-in. The sign-in folder is left alone.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'
//        node spikes/h4-unattended.mjs [local:claude-runner [claude-code]]
//        node spikes/h4-unattended.mjs local:codex-runner codex
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../abuse/harness.js';
import { BACKENDS } from '../core/backends.js';

if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ID = process.argv[2] ?? 'local:claude-runner';
const BACKEND = process.argv[3] ?? 'claude-code';
const m = Object.hasOwn(BACKENDS, BACKEND) ? BACKENDS[BACKEND] : null;
if (!m?.headless) { console.error(`${BACKEND} is not a backend with an unattended start`); process.exit(1); }
const HARNESS = fileURLToPath(new URL('../core/harness.js', import.meta.url));
const signIn = path.join(process.env.LOCALAPPDATA, 'houston-agents', ID.replace(/^local:/, '').replaceAll('/', '+'), BACKEND);
if (!fs.existsSync(signIn)) { console.error(`${ID} has no ${m.displayName} home at ${signIn}: sign it in once first.`); process.exit(1); }

const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-h4unattended'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-h4unattended') });
const anon = (/** @type {string} */ s) => s.replaceAll(h.home, '%USERPROFILE%').replaceAll(h.root, '<root>');
let code = 1;
try {
  await h.startCore();
  await h.call('identity.create', { id: ID, kind: 'ai-agent', displayName: `${m.displayName} runner`, backend: BACKEND });
  for (const [resource, permission] of [[`file:${h.ws.replaceAll('\\', '/')}/**`, 'write'], ...m.hosts.map((x) => [`net:${x}`, 'connect'])]) {
    await h.call('grant.add', { identity: ID, resource, permission });
  }
  await h.call('identity.activate', { id: ID });
  const prompt = 'Create a file named unattended.txt in the current folder whose only content is the word done. Then reply with the single word DONE.';
  await h.call('standing.create', { id: 'unattended-check', identity: ID, workspace: h.ws, prompt, maxMinutes: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

  const t0 = Date.now();
  const run = await new Promise((resolve) => {
    const p = spawn(process.execPath, [HARNESS, 'run', '--grant', 'unattended-check'], { env: { ...process.env, HOUSTON_CORE_DATA: h.data }, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (c) => resolve({ code: c, out, err }));
  });
  const file = path.join(h.ws, 'unattended.txt');
  const wrote = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
  const events = (await h.call('audit.query', { limit: 200 })).events;
  const start = events.find((/** @type {any} */ e) => e.type === 'session.start' && e.standing_grant === 'unattended-check');
  const egress = events.filter((/** @type {any} */ e) => e.type === 'egress.connect').map((/** @type {any} */ e) => `${e.decision.result} ${e.resource.id}`);

  console.log(`harness exit ${run.code} after ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`unattended.txt: ${wrote === null ? 'missing' : JSON.stringify(wrote)}`);
  console.log(`session.start: ${start ? `standing_grant=${start.standing_grant}, command ends ${JSON.stringify(start.launch.command.slice(-140))}` : 'none'}`);
  console.log(`egress: ${[...new Set(egress)].join(', ') || 'none'}`);
  console.log(`cards asked: ${events.filter((/** @type {any} */ e) => e.type === 'approval.requested').length}`);
  console.log('--- its output (the transcript), last lines ---');
  console.log(anon(run.out.split('\n').filter((l) => l.trim()).slice(-8).join('\n')));
  console.log(anon(run.err.trim()));
  code = run.code === 0 && wrote === 'done' ? 0 : 1;
} finally {
  await h.close();
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.rmSync(h.data, { recursive: true, force: true });
}
console.log(code === 0 ? `\nPASS: ${m.displayName} ran the prompt unattended and wrote the file` : '\nFAIL');
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(code);
