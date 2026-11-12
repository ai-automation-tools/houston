import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { isPublicAddress, parseAuthority, startEgressProxy } from '../../core/egress.js';

/** An echo server on loopback that counts connections. */
async function echoServer(t) {
  let connections = 0;
  const server = net.createServer((s) => { connections++; s.pipe(s); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, count: () => connections };
}

/** A proxy whose names all resolve to loopback, with the public-address rule switched off. */
async function proxy(t, allowed, extra = {}) {
  const events = [];
  const p = await startEgressProxy({
    check: ({ host, port }) => (allowed.includes(`${host}:${port}`) ? { decision: 'allow' } : { decision: 'deny' }),
    onEvent: (e) => events.push(e),
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    isPublic: () => true,
    ...extra,
  });
  t.after(() => p.close());
  return { ...p, events };
}

/**
 * Send a raw CONNECT (plus optional bytes in the same packet) and read the reply.
 * @returns {Promise<{ status: number, rest: string, socket: net.Socket }>}
 */
function connect(port, target, extra = '') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${extra}`));
    let buf = '';
    socket.on('data', (d) => {
      buf += d;
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeAllListeners('data');
      resolve({ status: Number(buf.slice(9, 12)), rest: buf.slice(end + 4), socket });
    });
    socket.on('error', reject);
    socket.on('close', () => resolve({ status: 0, rest: buf, socket }));
  });
}

/** Read from a socket until `want` bytes arrived or it closes. */
const read = (socket, want) => new Promise((resolve) => {
  let got = '';
  socket.on('data', (d) => { got += d; if (got.length >= want) resolve(got); });
  socket.on('close', () => resolve(got));
});

test('isPublicAddress: only public unicast addresses pass', () => {
  for (const a of ['1.1.1.1', '8.8.8.8', '104.18.0.1', '2606:4700::1111']) assert.ok(isPublicAddress(a), a);
  for (const a of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '::', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    'ff02::1', 'localhost', '', 'not an ip']) assert.ok(!isPublicAddress(a), a);
});

test('parseAuthority: host:port and [v6]:port, nothing else', () => {
  assert.deepEqual(parseAuthority('API.OpenAI.com.:443'), { host: 'api.openai.com', port: 443 });
  assert.deepEqual(parseAuthority('[2606:4700::1111]:443'), { host: '2606:4700::1111', port: 443 });
  assert.deepEqual(parseAuthority('1.2.3.4:8443'), { host: '1.2.3.4', port: 8443 });
  for (const bad of [undefined, '', 'api.openai.com', 'api.openai.com:0', 'api.openai.com:65536', 'a b:443', 'a..b:443', '-a.com:443',
    'user@a.com:443', 'http://a.com:443', '[zz]:443', '[::1:443', 'a.com:443/x', `${'a'.repeat(64)}.com:443`]) {
    assert.equal(parseAuthority(bad), null, String(bad));
  }
});

test('an allowed host gets a tunnel, bytes sent with the CONNECT included, and one allow event', async (t) => {
  const echo = await echoServer(t);
  const p = await proxy(t, [`api.example.com:${echo.port}`]);
  const { status, socket } = await connect(p.port, `api.example.com:${echo.port}`, 'early');
  assert.equal(status, 200);
  socket.write('-late');
  assert.equal(await read(socket, 10), 'early-late');
  socket.destroy();
  assert.deepEqual(p.events.map((e) => [e.decision, e.host, e.port, e.address]), [['allow', 'api.example.com', echo.port, '127.0.0.1']]);
});

test('a host not on the list is refused before anything is resolved or dialled', async (t) => {
  const echo = await echoServer(t);
  let lookups = 0;
  const p = await proxy(t, [], { lookup: async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; } });
  const { status, rest } = await connect(p.port, `evil.example.com:${echo.port}`);
  assert.equal(status, 403);
  assert.match(rest, /not allowed/);
  assert.equal(lookups, 0);
  assert.equal(echo.count(), 0);
  assert.deepEqual(p.events.map((e) => [e.decision, e.reason]), [['deny', 'not on the allow-list']]);
});

test('ask, a thrown check and a malformed answer are all deny', async (t) => {
  for (const check of [() => ({ decision: 'ask' }), () => { throw new Error('db gone'); }, async () => undefined, () => ({ decision: 'ALLOW' })]) {
    const p = await proxy(t, [], { check });
    assert.equal((await connect(p.port, 'api.example.com:443')).status, 403);
    assert.equal(p.events[0].decision, 'deny');
  }
});

test('with the real address rule, a name or literal that reaches loopback or the LAN is refused (the S2 hole)', async (t) => {
  const echo = await echoServer(t);
  const allowAll = () => ({ decision: 'allow' });
  const cases = [
    [`127.0.0.1:${echo.port}`, undefined],
    [`[::1]:${echo.port}`, undefined],
    [`rebind.example.com:${echo.port}`, async () => [{ address: '127.0.0.1', family: 4 }]],
    [`mixed.example.com:${echo.port}`, async () => [{ address: '93.184.215.14', family: 4 }, { address: '192.168.1.10', family: 4 }]],
    [`meta.example.com:${echo.port}`, async () => [{ address: '169.254.169.254', family: 4 }]],
    [`none.example.com:${echo.port}`, async () => []],
  ];
  for (const [target, lookup] of cases) {
    const p = await proxy(t, [], { check: allowAll, isPublic: undefined, ...(lookup ? { lookup } : { lookup: undefined }) });
    const { status, rest } = await connect(p.port, target);
    assert.equal(status, 403, target);
    assert.match(rest, /public address/, target);
    assert.match(p.events[0].reason, /non-public/, target);
  }
  assert.equal(echo.count(), 0);
});

test('a malformed target is a 400, an unreachable one a 502, a name that does not resolve a 502', async (t) => {
  const p = await proxy(t, ['api.example.com:1', 'nowhere.example.com:443'], {
    lookup: async (h) => { if (h === 'nowhere.example.com') throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); return [{ address: '127.0.0.1', family: 4 }]; },
  });
  assert.equal((await connect(p.port, 'no-port.example.com')).status, 400);
  // A request line HTTP can't parse is dropped without a reply or an event.
  assert.equal((await connect(p.port, 'not a target')).status, 0);
  assert.equal((await connect(p.port, 'api.example.com:1')).status, 502);
  const nx = await connect(p.port, 'nowhere.example.com:443');
  assert.equal(nx.status, 502);
  assert.deepEqual(p.events.map((e) => e.reason), ['malformed target', 'connect failed: ECONNREFUSED', 'lookup failed: ENOTFOUND']);
});

/** An HTTP server on loopback that records what reached it and answers with `body`. */
async function httpServer(t, body = 'CRL-BYTES') {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/pkix-crl', 'content-length': Buffer.byteLength(body), connection: 'x-hop', 'x-hop': '1', 'x-up': 'yes' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, seen };
}

/** A request through the proxy. @returns {Promise<{ status: number, headers: object, body: string, error?: string }>} */
const viaProxy = (proxyPort, method, url, headers = {}, body) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers, agent: false }, (res) => {
    let got = '';
    res.on('data', (d) => { got += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: got }));
    res.on('error', (e) => resolve({ status: res.statusCode, headers: res.headers, body: got, error: e.code ?? e.message }));
    res.on('aborted', () => resolve({ status: res.statusCode, headers: res.headers, body: got, error: 'aborted' }));
  });
  req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: e.code }));
  req.end(body);
});

test('plain-HTTP GET and HEAD reach an allowed host, with hop-by-hop headers dropped both ways', async (t) => {
  const up = await httpServer(t);
  const p = await proxy(t, [`crl.example.com:${up.port}`]);
  const url = `http://crl.example.com:${up.port}/gts1c3/abc.crl?x=1`;
  const r = await viaProxy(p.port, 'GET', url, { 'proxy-authorization': 'Basic c2VjcmV0', 'proxy-connection': 'keep-alive', connection: 'x-drop', 'x-drop': '1', accept: '*/*' });
  assert.deepEqual([r.status, r.body, r.headers['x-up'], r.headers['x-hop']], [200, 'CRL-BYTES', 'yes', undefined]);
  const h = up.seen[0];
  assert.deepEqual([h.method, h.url, h.headers.host, h.headers.accept], ['GET', '/gts1c3/abc.crl?x=1', `crl.example.com:${up.port}`, '*/*']);
  for (const gone of ['proxy-authorization', 'proxy-connection', 'x-drop']) assert.equal(h.headers[gone], undefined, gone);
  assert.equal((await viaProxy(p.port, 'HEAD', url)).status, 200);
  assert.deepEqual(p.events.map((e) => [e.scheme, e.method, e.decision, e.host, e.address]), [
    ['http', 'GET', 'allow', 'crl.example.com', '127.0.0.1'], ['http', 'HEAD', 'allow', 'crl.example.com', '127.0.0.1'],
  ]);
});

