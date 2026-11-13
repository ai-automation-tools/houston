// H3 check (run by hand from PowerShell): the gateway's host and http transports, called by an
// agent in a real container. Cronsole's own MCP server runs on the host (it calls Cronsole's API
// on loopback, which a container can't reach) with CRONSOLE_TOKEN from the vault and nothing
// else of this shell's environment; an http server built from src/shared/mcp.js, the code the
// app's own server runs, stands in for the app, its token in the vault too.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'
//        $env:ACC_CRONSOLE_MCP = '<cronsole>/mcp-server/dist/index.js'   (CRONSOLE_TOKEN set, Cronsole's API running)
//        node spikes/h3-host-servers.mjs
// It works in a houston-host-check subfolder there, wiped before and after.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovals } from '../core/approvals.js';
import { createGateway } from '../core/gateway.js';
import { OPERATOR, createRegistry } from '../core/identities.js';
import { start } from '../core/main.js';
import { createRunner } from '../core/runner.js';
import { openVault } from '../core/vault.js';
import { createMcpServer } from '../src/shared/mcp.js';

for (const v of ['H1_ROOT', 'ACC_CRONSOLE_MCP', 'CRONSOLE_TOKEN']) if (!process.env[v]) { console.error(`Set ${v} (see the header).`); process.exit(1); }
const ROOT = path.join(/** @type {string} */ (process.env.H1_ROOT), 'houston-host-check');
fs.rmSync(ROOT, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(WS, { recursive: true });
const NODE_DIR = 'C:\\Program Files\\nodejs';
const APP_TOKEN = crypto.randomBytes(32).toString('hex');
const CRONSOLE_TOKEN = /** @type {string} */ (process.env.CRONSOLE_TOKEN);

// The stand-in app server: one tool, which also says whether it saw a client it knows.
const app = createMcpServer({ token: APP_TOKEN, version: 'check', tools: new Map([['list_tabs', { description: 'The open tabs.', inputSchema: { type: 'object' }, run: () => ({ tabs: ['stand-in tab'] }) }]]) });
await new Promise((r) => app.listen(0, '127.0.0.1', () => r(undefined)));
const APP_URL = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (app.address()).port}/mcp`;

// What the agent runs inside its container.
fs.writeFileSync(path.join(WS, 'call.mjs'), `
const url = process.env.HOUSTON_MCP_URL, token = process.env.HOUSTON_MCP_TOKEN;
let n = 0;
const rpc = async (method, params = {}) => (await (await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })).json());
const text = (r) => (r.result?.content ?? []).slice(1).map((c) => c.text).join(' | ');
console.log('tools: ' + (await rpc('tools/list')).result.tools.map((t) => t.name).join(', '));
const tasks = text(await rpc('tools/call', { name: 'cronsole.list_tasks', arguments: {} }));
console.log('cronsole.list_tasks: ' + tasks.length + ' chars, starts ' + JSON.stringify(tasks.slice(0, 60)));
console.log('cronsole.run_task (not granted): ' + (await rpc('tools/call', { name: 'cronsole.run_task', arguments: { taskId: 'x' } })).result.content[0].text.slice(0, 80));
console.log('houston.list_tabs: ' + text(await rpc('tools/call', { name: 'houston.list_tabs', arguments: {} })));
console.log('the app straight, from the container: ' + await fetch(process.argv[2], { method: 'POST', body: '{}' }).then((r) => 'HTTP ' + r.status, (e) => 'refused (' + (e.cause?.code || e.cause?.message || e.message) + ')'));
`);

const home = os.homedir();
const anon = (/** @type {unknown} */ s) => String(s).replaceAll(home, '%USERPROFILE%').replaceAll(ROOT, '<root>').replaceAll(CRONSOLE_TOKEN, '<CRONSOLE_TOKEN>').replaceAll(APP_TOKEN, '<APP_TOKEN>');
const core = start(path.join(ROOT, 'core'));
const registry = createRegistry({ db: core.db, audit: core.audit });
const vault = await openVault({ db: core.db, dir: core.dir, audit: core.audit });
const approvals = createApprovals({ audit: core.audit });
const where = { coreDir: core.dir, tempRoot: path.join(ROOT, 'sessions'), agentsRoot: path.join(ROOT, 'agents') };
const gateway = createGateway({ db: core.db, audit: core.audit, vault, registry, approvals, ...where });
const runner = createRunner({ db: core.db, audit: core.audit, ...where, approvals, gateway });

/** Processes running this Cronsole server; other apps (an MCP client) may run their own. */
const cronsoleServers = () => execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(path.dirname(path.dirname(/** @type {string} */ (process.env.ACC_CRONSOLE_MCP))))}*dist*index.js*' } | Measure-Object).Count"`).toString().trim();
const before = cronsoleServers();

