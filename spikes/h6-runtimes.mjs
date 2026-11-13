// H6 check (run by hand from PowerShell): a local model runtime used from a container. Needs one
// running (Ollama, LM Studio, ...). A throwaway Core (data in %LOCALAPPDATA%\houston-core-h6runtimes,
// work in <H1_ROOT>\houston-h6runtimes, both wiped) lists the runtimes answering (runtime.list), then:
//   a contained session started with { runtime, model } asks the model through its relay
//   (HOUSTON_RUNTIME_URL, its token as the key): it answers
//   the same session tries the runtime's own port on 127.0.0.1, and the relay without its token: both refused
//   without a net:127.0.0.1:<port> grant the start is refused, and so is a backend whose API the runtime doesn't serve
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h6-runtimes.mjs [runtime-id [model]]
import fs from 'node:fs';
import path from 'node:path';
import { createHarness } from '../abuse/harness.js';

if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const NODE_DIR = path.dirname(process.execPath);
const fwd = (/** @type {string} */ p) => p.replaceAll('\\', '/');
const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-h6runtimes'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-h6runtimes') });
let pass = false;
try {
  await h.startCore();
  const found = await h.call('runtime.list');
  for (const r of found) console.log(`found ${r.name} on ${r.port}: ${r.models.length} models; APIs ${Object.entries(r.apis).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  const rt = found.find((/** @type {any} */ r) => r.id === (process.argv[2] ?? r.id));
  if (!rt) throw new Error('no local runtime is answering');
  const model = process.argv[3] ?? rt.models.find((/** @type {string} */ m) => /llama3\.2|qwen|tiny|1b|3b|4b/i.test(m)) ?? rt.models[0];

  const ID = 'local:h6-local';
  const dir = path.join(h.ws, 'local');
  fs.mkdirSync(dir, { recursive: true });
  await h.call('identity.create', { id: ID, kind: 'ai-agent', displayName: 'H6 local model user' });
  for (const [resource, permission] of [[`file:${fwd(dir)}/**`, 'write'], [`file:${fwd(NODE_DIR)}/**`, 'read']]) await h.call('grant.add', { identity: ID, resource, permission });
  await h.call('identity.activate', { id: ID });
  const start = () => h.call('session.start', { identity: ID, workspace: dir, command: `"${process.execPath}" "${path.join(dir, 'ask.mjs')}"`, program: { pathDirs: [NODE_DIR] }, runtime: rt.id, model });
  const noGrant = await start().then(() => 'started (wrong)', (e) => `refused: ${e.message}`);
  console.log(`without a net:127.0.0.1:${rt.port} grant: ${noGrant}`);
  await h.call('grant.add', { identity: ID, resource: `net:127.0.0.1:${rt.port}`, permission: 'connect' });

  fs.writeFileSync(path.join(dir, 'ask.mjs'), `
import fs from 'node:fs';
const out = { url: process.env.HOUSTON_RUNTIME_URL, model: process.env.HOUSTON_RUNTIME_MODEL };
const ask = async (url, key) => { try {
  const r = await fetch(url + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(170000),
    headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ model: out.model, messages: [{ role: 'user', content: 'Reply with the single word PONG and nothing else.' }], stream: false }) });
  const t = await r.text(); let said = null; try { said = JSON.parse(t).choices[0].message.content; } catch {}
  return { status: r.status, said: said ?? t.slice(0, 200) };
} catch (e) { return { error: String(e.cause?.code ?? e.message) }; } };
out.relayed = await ask(out.url, process.env.HOUSTON_MCP_TOKEN);
out.noToken = await ask(out.url, null);
out.direct = await ask('http://127.0.0.1:${rt.port}/v1', null);
fs.writeFileSync('result.json', JSON.stringify(out));
`);
  const s = await start();
  await h.waitEnd(s.id, 240_000);
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  console.log(`relayed (${model}): ${JSON.stringify(r.relayed)}`);
  console.log(`relay without the token: ${JSON.stringify(r.noToken)}`);
  console.log(`straight at 127.0.0.1:${rt.port}: ${JSON.stringify(r.direct)}`);
  const relayEvents = (await h.call('audit.query', { type: 'egress.connect', session_id: s.id })).events.filter((/** @type {any} */ e) => e.egress?.scheme === 'relay').map((/** @type {any} */ e) => `${e.decision.result} ${e.egress.status}`);
  console.log(`relay events: ${relayEvents.join(', ')}`);

  // A backend whose API this runtime doesn't serve is refused at start, with why.
  let apiCheck = 'skipped (the runtime serves both APIs)';
  const missing = !rt.apis.responses ? 'codex' : !rt.apis.messages ? 'claude-code' : null;
  if (missing) {
    await h.call('identity.create', { id: 'local:h6-cli', kind: 'ai-agent', displayName: 'H6 CLI', backend: missing });
    for (const [resource, permission] of [[`file:${fwd(dir)}/**`, 'write'], [`net:127.0.0.1:${rt.port}`, 'connect']]) await h.call('grant.add', { identity: 'local:h6-cli', resource, permission });
    await h.call('identity.activate', { id: 'local:h6-cli' });
    apiCheck = await h.call('session.start', { identity: 'local:h6-cli', workspace: dir, runtime: rt.id, model }).then(() => 'started (wrong)', (e) => `refused: ${e.message}`);
  }
  console.log(`${missing ?? 'a CLI'} on it: ${apiCheck}`);

  pass = noGrant.startsWith('refused') && r.relayed?.status === 200 && /pong/i.test(r.relayed.said ?? '') && r.noToken?.status === 401 && r.direct?.status !== 200
    && relayEvents.includes('allow 200') && (missing === null || apiCheck.includes('API'));
} finally {
  await h.close();
  for (const d of [h.root, h.data]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(pass ? '\nPASS' : '\nFAIL');
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(pass ? 0 : 1);