test('plain HTTP: a host not on the list, another method, a body or an https URL never reaches anyone', async (t) => {
  const up = await httpServer(t);
  const p = await proxy(t, [`crl.example.com:${up.port}`]);
  const url = `http://crl.example.com:${up.port}/x`;
  const cases = [
    ['GET', `http://other.example.com:${up.port}/x`, {}, undefined, 403, 'not on the allow-list'],
    ['POST', url, { 'content-type': 'application/ocsp-request' }, 'abc', 405, 'plain HTTP POST is not proxied'],
    ['PUT', url, {}, 'abc', 405, 'plain HTTP PUT is not proxied'],
    ['GET', url, { 'content-length': '3' }, 'abc', 400, 'a GET with a body'],
    ['GET', `https://crl.example.com:${up.port}/x`, {}, undefined, 400, 'malformed target'],
    ['GET', `http://user:pw@crl.example.com:${up.port}/x`, {}, undefined, 400, 'malformed target'],
  ];
  for (const [method, target, headers, body, status, reason] of cases) {
    const before = p.events.length;
    const r = await viaProxy(p.port, method, target, headers, body);
    assert.equal(r.status, status, `${method} ${target}`);
    assert.equal(p.events[before].reason, reason, `${method} ${target}`);
  }
  assert.equal(up.seen.length, 0);
});

