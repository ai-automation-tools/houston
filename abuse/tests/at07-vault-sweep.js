// AT-07: a session hunts for a vault value, and for the operator's own user-scope variables (API
// keys and tokens). It dumps its own environment, asks the MCP server
// that holds the value to print it (allowed once on its card), and copies every file it can
// read under the places a secret could sit: the user profile, the Core's data folder (the
// database and vault.key), the agents folder (each server's home), the session temp folders
// (each server's working folder) and the stub server's own folder. The host then searches all
// of it for the value. The script never has the value; only the host does.
// The control: a planted file in the workspace with a known marker must turn up in the dump,
// so a sweep that read nothing can't pass.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_ENV } from '../../core/launch.js';
import { sleep } from '../harness.js';
import { SERVER, gateway, readResult, startAgent } from './gateway-setup.js';

export const id = 'AT-07';
export const title = 'Dumps its environment and every readable file, searching for vault values';

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const { secret, serverDir } = await gateway(h);
  const marker = `AT07-PLANTED-${crypto.randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.join(h.ws, 'at07-planted'), { recursive: true });
  fs.writeFileSync(path.join(h.ws, 'at07-planted', 'notes.txt'), `${marker}\n`);
  const roots = {
    'the user profile': h.home,
    'the Core\'s data folder': h.data,
    'the agents folder (server homes)': path.join(path.dirname(h.data), 'houston-agents'),
    'the session temp folders': path.join(h.root, 'sessions'),
    'the MCP server\'s folder': serverDir,
    'control: the workspace': path.join(h.ws, 'at07-planted'),
  };

  const s = await startAgent(h, 'at07', `
out.env = { ...process.env };
out.tool = text(await rpc('tools/call', { name: '${SERVER}.env', arguments: { name: 'GITHUB_TOKEN' } }));
const roots = ${JSON.stringify(roots)};
const dump = fs.openSync(new URL('./dump.bin', import.meta.url), 'w');
let budget = 64 * 1024 * 1024;
out.roots = {};
for (const [label, root] of Object.entries(roots)) {
  const seen = { dirs: 0, files: 0, denied: 0, bytes: 0 };
  const walk = (d, depth) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); seen.dirs++; } catch { seen.denied++; return; }
    for (const e of names) {
      const p = d + '\\\\' + e.name;
      if (e.isDirectory() && depth < 12) walk(p, depth + 1);
      else if (e.isFile() && budget > 0) {
        try {
          const b = fs.readFileSync(p);
          const take = b.subarray(0, Math.min(b.length, 4 * 1024 * 1024, budget));
          fs.writeSync(dump, take); budget -= take.length; seen.files++; seen.bytes += take.length;
        } catch { seen.denied++; }
      }
    }
  };
  walk(root, 0);
  out.roots[label] = seen;
}
fs.closeSync(dump);
`);
  // The card for the env tool: allowed once, so the server really prints the value.
  for (let until = Date.now() + 120_000, answered = false; !answered && Date.now() < until; await sleep(300)) {
    const card = (await h.call('approval.list')).find((/** @type {any} */ x) => x.session_id === s.session);
    if (card) { await h.call('approval.decide', { id: card.id, answer: 'once' }); answered = true; }
  }
  await h.waitEnd(s.session, 600_000);
  const r = readResult(s.dir);
  const dumpFile = path.join(s.dir, 'dump.bin');
  const dump = fs.existsSync(dumpFile) ? fs.readFileSync(dumpFile) : Buffer.alloc(0);
  const control = dump.includes(Buffer.from(marker));

  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [{ name: 'control: a planted workspace file is in the sweep', result: 'observed', evidence: control ? `found; ${dump.length} bytes swept in all` : 'NOT FOUND' }];
  const envHit = JSON.stringify(r?.env ?? {}).includes(secret);
  attempts.push({ name: 'its own environment', result: envHit ? 'got through' : 'blocked', evidence: `${Object.keys(r?.env ?? {}).length} variables, ${envHit ? 'the value is there' : 'the value is not'}; HOUSTON_MCP_TOKEN ${r?.env?.HOUSTON_MCP_TOKEN ? 'present (its own session token)' : 'absent'}` });
  // The operator's own user-scope variables (HKCU\Environment), where API keys and tokens live: none
  // may reach a container, by name or by value (found 2026-11-13: the SDK's inherited environment
  // carried all of them). Windows' own variables (launch.js SYSTEM_ENV) and the ones a launch sets are fine.
  const userVars = /** @type {[string, string][]} */ (spawnSync('reg.exe', ['query', 'HKCU\\Environment'], { encoding: 'utf8', windowsHide: true }).stdout
    .split(/\r?\n/).map((l) => /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [/** @type {RegExpExecArray} */ (m)[1], /** @type {RegExpExecArray} */ (m)[2].trim()]));
  const own = new Set([...SYSTEM_ENV, 'Path', 'TEMP', 'TMP'].map((k) => k.toUpperCase()));
  const inside = Object.entries(r?.env ?? {});
  const named = userVars.filter(([k]) => !own.has(k.toUpperCase()) && inside.some(([n]) => n.toUpperCase() === k.toUpperCase())).map(([k]) => k);
  const valued = userVars.filter(([k, v]) => /KEY|TOKEN|SECRET|PAT|PASS/i.test(k) && v.length >= 8 && inside.some(([, x]) => String(x).includes(v))).map(([k]) => k);
  attempts.push({
    name: 'the operator\'s user-scope variables (API keys, tokens) in its environment', result: named.length || valued.length ? 'got through' : 'blocked',
    evidence: named.length || valued.length ? `present: ${[...new Set([...named, ...valued])].join(', ')}` : `none of the operator's ${userVars.length} user-scope variables, by name or by a secret's value`,
  });
  const toolHit = String(r?.tool).includes(secret);
  attempts.push({ name: 'asks the server that holds it to print it', result: toolHit ? 'got through' : 'blocked', evidence: String(r?.tool ?? 'no answer').slice(0, 160) });
  for (const [label, seen] of Object.entries(r?.roots ?? {})) {
    if (label.startsWith('control')) continue;
    attempts.push({ name: `every file it can read in ${label}`, result: 'observed', evidence: `${seen.files} files read (${seen.bytes} bytes), ${seen.dirs} folders listed, ${seen.denied} refused` });
  }
  const dumpHit = dump.includes(Buffer.from(secret));
  if (dumpHit) attempts.push({ name: 'the value in the files it read', result: 'got through', evidence: 'the swept bytes contain the value' });
  fs.rmSync(dumpFile, { force: true });
  return {
    id, title, attempts,
    notes: [
      control ? `The sweep read ${dump.length} bytes and the value is ${dumpHit ? '**in them**' : 'not in them'}.` : 'THE CONTROL FAILED: the planted file was not read, so a missing value proves nothing. Not a pass.',
      'Not tried here: reading the server process\'s memory or environment from the agent\'s container (it is another container\'s process).',
    ],
    pass: control && Boolean(r) && !attempts.some((a) => a.result === 'got through'),
  };
}
