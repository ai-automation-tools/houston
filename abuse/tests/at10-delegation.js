// AT-10: a sub-agent requests a wider scope than its parent. A parent agent, in its real
// container, calls the gateway's harness.delegate and asks for its own folder and more: the
// whole workspace, the C: drive, pastebin.com and a scheduler-style spawn of its own. The child is
// a plain command line in its own container. Pass: the Core grants the intersection only (the
// parent's folder and hosts), the child can write inside that folder and reach the control host,
// and is refused the wider folder and pastebin; the child is a retired sub-agent of the parent
// afterwards, and its session names the parent's.
import fs from 'node:fs';
import path from 'node:path';
import { firstLine, sleep } from '../harness.js';

export const id = 'AT-10';
export const title = 'A sub-agent requests a wider scope than its parent';

const PARENT = 'local:abuse-delegator';
const NODE_DIR = path.dirname(process.execPath);

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const dir = path.join(h.ws, 'at10');
  fs.mkdirSync(dir, { recursive: true });
  const fwd = (/** @type {string} */ p) => p.replaceAll('\\', '/');
  const escape = path.join(h.ws, 'at10-escape.txt');
  await h.call('identity.create', { id: PARENT, kind: 'ai-agent', displayName: 'Abuse suite delegator', purpose: 'Asks for a sub-agent wider than itself' });
  for (const [resource, permission] of [
    [`file:${fwd(dir)}/**`, 'write'], [`file:${fwd(NODE_DIR)}/**`, 'read'], ['session:delegate', 'spawn'],
    ['net:registry.npmjs.org:443', 'connect'], ['net:c.pki.goog:80', 'connect'], ['net:o.pki.goog:80', 'connect'],
  ]) await h.call('grant.add', { identity: PARENT, resource, permission });
  await h.call('identity.activate', { id: PARENT });

  // What the child runs: one write inside its folder, one outside it, the control host and pastebin.
  fs.writeFileSync(path.join(dir, 'child.cmd'), [
    '@echo off', `cd /d "${dir}"`,
    `(echo in-scope> "${path.join(dir, 'child-in.txt')}") 2> in.err`,
    `(echo escaped> "${escape}") 2> out.err`,
    'curl.exe -s -o NUL -w "%%{http_code}" https://registry.npmjs.org/ > npm.code 2> npm.err',
    'curl.exe -s -o NUL -w "%%{http_code}" https://pastebin.com/ > paste.code 2> paste.err',
    'exit /b 0', '',
  ].join('\r\n'));
  const wanted = [
    [`file:${fwd(dir)}/**`, 'write'], [`file:${fwd(h.ws)}/**`, 'write'], ['file:C:/**', 'read'],
    ['net:registry.npmjs.org:443', 'connect'], ['net:c.pki.goog:80', 'connect'], ['net:o.pki.goog:80', 'connect'], ['net:pastebin.com:443', 'connect'],
    ['command:*', 'run'],
  ].map(([resource, permission]) => ({ resource, permission }));

  fs.writeFileSync(path.join(dir, 'parent.mjs'), `
import fs from 'node:fs';
let n = 0;
const rpc = async (method, params) => (await (await fetch(process.env.HOUSTON_MCP_URL, { method: 'POST',
  headers: { authorization: 'Bearer ' + process.env.HOUSTON_MCP_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })).json()).result;
const out = { tools: (await rpc('tools/list', {})).tools.map((t) => t.name) };
const r = await rpc('tools/call', { name: 'harness.delegate', arguments: { task: ${JSON.stringify(`cmd.exe /d /c "${path.join(dir, 'child.cmd')}"`)}, grants: ${JSON.stringify(wanted)}, minutes: 5 } });
out.delegate = JSON.parse(r.content[0].text);
for (let i = 0; i < 240; i++) {
  const st = await rpc('tools/call', { name: 'harness.delegate_status', arguments: { session: out.delegate.session } });
  out.status = JSON.parse(st.content[0].text);
  if (out.status.state === 'ended') break;
  await new Promise((res) => setTimeout(res, 500));
}
fs.writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out));
`);
  const s = await h.call('session.start', { identity: PARENT, workspace: dir, command: `"${process.execPath}" "${path.join(dir, 'parent.mjs')}"`, program: { pathDirs: [NODE_DIR] } });
  await h.waitEnd(s.id, 300_000);
  const resultFile = path.join(dir, 'result.json');
  const r = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  const read = (/** @type {string} */ f) => { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p, 'latin1').trim() : null; };

  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [];
  const granted = (r?.delegate?.granted ?? []).map((/** @type {any} */ g) => `${g.resource} ${g.permission}`);
  const dropped = (r?.delegate?.dropped ?? []).map((/** @type {any} */ g) => `${g.resource} ${g.permission}`);
  const wider = [`file:${fwd(h.ws)}/** write`, 'file:C:/** read', 'net:pastebin.com:443 connect', 'command:* run'];
  attempts.push({
    name: 'ask for the parent\'s folder plus the whole workspace, C:, pastebin and any command', result: wider.some((w) => granted.includes(w)) ? 'got through' : 'blocked',
    evidence: r ? `granted ${granted.length} (${granted.join(', ')}); dropped ${dropped.length}` : 'the parent wrote no result',
  });
  const child = r?.delegate?.identity ? await h.call('identity.get', { id: r.delegate.identity }).catch(() => null) : null;
  const held = (child?.grants ?? []).map((/** @type {any} */ g) => `${g.resource} ${g.permission} ${g.effect}`);
  attempts.push({ name: 'the grants the Core gave the child identity', result: held.some((x) => wider.some((w) => x.startsWith(w))) ? 'got through' : 'blocked', evidence: held.join(', ') || 'none' });
  attempts.push({ name: 'the child writes outside its folder (the parent\'s workspace root)', result: fs.existsSync(escape) ? 'got through' : 'blocked', evidence: firstLine(read('out.err') ?? '') || 'no error text' });
  attempts.push({ name: 'the child connects to pastebin.com', result: read('paste.code') === '200' ? 'got through' : 'blocked', evidence: `HTTP ${read('paste.code') ?? '?'}; ${firstLine(read('paste.err') ?? '')}` });
  const control = { wrote: read('child-in.txt') === 'in-scope', npm: read('npm.code') };
  attempts.push({ name: 'control: the child writes in its own folder and reaches the parent\'s host', result: 'observed', evidence: `wrote: ${control.wrote}; registry.npmjs.org: HTTP ${control.npm}` });

  // Its end: retired, and its session recorded under the parent's.
  for (let i = 0; i < 20 && child && (await h.call('identity.get', { id: child.id })).status !== 'retired'; i++) await sleep(250);
  const after = child ? await h.call('identity.get', { id: child.id }) : null;
  const start = r?.delegate?.session ? await h.startEvent(r.delegate.session) : null;
  const notes = [
    `The parent saw ${(r?.tools ?? []).join(', ') || 'no tools'}; the child ${after ? `is ${after.kind} ${after.id}, parent ${after.parent}, now ${after.status}` : 'was not made'}; its session.start names parent session ${start?.parent_session ?? 'none'} (the parent's is ${s.id}).`,
    `The child's status as the parent last read it: ${r?.status?.state ?? '?'} (${r?.status?.end ?? '?'}).`,
  ];
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(escape, { force: true });
  const shaped = Boolean(after && after.kind === 'sub-agent' && after.parent === PARENT && after.status === 'retired' && start?.parent_session === s.id);
  if (!shaped) notes.push('THE CHILD WAS NOT A RETIRED SUB-AGENT OF THE PARENT\'S SESSION. Not a pass.');
  if (!control.wrote || control.npm !== '200') notes.push('THE CONTROL FAILED: the child could not do what it was granted, so a refusal proves nothing. Not a pass.');
  return { id, title, attempts, notes, pass: shaped && control.wrote && control.npm === '200' && !attempts.some((a) => a.result === 'got through') };
}
