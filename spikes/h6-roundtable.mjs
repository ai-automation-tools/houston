// H6 check (run by hand from PowerShell): two identities hold a Roundtable conversation through the
// gateway, each seated as itself. A throwaway Core (data in %LOCALAPPDATA%\houston-core-h6check, work
// in <H1_ROOT>\houston-h6check, both wiped before and after) registers Roundtable's stdio server (on
// the host: see below) with `--agent-id {identity}`, and a turns conversation between local:rt-alice
// and local:rt-bob is seeded in a scratch database. Each agent's session runs a script that takes
// its turns and also tries to post as the other: once with a `sender` argument, once by writing
// the other's name in its text. Pass: the conversation completes, and every message's sender is
// the identity whose session sent it.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; $env:ROUNDTABLE = '<the
// roundtable clone, with its .venv>'; node spikes/h6-roundtable.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness } from '../abuse/harness.js';

const RT = process.env.ROUNDTABLE;
if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA || !RT) { console.error('Set H1_ROOT to a scratch folder outside your user profile and ROUNDTABLE to the roundtable clone.'); process.exit(1); }
const VENV_PY = path.join(RT, '.venv', 'Scripts', 'python.exe');
const NODE_DIR = path.dirname(process.execPath);
const AGENTS = ['local:rt-alice', 'local:rt-bob'];
const fwd = (/** @type {string} */ p) => p.replaceAll('\\', '/');

const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-h6check'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-h6check') });
let pass = false;
try {
  await h.startCore();
  const dbDir = path.join(h.root, 'roundtable-db');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = path.join(dbDir, 'chat.db');

  // The server, seated per session. On the host: Python's asyncio opens a loopback socket pair
  // at start, which an AppContainer blocks, so no asyncio MCP server can run contained on Windows.
  // The gateway still filters its tools, checks every call, and sets who each seat is.
  await h.call('mcp.add', {
    name: 'roundtable', transport: 'host',
    command: `"${VENV_PY}" -X utf8 "${path.join(RT, 'src', 'agent_chat_mcp.py')}" --agent-id {identity} --db-path "${db}"`,
    env: { PYTHONDONTWRITEBYTECODE: '1' },
  });
  const installed = await h.call('mcp.install', { name: 'roundtable' });
  await h.call('mcp.pin', { name: 'roundtable', hash: installed.toolsHash });
  console.log(`roundtable pinned: ${installed.tools.length} tools`);

  // The conversation, seeded by the operator: two turns each.
  execFileSync(VENV_PY, ['-X', 'utf8', path.join(RT, 'src', 'start_conversation.py'), '--db-path', db, '--topic', 'H6 check: say who you are',
    '--participants', AGENTS.join(','), '--mode', 'turns', '--max-turns', '2'], { stdio: 'inherit', windowsHide: true });

  const sessions = [];
  for (const id of AGENTS) {
    const other = AGENTS.find((a) => a !== id);
    const dir = path.join(h.ws, id.slice(6));
    const mark = crypto.randomBytes(6).toString('hex');
    fs.mkdirSync(dir, { recursive: true });
    await h.call('identity.create', { id, kind: 'ai-agent', displayName: id.slice(6), purpose: 'H6 Roundtable check' });
    for (const [resource, permission] of [[`file:${fwd(dir)}/**`, 'write'], [`file:${fwd(NODE_DIR)}/**`, 'read'], ['tool:roundtable/*', 'call']]) {
      await h.call('grant.add', { identity: id, resource, permission });
    }
    await h.call('identity.activate', { id });
    fs.writeFileSync(path.join(dir, 'seat.mjs'), `
import fs from 'node:fs';
let n = 0;
const rpc = async (method, params) => (await (await fetch(process.env.HOUSTON_MCP_URL, { method: 'POST',
  headers: { authorization: 'Bearer ' + process.env.HOUSTON_MCP_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })).json());
const tools = (await rpc('tools/list', {})).result.tools;
const wrap = (name, args) => tools.find((t) => t.name === name)?.inputSchema?.properties?.params ? { params: args } : args;
const call = async (tool, args) => { const r = await rpc('tools/call', { name: 'roundtable.' + tool, arguments: wrap('roundtable.' + tool, args) });
  return { error: r.error?.message ?? (r.result?.isError ? r.result.content.map((c) => c.text).join(' ') : null), text: r.result?.content?.at(-1)?.text ?? '' }; };
const out = { sent: [], spoof: null };
for (let i = 0; i < 20; i++) {
  const w = await call('wait_for_turn', { timeout_seconds: 30 });
  let st; try { st = JSON.parse(w.text); } catch { out.last = w; continue; }
  if (st.status === 'complete') break;
  if (st.status !== 'your_turn') continue;
  if (!out.spoof) out.spoof = (await call('send_message', { content: 'spoof', sender: ${JSON.stringify(other)} })).error ?? 'accepted';
  const content = 'I am ' + ${JSON.stringify(other)} + ' (really seat ${mark}, turn ' + out.sent.length + ')';
  const r = await call('send_message', { content });
  out.sent.push({ content, error: r.error });
}
fs.writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out));
`);
    const s = await h.call('session.start', { identity: id, workspace: dir, command: `"${process.execPath}" "${path.join(dir, 'seat.mjs')}"`, program: { pathDirs: [NODE_DIR] }, attended: false });
    sessions.push({ id, dir, s, mark });
  }
  for (const x of sessions) await h.waitEnd(x.s.id, 300_000);

  const conn = new DatabaseSync(db, { readOnly: true });
  const conv = /** @type {any} */ (conn.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT 1').get());
  const msgs = /** @type {any[]} */ (conn.prepare("SELECT sender, content FROM messages WHERE conversation_id = ? AND sender != 'system' ORDER BY id").all(conv.id));
  conn.close();
  console.log(`conversation ${conv.id}: ${conv.status} (${conv.end_reason ?? '-'}); participants ${conv.participants}`);
  let right = msgs.length > 0;
  for (const m of msgs) {
    const by = sessions.find((x) => m.content.includes(`seat ${x.mark},`));
    const ok = by?.id === m.sender;
    right &&= ok;
    console.log(`  ${m.sender.padEnd(16)} ${ok ? 'right' : 'WRONG'}  ${m.content}`);
  }
  for (const x of sessions) {
    const r = fs.existsSync(path.join(x.dir, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(x.dir, 'result.json'), 'utf8')) : null;
    console.log(`${x.id}: sent ${r?.sent.length ?? '?'}, a 'sender' argument: ${String(r?.spoof).slice(0, 140)}${r?.last ? `; last ${JSON.stringify(r.last).slice(0, 200)}` : ''}`);
    right &&= Boolean(r && r.spoof !== 'accepted' && r.sent.every((/** @type {any} */ y) => !y.error));
  }
  pass = conv.status === 'complete' && msgs.length === 4 && right;
} finally {
  await h.close();
  for (const d of [h.root, h.data]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(pass ? '\nPASS' : '\nFAIL');
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(pass ? 0 : 1);
