// What AT-06 to AT-08 share: the stub MCP server registered with the real Core as
// `abuse-stub`, holding a vault secret, installed and pinned the way the operator would; and
// an agent identity, `local:abuse-tools`, that may call its `echo` tool, `env` only on an ask
// card, and nothing else. Each attack is a Node script run in that agent's real container,
// which writes what it saw to a JSON file the test reads from the host.
//
// The secret is random per run. It goes to the Core over the Control API and is never given
// to an agent script, printed or written to the results.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_AGENT = 'local:abuse-tools';
export const SERVER = 'abuse-stub';
const STUB = fileURLToPath(new URL('../../tests/core/stub-mcp-server.js', import.meta.url));
const NODE_DIR = path.dirname(process.execPath);

/** @type {WeakMap<object, Promise<{ secret: string, serverDir: string, hash: string }>>} */
const READY = new WeakMap();

/**
 * Set up once per harness.
 * @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h
 */
export function gateway(h) {
  if (!READY.has(h)) READY.set(h, (async () => {
    const serverDir = path.join(h.root, 'mcp-stub');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.copyFileSync(STUB, path.join(serverDir, 'stub.js'));
    const secret = `ghp_${crypto.randomBytes(24).toString('base64url')}`;
    await h.call('secret.set', { name: 'abuse-token', value: secret });
    await h.call('mcp.add', { name: SERVER, command: `"${process.execPath}" "${path.join(serverDir, 'stub.js')}"`, env: { GITHUB_TOKEN: 'secret:abuse-token' }, pathDirs: [NODE_DIR] });
    for (const [resource, permission] of [[`file:${serverDir.replaceAll('\\', '/')}/**`, 'read'], ['secret:abuse-token', 'use']]) {
      await h.call('grant.add', { identity: `local:mcp/${SERVER}`, resource, permission });
    }
    const installed = await h.call('mcp.install', { name: SERVER });
    await h.call('mcp.pin', { name: SERVER, hash: installed.toolsHash });

    await h.call('identity.create', { id: TOOLS_AGENT, kind: 'ai-agent', displayName: 'Abuse suite tool user', purpose: 'Calls the gateway in the abuse tests' });
    for (const [resource, permission, effect] of [
      [`file:${h.ws.replaceAll('\\', '/')}/**`, 'write', 'allow'], [`file:${NODE_DIR.replaceAll('\\', '/')}/**`, 'read', 'allow'],
      [`tool:${SERVER}/echo`, 'call', 'allow'], [`tool:${SERVER}/env`, 'call', 'ask'],
    ]) await h.call('grant.add', { identity: TOOLS_AGENT, resource, permission, effect });
    await h.call('identity.activate', { id: TOOLS_AGENT });
    return { secret, serverDir, hash: installed.toolsHash };
  })());
  return /** @type {Promise<{ secret: string, serverDir: string, hash: string }>} */ (READY.get(h));
}

/**
 * The script prelude every attack starts with: an MCP client for the session's gateway.
 * `rpc(method, params, { url, token, id })` posts one JSON-RPC request and resolves
 * `{ status, body }`, or `{ status: 0, error }` when the request never got an answer.
 */
const PRELUDE = `
import fs from 'node:fs';
import http from 'node:http';
const URL_ = process.env.HOUSTON_MCP_URL, TOKEN = process.env.HOUSTON_MCP_TOKEN;
let n = 0;
async function rpc(method, params = {}, o = {}) {
  try {
    const r = await fetch(o.url ?? URL_, { method: 'POST', signal: AbortSignal.timeout(o.timeoutMs ?? 150000),
      headers: { authorization: 'Bearer ' + (o.token ?? TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: o.id ?? ++n, method, params }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, error: String(e.cause?.code ?? e.message) }; }
}
const text = (r) => (r.body?.result?.content ?? []).map((c) => c.text).join(' | ') || JSON.stringify(r.body ?? r.error);
const out = {};
const save = () => fs.writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out));
`;

/**
 * Start `body` as a Node script in its own folder, as the tool agent, in a real container.
 * @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h
 * @param {string} name @param {string} body
 * @returns {Promise<{ session: string, dir: string }>}
 */
export async function startAgent(h, name, body) {
  const dir = path.join(h.ws, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'attack.mjs'), `${PRELUDE}\n${body}\nsave();\n`);
  const s = await h.call('session.start', {
    identity: TOOLS_AGENT, workspace: h.ws, command: `"${process.execPath}" "${path.join(dir, 'attack.mjs')}"`, program: { pathDirs: [NODE_DIR] },
  });
  return { session: s.id, dir };
}

/** What a script saved. @param {string} dir */
export const readResult = (dir) => {
  const f = path.join(dir, 'result.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
