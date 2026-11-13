// AT-05: the session calls other local apps over loopback. The test runs its own HTTP server on
// the host, on 127.0.0.1 and on every interface, which answers with a planted token; Project Hub
// (127.0.0.1:4273) is tried as a real local app when it runs. Each is tried by IPv4, IPv6 and
// name, through the session's proxy and around it, and once more after the identity is granted
// the loopback port outright: the hard deny on loopback must win over a grant.
// The control is the host itself reaching the same server, so a block isn't just a dead server.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { attempt, firstLine, token } from '../harness.js';

export const id = 'AT-05';
export const title = 'It calls other local apps on loopback (Project Hub, the test\'s own local server)';

const HUB = 4273;

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const secret = token();
  const server = http.createServer((_req, res) => res.end(secret));
  await new Promise((r) => server.listen(0, '0.0.0.0', () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null;
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [];
  /** @type {string | undefined} */
  let grantId;
  try {
    // The controls: from the host, the server answers and Hub may.
    const hostSees = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => '');
    const hub = await fetch(`http://127.0.0.1:${HUB}/`).then((r) => r.status).catch(() => 0);
    attempts.push({ name: 'control: the host reaches the test server', result: 'observed', evidence: hostSees === secret ? 'answered with its token' : 'no answer' });
    attempts.push({ name: 'control: the host reaches Project Hub', result: 'observed', evidence: hub ? `HTTP ${hub}` : 'not running here; its cases are skipped' });

    const curl = (/** @type {string} */ n, /** @type {string} */ args) => attempt(n, `curl.exe -sS -m 10 -o ${n}.body -w "%%{http_code}" ${args}`);
    /** @type {[string, string][]} */
    const cases = [
      ['127.0.0.1, through the proxy', `http://127.0.0.1:${port}/`],
      ['127.0.0.1, around the proxy', `--noproxy "*" http://127.0.0.1:${port}/`],
      ['localhost, through the proxy', `http://localhost:${port}/`],
      ['localhost, around the proxy', `--noproxy "*" http://localhost:${port}/`],
      ['[::1], around the proxy', `--noproxy "*" "http://[::1]:${port}/"`],
      ['127.0.0.2 (the rest of 127/8), around the proxy', `--noproxy "*" http://127.0.0.2:${port}/`],
      ...(/** @type {[string, string][]} */ (lan ? [[`the host's LAN address, through the proxy`, `http://${lan}:${port}/`], [`the host's LAN address, around the proxy`, `--noproxy "*" http://${lan}:${port}/`]] : [])),
      ...(/** @type {[string, string][]} */ (hub ? [['Project Hub, through the proxy', `http://127.0.0.1:${HUB}/api/tree`], ['Project Hub, around the proxy', `--noproxy "*" http://127.0.0.1:${HUB}/api/tree`]] : [])),
    ];
    const reached = (/** @type {string} */ dir, /** @type {string} */ n, /** @type {boolean} */ hubCase) => {
      const r = h.result(dir, n);
      const file = path.join(dir, n + '.body');
      const body = fs.existsSync(file) ? fs.readFileSync(file, 'latin1') : '';
      const status = r.out.trim();
      // The test server is reached only if its token came back; Hub, if it answered 2xx.
      const got = hubCase ? /^2\d\d$/.test(status) && !body.includes('is not allowed') : body.includes(secret);
      // The machine's own address is masked: the record is committed.
      const evidence = `HTTP ${status || '?'}${r.err ? `; ${firstLine(r.err)}` : ''}`;
      return { got, evidence: lan ? evidence.replaceAll(lan, '<LAN address>') : evidence };
    };
    const first = await h.runScript('at05', cases.flatMap(([, args], i) => curl(`a${i}`, args)));
    cases.forEach(([name], i) => {
      const r = reached(first.dir, `a${i}`, name.startsWith('Project Hub'));
      attempts.push({ name, result: r.got ? 'got through' : 'blocked', evidence: r.evidence });
    });

    // A grant for the loopback port itself must not open it: loopback is denied for every session.
    const g = await h.call('grant.add', { identity: 'local:abuse-agent', resource: `net:127.0.0.1:${port}`, permission: 'connect' });
    grantId = g.id;
    const second = await h.runScript('at05-granted', [...curl('g0', `http://127.0.0.1:${port}/`), ...curl('g1', `--noproxy "*" http://127.0.0.1:${port}/`)]);
    for (const [n, name] of [['g0', 'with a grant for 127.0.0.1:<port>, through the proxy'], ['g1', 'with a grant for 127.0.0.1:<port>, around the proxy']]) {
      const r = reached(second.dir, n, false);
      attempts.push({ name, result: r.got ? 'got through' : 'blocked', evidence: r.evidence });
    }
    const control = hostSees === secret;
    return {
      id, title, attempts,
      notes: [control ? 'The host reached the same server, so a block is the container\'s, not a dead server.' : 'THE CONTROL FAILED: the host could not reach its own server. Not a pass.'],
      pass: control && !attempts.some((a) => a.result === 'got through'),
    };
  } finally {
    if (grantId) await h.call('grant.remove', { id: grantId }).catch(() => {});
    server.close();
  }
}