try {
  vault.set('cronsole-token', CRONSOLE_TOKEN);
  vault.set('houston-mcp', APP_TOKEN);
  gateway.add({ name: 'cronsole', transport: 'host', command: `"${NODE_DIR}\\node.exe" "${process.env.ACC_CRONSOLE_MCP}"`, env: { CRONSOLE_TOKEN: 'secret:cronsole-token' }, pathDirs: [NODE_DIR] });
  gateway.add({ name: 'houston', transport: 'http', url: APP_URL, env: { Authorization: 'Bearer secret:houston-mcp' } });
  for (const name of ['cronsole', 'houston']) {
    registry.addGrant({ identity: `local:mcp/${name}`, resource: `secret:${name === 'houston' ? 'houston-mcp' : 'cronsole-token'}`, permission: 'use' }, OPERATOR);
    const t0 = Date.now();
    const s = await gateway.install(name);
    console.log(`install ${name} (${s.transport}): ${s.state}, ${s.tools.length} tools, ${Date.now() - t0} ms`);
    gateway.pin(name, s.toolsHash);
  }

  registry.create({ id: 'local:dev-shell', kind: 'ai-agent', displayName: 'Dev shell' }, OPERATOR);
  for (const [resource, permission] of [
    [`file:${WS.replaceAll('\\', '/')}/**`, 'write'], [`file:${NODE_DIR.replaceAll('\\', '/')}/**`, 'read'], ['tool:cronsole/list_tasks', 'call'], ['tool:houston/list_tabs', 'call'],
  ]) registry.addGrant({ identity: 'local:dev-shell', resource, permission }, OPERATOR);
  registry.setStatus('local:dev-shell', 'active', OPERATOR);

  const session = await runner.start({
    identity: 'local:dev-shell', workspace: WS, command: `"${NODE_DIR}\\node.exe" call.mjs ${APP_URL}`,
    program: { pathDirs: [NODE_DIR] }, size: { rows: 30, columns: 200 },
  });
  let out = '';
  session.output.on('data', (c) => { out += c.toString('utf8'); });
  const end = await Promise.race([session.done, new Promise((r) => setTimeout(() => r({ reason: 'timeout' }), 120_000).unref())]);
  if (/** @type {any} */ (end).reason === 'timeout') await session.stop();

  // eslint-disable-next-line no-control-regex
  const plain = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  console.log('--- agent terminal ---');
  console.log(anon(plain.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n')));
  console.log(`--- end: ${/** @type {any} */ (end).reason} ---`);
  const log = fs.readFileSync(path.join(ROOT, 'core', 'audit', 'audit-000001.jsonl'), 'utf8');
  console.log(`a token's value in the audit log: ${log.includes(CRONSOLE_TOKEN) || log.includes(APP_TOKEN)}`);
  console.log(`a token's value in the transcript: ${out.includes(CRONSOLE_TOKEN) || out.includes(APP_TOKEN)}`);
  for (const e of log.trim().split('\n').map((l) => JSON.parse(l)).filter((x) => /^(mcp\.(tool_call|list_tools)|credential)/.test(x.type))) {
    console.log(`${e.audit.seq} ${e.type} ${e.identity.subject} (${e.identity.containment}) ${e.decision.result} ${e.resource.id} ${anon(e.decision.reasons?.[0] ?? '')}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`Cronsole servers running before the check: ${before}, after the session: ${cronsoleServers()}`);
} finally {
  core.close();
  app.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(0);