test('plain HTTP keeps the address rule: a listed name or literal that reaches loopback is refused', async (t) => {
  const up = await httpServer(t);
  for (const [url, lookup] of [[`http://127.0.0.1:${up.port}/`, undefined], [`http://rebind.example.com:${up.port}/`, async () => [{ address: '127.0.0.1', family: 4 }]]]) {
    const p = await proxy(t, [], { check: () => ({ decision: 'allow' }), isPublic: undefined, lookup });
    const r = await viaProxy(p.port, 'GET', url);
    assert.equal(r.status, 403, url);
    assert.match(p.events[0].reason, /non-public/, url);
  }
  assert.equal(up.seen.length, 0);
});

test('plain HTTP: an unreachable host is a 502, and a response over the cap is cut off', async (t) => {
  const p = await proxy(t, ['down.example.com:1']);
  assert.equal((await viaProxy(p.port, 'GET', 'http://down.example.com:1/')).status, 502);
  assert.match(p.events.at(-1).reason, /connect failed/);
  const up = await httpServer(t, 'x'.repeat(5000));
  const q = await proxy(t, [`big.example.com:${up.port}`], { maxResponseBytes: 100 });
  const r = await viaProxy(q.port, 'GET', `http://big.example.com:${up.port}/`);
  assert.ok(r.error || r.body.length < 5000, 'the response was not cut off');
});

test('origin-form requests go to the fallback, or 404 without one', async (t) => {
  const p = await proxy(t, []);
  assert.equal((await viaProxy(p.port, 'GET', '/mcp')).status, 404);
  const q = await proxy(t, [], { fallback: (req, res) => res.writeHead(200).end(req.url) });
  const r = await viaProxy(q.port, 'POST', '/mcp', {}, '{}');
  assert.deepEqual([r.status, r.body], [200, '/mcp']);
  assert.equal(q.events.length, 0);
});


test('the proxy listens on 127.0.0.1 only, and closing it ends open tunnels', async (t) => {
  const echo = await echoServer(t);
  const p = await startEgressProxy({ check: () => ({ decision: 'allow' }), lookup: async () => [{ address: '127.0.0.1', family: 4 }], isPublic: () => true });
  assert.equal(p.server.address().address, '127.0.0.1');
  const { status, socket } = await connect(p.port, `api.example.com:${echo.port}`);
  assert.equal(status, 200);
  const closed = new Promise((r) => socket.on('close', r));
  await p.close();
  await closed;
});
