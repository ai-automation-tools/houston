// H6 check (run by hand from PowerShell): a Promptbook skill, discovered, installed and attached as
// three steps, then used by Claude Code in a contained session. A throwaway Core (data in
// %LOCALAPPDATA%\houston-core-h6skills, work in <H1_ROOT>\houston-h6skills, both wiped):
//   discover  Promptbook's MCP server runs in its own container, read-only (READ_ONLY=true; a deny
//             grant keeps its .env out), and a contained agent searches it and reads one skill
//   install   the operator copies that skill from Promptbook's library (skill.install)
//   attach    a skill:<name> use grant on a Claude Code identity
//   use       that identity runs a prompt unattended that needs the skill's text; a second run
//             without the grant shows the skill isn't there otherwise
// Like h4-unattended.mjs it reuses local:claude-runner's sign-in (houston-agents\claude-runner);
// the skill it installs (in houston-skills\default) and its link in that home are removed after.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; $env:PROMPTBOOK = '<the
// promptbook clone's site folder>'; node spikes/h6-skills.mjs [query]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness } from '../abuse/harness.js';
import { BACKENDS } from '../core/backends.js';

const SITE = process.env.PROMPTBOOK;
if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA || !SITE) { console.error('Set H1_ROOT to a scratch folder outside your user profile and PROMPTBOOK to the promptbook site folder.'); process.exit(1); }
const QUERY = process.argv[2] ?? 'commit message';
const RUNNER = 'local:claude-runner';
const HARNESS = fileURLToPath(new URL('../core/harness.js', import.meta.url));
const NODE_DIR = path.dirname(process.execPath);
const fwd = (/** @type {string} */ p) => p.replaceAll('\\', '/');
const home = path.join(process.env.LOCALAPPDATA, 'houston-agents', 'claude-runner', 'claude-code');
if (!fs.existsSync(home)) { console.error(`${RUNNER} has no Claude Code home at ${home}: sign it in once first.`); process.exit(1); }

