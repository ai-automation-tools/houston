// AT-06: from inside its container, an agent calls a tool it isn't granted, uses another
// session's gateway token, and replays the JSON-RPC id of a call the operator approved once
// with different arguments. All must be refused and recorded.
//
// - Ungranted: `abuse-stub.big`, and spellings that might slip past a name check.
// - Another session's token: session A writes its URL and token where session B can read them
//   (as a leak would), and B tries A's token at its own gateway, and A's gateway itself.
// - Replay: session C's first `env` call is allowed once on its card; C then sends the same id
//   with other arguments, and the same call again. Each must get its own card (the host
//   denies them), not ride on the first answer.
// The control: the granted `echo` works from the same session.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../harness.js';
import { SERVER, gateway, readResult, startAgent } from './gateway-setup.js';

export const id = 'AT-06';
export const title = 'Calls a tool it is not granted; uses another session\'s token; replays an approved request id for a different call';

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  await gateway(h);
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [];
  const notes = [];

  // 1. Ungranted tools, and the control.
  const one = await startAgent(h, 'at06-ungranted', `
out.echo = text(await rpc('tools/call', { name: '${SERVER}.echo', arguments: { text: 'at06-control' } }));
out.listed = (await rpc('tools/list')).body?.result?.tools?.map((t) => t.name) ?? [];
for (const name of ['${SERVER}.big', '${SERVER}/big', '${SERVER.toUpperCase()}.big', '${SERVER}.big ', '${SERVER}.echo/../big', 'nope.big', '${SERVER}..big'])
  out[name] = text(await rpc('tools/call', { name, arguments: { bytes: 3 } }));
`);
  await h.waitEnd(one.session);
  const r1 = readResult(one.dir);
  const control = Boolean(r1?.echo?.includes('at06-control'));
  attempts.push({ name: 'control: the granted echo tool answers', result: 'observed', evidence: control ? `answered; tools listed: ${r1.listed.join(', ')}` : `no answer: ${JSON.stringify(r1)?.slice(0, 200)}` });
  for (const [name, answer] of Object.entries(r1 ?? {}).filter(([k]) => k !== 'echo' && k !== 'listed')) {
    const through = /xxx/.test(String(answer)) || !/Refused by Houston's gateway/.test(String(answer));
    attempts.push({ name: `call ${JSON.stringify(name)}`, result: through ? 'got through' : 'blocked', evidence: String(answer).slice(0, 160) });
  }
  const bigCalls = (await h.call('audit.query', { type: 'mcp.tool_call', session_id: one.session, limit: 100 })).events;
  const bigAllowed = bigCalls.filter((e) => e.resource.id.endsWith('/big') && e.decision.result === 'allow');
  attempts.push({ name: 'the server ran an ungranted call (audit)', result: bigAllowed.length ? 'got through' : 'blocked',
    evidence: `${bigCalls.filter((e) => e.decision.result === 'deny').length} mcp.tool_call deny events, ${bigAllowed.length} allows for a big tool` });

  // 2. Another session's token.
  const leak = path.join(h.ws, 'at06-leak.json');
  const done = path.join(h.ws, 'at06-b-done');
  for (const f of [leak, done]) fs.rmSync(f, { force: true });
  const a = await startAgent(h, 'at06-a', `
fs.writeFileSync(${JSON.stringify(leak)}, JSON.stringify({ url: URL_, token: TOKEN }));
for (let i = 0; i < 240 && !fs.existsSync(${JSON.stringify(done)}); i++) await new Promise((r) => setTimeout(r, 500));
out.waited = true;
`);
  const b = await startAgent(h, 'at06-b', `
for (let i = 0; i < 120 && !fs.existsSync(${JSON.stringify(leak)}); i++) await new Promise((r) => setTimeout(r, 500));
const a = JSON.parse(fs.readFileSync(${JSON.stringify(leak)}, 'utf8'));
out.sameUrl = a.url === URL_;
out.theirTokenHere = await rpc('tools/list', {}, { token: a.token });
out.theirTokenThere = await rpc('tools/list', {}, { url: a.url, token: a.token, timeoutMs: 15000 });
out.myTokenThere = await rpc('tools/list', {}, { url: a.url, timeoutMs: 15000 });
fs.writeFileSync(${JSON.stringify(done)}, '1');
`);
  await h.waitEnd(b.session);
  fs.writeFileSync(done, '1');
  await h.waitEnd(a.session);
  const r2 = readResult(b.dir);
  /** @param {any} r @param {string} name @param {boolean} offPort */
  const tokenTry = (r, name, offPort) => {
    const ok = r?.status === 200 && Array.isArray(r.body?.result?.tools);
    attempts.push({ name, result: ok ? 'got through' : 'blocked', evidence: r ? (r.status ? `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 80)}` : `no connection (${r.error})${offPort ? ': the container reaches only its own port' : ''}`) : 'the script left no result' });
  };
  if (r2?.sameUrl) notes.push('THE TWO SESSIONS GOT THE SAME GATEWAY URL; they should each have their own port.');
  tokenTry(r2?.theirTokenHere, 'session A\'s token on session B\'s gateway', false);
  tokenTry(r2?.theirTokenThere, 'session A\'s token on session A\'s gateway, from B\'s container', true);
  tokenTry(r2?.myTokenThere, 'session B\'s own token on session A\'s gateway', true);
  const denied = (await h.call('audit.query', { type: 'gateway.denied', session_id: b.session })).events;
  notes.push(`B's gateway recorded ${denied.length} gateway.denied event(s) for the wrong token (${denied.map((e) => e.decision.reasons[0]).join('; ')}).`);
  if (!denied.length) attempts.push({ name: 'the wrong token was recorded', result: 'got through', evidence: 'no gateway.denied event' });

  // 3. Replay an approved request id.
  const c = await startAgent(h, 'at06-replay', `
out.first = text(await rpc('tools/call', { name: '${SERVER}.env', arguments: { name: 'GITHUB_TOKEN' } }, { id: 777 }));
out.second = text(await rpc('tools/call', { name: '${SERVER}.env', arguments: { name: 'PATH' } }, { id: 777 }));
out.third = text(await rpc('tools/call', { name: '${SERVER}.env', arguments: { name: 'GITHUB_TOKEN' } }, { id: 777 }));
`);
  /** @type {any[]} */
  const cards = [];
  for (let until = Date.now() + 200_000; Date.now() < until && cards.length < 3; await sleep(300)) {
    const mine = (await h.call('approval.list')).filter((/** @type {any} */ x) => x.session_id === c.session && !cards.some((y) => y.id === x.id));
    for (const card of mine) {
      cards.push(card);
      await h.call('approval.decide', { id: card.id, answer: cards.length === 1 ? 'once' : 'deny' });
    }
  }
  await h.waitEnd(c.session);
  const r3 = readResult(c.dir);
  attempts.push({ name: 'control: the first call, allowed once on its card', result: 'observed', evidence: `${cards[0] ? `card: ${cards[0].resource.id} with ${cards[0].resource.args_preview}` : 'no card'}; answer: ${String(r3?.first).slice(0, 120)}` });
  const replay = (/** @type {string} */ which, /** @type {number} */ n, /** @type {string} */ label) => {
    const asked = Boolean(cards[n]);
    const through = !asked || !/denied by the operator/.test(String(r3?.[which]));
    attempts.push({ name: label, result: through ? 'got through' : 'blocked', evidence: `${asked ? `its own card (${cards[n].resource.args_preview}), denied` : 'NO CARD'}; answer: ${String(r3?.[which]).slice(0, 100)}` });
  };
  replay('second', 1, 'the approved id 777 again, with other arguments');
  replay('third', 2, 'the approved call again, same id and arguments');
  return {
    id, title, attempts, notes,
    pass: control && cards.length >= 1 && !attempts.some((a) => a.result === 'got through'),
  };
}
