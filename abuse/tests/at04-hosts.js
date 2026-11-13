// AT-04: the session asks for hosts that are not on its allow-list, by name and by IP, through
// the proxy and around it. The identity is allowed registry.npmjs.org:443 (and the revocation
// hosts), which is the control: if that fails too, the blocks prove nothing.
// Name resolution inside the container is recorded as an observation, not pass or fail.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { attempt, firstLine, removeDir } from '../harness.js';

export const id = 'AT-04';
export const title = 'It requests a host that is not on its allowlist, by name and by IP';

const PROXY_REFUSALS = ['is not allowed for this session', 'Refused by policy', 'does not resolve to a public address', 'Only GET and HEAD'];

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const npmIp = (await dns.lookup('registry.npmjs.org', { family: 4 }).catch(() => null))?.address ?? null;
  // %% is a literal % in a batch file.
  const curl = (/** @type {string} */ n, /** @type {string} */ args) => attempt(n, `curl.exe -sS -m 20 -o ${n}.body -w "%%{http_code}" ${args}`);
  /** @type {[string, string | null][]} */
  const cases = [
    ['control: registry.npmjs.org, on the list', 'https://registry.npmjs.org/'],
    ['example.com over HTTPS', 'https://example.com/'],
    ['example.com over plain HTTP', 'http://example.com/'],
    ['1.1.1.1 over HTTPS', '-k https://1.1.1.1/'],
    ['1.1.1.1 over plain HTTP', 'http://1.1.1.1/'],
    ['IPv6 2606:4700:4700::1111', '-k "https://[2606:4700:4700::1111]/"'],
    ["registry.npmjs.org's own IP, with its Host header", npmIp ? `-k -H "Host: registry.npmjs.org" https://${npmIp}/` : null],
    ['1.1.1.1 around the proxy', '--noproxy "*" -k https://1.1.1.1/'],
    ['registry.npmjs.org around the proxy', '--noproxy "*" https://registry.npmjs.org/'],
  ];
  const lines = cases.flatMap(([, args], i) => (args ? curl(`a${i}`, args) : []));
  lines.push(...attempt('dns1', 'nslookup example.com'),
    ...attempt('dns2', '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "[System.Net.Dns]::GetHostAddresses(\'example.com\') | ForEach-Object { $_.IPAddressToString }"'));
  const { session, dir } = await h.startScript('at04', lines);
  await h.waitEnd(session);

  const body = (/** @type {string} */ n) => { try { return fs.readFileSync(path.join(dir, `${n}.body`), 'latin1'); } catch { return ''; } };
  let control = false;
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = cases.map(([name, args], i) => {
    if (!args) return { name, result: 'inconclusive', evidence: 'the host could not resolve registry.npmjs.org' };
    const r = h.result(dir, `a${i}`);
    const status = r.out.trim();
    const refusedByProxy = PROXY_REFUSALS.some((t) => body(`a${i}`).includes(t));
    const reached = /^[1-5]\d\d$/.test(status) && !refusedByProxy;
    const evidence = `HTTP ${status || '?'}${refusedByProxy ? ' from the Core\'s proxy' : ''}${r.err ? `; ${firstLine(r.err)}` : ''}`;
    if (i === 0) { control = reached; return { name, result: 'observed', evidence }; }
    return { name, result: reached ? 'got through' : 'blocked', evidence };
  });
  const ns = h.result(dir, 'dns1');
  const ping = h.result(dir, 'dns2');
  const resolved = ping.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[0-9a-f.:]+$/i.test(l) && /[.:]/.test(l));
  attempts.push({ name: 'observation: nslookup example.com (its own DNS query)', result: 'observed', evidence: /Address(es)?:\s*\S+[\s\S]*Name:/i.test(ns.out) ? 'resolved' : firstLine(ns.err || ns.out) || `exit ${ns.code}` });
  attempts.push({ name: 'observation: .NET Dns.GetHostAddresses (the system resolver)', result: 'observed', evidence: resolved.length ? `example.com resolved (${resolved.length} addresses)` : firstLine(ping.err || ping.out) || `exit ${ping.code}` });
  removeDir(dir);
  const notes = [control ? 'The control reached registry.npmjs.org, so the network and the proxy work and the blocks come from policy.' : 'THE CONTROL FAILED: registry.npmjs.org was not reached, so the blocks below may only mean there is no network. Not a pass.'];
  if (resolved.length) notes.push('A contained process can resolve names through the system resolver, so a DNS query can carry data out even though no connection is allowed. Recorded for the gateway milestone (H3); AT-04 is about connections.');
  return { id, title, attempts, notes, pass: control && !attempts.some((a) => a.result === 'got through') };
}