const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-h6skills'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-h6skills') });
let pass = false;
let installed = null;
try {
  await h.startCore();
  // Discover: Promptbook, read-only, in its own container.
  const loader = pathToFileURL(path.join(SITE, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  await h.call('mcp.add', { name: 'promptbook', command: `"${process.execPath}" --import ${loader} "${path.join(SITE, 'mcp', 'server.ts')}"`, env: { READ_ONLY: 'true' }, pathDirs: [NODE_DIR] });
  await h.call('grant.add', { identity: 'local:mcp/promptbook', resource: `file:${fwd(SITE)}/**`, permission: 'read' });
  await h.call('grant.add', { identity: 'local:mcp/promptbook', resource: `file:${fwd(SITE)}/.env`, permission: 'read', effect: 'deny' });
  const pb = await h.call('mcp.install', { name: 'promptbook' });
  await h.call('mcp.pin', { name: 'promptbook', hash: pb.toolsHash });
  console.log(`promptbook pinned, read-only: ${pb.tools.map((/** @type {any} */ t) => t.name).join(', ')}`);

  const finder = 'local:h6-finder';
  const dir = path.join(h.ws, 'finder');
  fs.mkdirSync(dir, { recursive: true });
  await h.call('identity.create', { id: finder, kind: 'ai-agent', displayName: 'H6 finder', purpose: 'Searches the catalogue' });
  for (const [resource, permission] of [[`file:${fwd(dir)}/**`, 'write'], [`file:${fwd(NODE_DIR)}/**`, 'read'], ['tool:promptbook/*', 'call']]) await h.call('grant.add', { identity: finder, resource, permission });
  await h.call('identity.activate', { id: finder });
  fs.writeFileSync(path.join(dir, 'find.mjs'), `
import fs from 'node:fs';
let n = 0;
const call = async (name, args) => (await (await fetch(process.env.HOUSTON_MCP_URL, { method: 'POST',
  headers: { authorization: 'Bearer ' + process.env.HOUSTON_MCP_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) })).json()).result.content.at(-1).text;
const found = await call('promptbook.search_library', { query: ${JSON.stringify(QUERY)}, section: 'skills', limit: 5 });
const id = /\`(3_Skills\\/[^\`]+)\`/.exec(found)?.[1] ?? null;
const skill = id ? await call('promptbook.get_skill', { id }) : null;
const write = await call('promptbook.save_to_my_library', { title: 'x', content: 'y' }).catch((e) => String(e));
fs.writeFileSync('found.json', JSON.stringify({ found, id, skill: skill?.slice(0, 2000), write }));
`);
  const f = await h.call('session.start', { identity: finder, workspace: dir, command: `"${process.execPath}" "${path.join(dir, 'find.mjs')}"`, program: { pathDirs: [NODE_DIR] }, attended: false });
  await h.waitEnd(f.id, 120_000);
  const found = JSON.parse(fs.readFileSync(path.join(dir, 'found.json'), 'utf8'));
  console.log(`discover: "${QUERY}" -> ${found.id ?? 'nothing: ' + String(found.found).slice(0, 600)}; a write tool: ${String(found.write).slice(0, 120)}`);
  if (!found.id) throw new Error('the catalogue found no skill');

  // Install, as the operator.
  const folder = path.join(SITE, 'library', found.id.replace(/\/SKILL\.md$/i, ''));
  installed = await h.call('skill.install', { from: folder, source: `promptbook:${found.id}` });
  const heading = /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(installed.folder, 'SKILL.md'), 'utf8'))?.[1].trim() ?? '';
  console.log(`install: ${installed.name}, ${installed.files} files, hash ${installed.hash.slice(0, 12)}…; its first heading "${heading}"`);

  // Attach and use: Claude Code, unattended, asked for something only the skill's text has.
  await h.call('identity.create', { id: RUNNER, kind: 'ai-agent', displayName: 'Claude runner', backend: 'claude-code' });
  for (const [resource, permission] of [[`file:${fwd(h.ws)}/**`, 'write'], ...BACKENDS['claude-code'].hosts.map((x) => [`net:${x}`, 'connect'])]) await h.call('grant.add', { identity: RUNNER, resource, permission });
  await h.call('identity.activate', { id: RUNNER });
  const prompt = `If a skill named ${installed.name} is available to you, use it and reply with SKILL-SEEN followed by the exact text of the first Markdown heading in its SKILL.md. If no such skill is available, reply with NO-SKILL only. Do not search the disk for it.`;
  let runs = 0;
  const ask = async () => {
    const id = `skill-check-${++runs}`;
    await h.call('standing.create', { id, identity: RUNNER, workspace: h.ws, prompt, maxMinutes: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const run = await new Promise((resolve) => {
      const p = spawn(process.execPath, [HARNESS, 'run', '--grant', id], { env: { ...process.env, HOUSTON_CORE_DATA: h.data }, windowsHide: true });
      let out = '';
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { out += c; });
      p.on('exit', (code) => resolve({ code, out }));
    });
    const start = (await h.call('audit.query', { type: 'session.start', limit: 50 })).events.find((/** @type {any} */ e) => e.standing_grant === id);
    const t = start ? await h.call('transcript.get', { id: start.session_id }).catch(() => ({ text: '' })) : { text: '' };
    return { text: String(t.text || run.out).trim(), skills: start?.launch?.skills ?? null, code: run.code };
  };
  const without = await ask();
  console.log(`without the grant (exit ${without.code}): mounted ${JSON.stringify(without.skills)}; replied ${JSON.stringify(without.text.slice(-200))}`);
  await h.call('grant.add', { identity: RUNNER, resource: `skill:${installed.name}`, permission: 'use' });
  const withIt = await ask();
  console.log(`with skill:${installed.name} use: mounted ${JSON.stringify(withIt.skills)}; replied ${JSON.stringify(withIt.text.slice(-300))}`);

  pass = !/SKILL-SEEN/.test(without.text) && withIt.skills?.mounted?.includes(installed.name) && withIt.text.includes('SKILL-SEEN') && heading.length > 0 && withIt.text.includes(heading);
} finally {
  if (installed) await h.call('skill.remove', { name: installed.name }).catch(() => {});
  await h.close();
  if (installed) { const link = path.join(home, 'skills', installed.name); try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* none */ } }
  for (const d of [h.root, h.data]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(pass ? '\nPASS' : '\nFAIL');
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(pass ? 0 : 1);
