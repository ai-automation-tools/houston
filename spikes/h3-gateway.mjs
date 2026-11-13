// H3 check (run by hand from PowerShell): the gateway in real containers. An agent session
// calls the gateway from inside its container, both through its proxy (Node's fetch with
// NODE_USE_ENV_PROXY) and straight at the port; the gateway starts a stdio MCP server in a
// container of its own, as its own identity, with a vault secret in its environment.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h3-gateway.mjs
// It works in a houston-gateway-check subfolder there, wiped first. No internet needed.
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

if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-gateway-check');
fs.rmSync(ROOT, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws');
const SRV = path.join(ROOT, 'server');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(SRV, { recursive: true });
fs.copyFileSync(new URL('../tests/core/stub-mcp-server.js', import.meta.url), path.join(SRV, 'stub.js'));
const NODE_DIR = 'C:\\Program Files\\nodejs';
const SECRET = `ghp_${crypto.randomBytes(18).toString('base64url')}`;

// What the agent runs inside its container.
fs.writeFileSync(path.join(WS, 'call.mjs'), `
import http from 'node:http';
import { createHash } from 'node:crypto';
const url = process.env.HOUSTON_MCP_URL, token = process.env.HOUSTON_MCP_TOKEN;
let n = 0;
const rpc = async (method, params = {}) => (await (await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })).json());
const text = (r) => (r.result?.content ?? []).map((c) => c.text).join(' | ');
console.log('gateway vars: url ' + (url ? 'set' : 'MISSING') + ', token ' + (token ? 'set' : 'MISSING'));
console.log('init (via proxy): ' + (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })).result?.serverInfo?.name);
console.log('tools: ' + (await rpc('tools/list')).result.tools.map((t) => t.name).join(', '));
console.log('echo: ' + text(await rpc('tools/call', { name: 'stub.echo', arguments: { text: 'hello from the container' } })));
console.log('env GITHUB_TOKEN via the server: ' + text(await rpc('tools/call', { name: 'stub.env', arguments: { name: 'GITHUB_TOKEN' } })));
console.log('big (not granted): ' + text(await rpc('tools/call', { name: 'stub.big', arguments: { bytes: 3 } })));
console.log('my own env has the vault value: ' + Object.values(process.env).some((v) => createHash('sha256').update(v).digest('hex') === process.argv[2]));
const direct = await new Promise((resolve) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(res.statusCode + ' ' + b.slice(0, 60))); });
  req.on('error', (e) => resolve('error ' + e.code));
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }));
});
console.log('ping straight at the port: ' + direct);
console.log('wrong token: ' + (await fetch(url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status);
`);

const home = os.homedir();
const anon = (s) => String(s).replaceAll(home, '%USERPROFILE%').replaceAll(ROOT, '<root>').replaceAll(SECRET, '<THE SECRET>');
const core = start(path.join(ROOT, 'core'));
const registry = createRegistry({ db: core.db, audit: core.audit });
const vault = await openVault({ db: core.db, dir: core.dir, audit: core.audit });
const approvals = createApprovals({ audit: core.audit });
const where = { coreDir: core.dir, tempRoot: path.join(ROOT, 'sessions'), agentsRoot: path.join(ROOT, 'agents') };
const gateway = createGateway({ db: core.db, audit: core.audit, vault, registry, approvals, ...where });
const runner = createRunner({ db: core.db, audit: core.audit, ...where, approvals, gateway });

vault.set('github-token', SECRET);
gateway.add({ name: 'stub', command: `"${NODE_DIR}\\node.exe" "${path.join(SRV, 'stub.js')}"`, env: { GITHUB_TOKEN: 'secret:github-token' }, pathDirs: [NODE_DIR] });
for (const [resource, permission] of [[`file:${SRV.replaceAll('\\', '/')}/**`, 'read'], ['secret:github-token', 'use']]) {
  registry.addGrant({ identity: 'local:mcp/stub', resource, permission }, OPERATOR);
}
const t0 = Date.now();
const installed = await gateway.install('stub');
console.log(`install: ${installed.state}, ${installed.tools.length} tools, ${Date.now() - t0} ms`);
gateway.pin('stub', installed.toolsHash);

registry.create({ id: 'local:dev-shell', kind: 'ai-agent', displayName: 'Dev shell' }, OPERATOR);
for (const [resource, permission] of [
  [`file:${WS.replaceAll('\\', '/')}/**`, 'write'], [`file:${NODE_DIR.replaceAll('\\', '/')}/**`, 'read'], ['tool:stub/echo', 'call'], ['tool:stub/env', 'call'],
]) registry.addGrant({ identity: 'local:dev-shell', resource, permission }, OPERATOR);
registry.setStatus('local:dev-shell', 'active', OPERATOR);

const session = await runner.start({
  identity: 'local:dev-shell', workspace: WS, command: `"${NODE_DIR}\\node.exe" call.mjs ${crypto.createHash('sha256').update(SECRET).digest('hex')}`,
  program: { pathDirs: [NODE_DIR] }, size: { rows: 30, columns: 160 },
});
let out = '';
session.output.on('data', (c) => { out += c.toString('utf8'); });
const end = await Promise.race([session.done, new Promise((r) => setTimeout(() => r({ reason: 'timeout' }), 90_000).unref())]);
if (end.reason === 'timeout') await session.stop();
core.close();

// eslint-disable-next-line no-control-regex
const plain = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
console.log('--- agent terminal ---');
console.log(anon(plain.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n')));
console.log(`--- end: ${end.reason} ---`);
console.log('--- audit ---');
const log = fs.readFileSync(path.join(ROOT, 'core', 'audit', 'audit-000001.jsonl'), 'utf8');
console.log(`the secret's value in the audit log: ${log.includes(SECRET)}`);
for (const e of log.trim().split('\n').map((l) => JSON.parse(l)).filter((x) => /^(mcp|credential|gateway|session)\./.test(x.type))) {
  console.log(`${e.audit.seq} ${e.type} ${e.identity.subject} ${e.decision.result} ${e.resource.id === session.id ? '<session>' : e.resource.id} ${anon(e.decision.reasons?.[0] ?? '')}${e.launch ? ` network=${JSON.stringify(e.launch.network)}` : ''}`);
}
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(0);
