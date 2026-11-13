// The egress proxy: a session's only way out. A container launched with the container proxy
// setting (spike S2) reaches one host port and nothing else; this listens on that port and
// opens a tunnel only to a host:port the policy allows.
//
// - One proxy per session, so a connection's identity is the port it arrived on: no header,
//   token or client name to trust. The gateway (H3) serves its MCP endpoint on the same port
//   through `fallback`, which gets every origin-form request (`POST /mcp`).
// - HTTPS through CONNECT. Plain HTTP only as GET or HEAD, for the hosts the policy names:
//   Windows' own TLS fetches certificate revocation lists that way and fails without them.
// - The allow-list is by name, and the name is resolved here. Traffic is refused when any
//   address the name resolves to is loopback, private, link-local or otherwise not public,
//   and it goes to the address that was checked. Without that the proxy, which runs
//   outside the container, would be the way round the container's loopback and LAN block.

import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

const PRIVATE = new net.BlockList();
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) PRIVATE.addSubnet(a, bits, 'ipv6');

/** @param {string} address an IP literal @returns {boolean} true only for a public unicast address */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is refused outright; a v6 rule for it would also match every IPv4 address in BlockList.
  if (family === 6 && /^::ffff:/i.test(address)) return false;
  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * A CONNECT target: `host:port` or `[v6]:port`.
 * @param {string | undefined} authority
 * @returns {{ host: string, port: number } | null}
 */
export function parseAuthority(authority) {
  const m = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+)):([0-9]{1,5})$/i.exec(authority ?? '');
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  if (m[1]) return net.isIPv6(m[1]) ? { host: m[1].toLowerCase(), port } : null;
  const host = m[2].toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || host.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return null;
  return { host, port };
}

/** Open tunnels per server, so closing the proxy ends them. @type {WeakMap<http.Server, Set<net.Socket>>} */
const TUNNELS = new WeakMap();

/** @param {string} host */
const defaultLookup = (host) => dns.lookup(host, { all: true, verbatim: true });

// Hop-by-hop headers: they describe one connection, so they are never passed along.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** @param {http.IncomingHttpHeaders} headers @returns {http.OutgoingHttpHeaders} */
function endToEnd(headers) {
  const named = new Set(String(headers.connection ?? '').toLowerCase().split(',').map((s) => s.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k) && !named.has(k)));
}

/**
 * @typedef {{ host: string, port: number }} Target
 * @typedef {{ type: 'egress.connect', host: string, port: number, scheme: 'https' | 'http', decision: 'allow' | 'deny', reason: string, method?: string, address?: string, policy?: any }} EgressEvent
 * @typedef {object} ProxyOptions
 * @property {(t: Target) => any} check  the policy answer for `net.connect` on `host:port`, or a promise
 *   of it; only `{ decision: 'allow' }` lets traffic through and `ask` is deny. The runner turns an
 *   `ask` into the operator's answer before it gets here (approvals.js), holding the request meanwhile.
 * @property {(e: EgressEvent) => void} [onEvent]  one event per CONNECT or plain-HTTP request
 * @property {(host: string) => Promise<{ address: string, family: number }[]>} [lookup]
 * @property {(address: string) => boolean} [isPublic]  tests only; leave it alone
 * @property {(req: http.IncomingMessage, res: http.ServerResponse) => void} [fallback]  origin-form requests
 * @property {number} [connectTimeoutMs]
 * @property {number} [maxResponseBytes]  cap on one plain-HTTP response; a CRL is rarely over a few MB
 */

/**
 * @param {ProxyOptions} opts
 * @returns {http.Server} not listening yet; see startEgressProxy
 */
export function createEgressProxy({
  check, onEvent = () => {}, lookup = defaultLookup, isPublic = isPublicAddress, fallback,
  connectTimeoutMs = 10_000, maxResponseBytes = 64 * 1024 * 1024,
}) {
  /** @param {EgressEvent} e */
  const emit = (e) => { try { onEvent(e); } catch { /* a logging failure must not open or kill a connection */ } };

  /**
   * The one gate both kinds of traffic pass: the policy, then the address rule. Emits the
   * deny event itself.
   * @param {Target} target
   * @param {Pick<EgressEvent, 'scheme' | 'method'>} kind
   * @returns {Promise<{ address: string, policy: any } | { code: number, text: string }>}
   */
  async function authorize(target, kind) {
    /** @param {string} reason @param {object} [extra] */
    const deny = (reason, extra = {}) => emit({ type: 'egress.connect', ...target, ...kind, decision: 'deny', reason, ...extra });
    let policy;
    try { policy = await check(target); } catch (e) {
      deny(`policy check failed: ${/** @type {Error} */ (e).message}`);
      return { code: 403, text: 'Refused by policy.' };
    }
    if (policy?.decision !== 'allow') {
      // An operator's answer (the runner's approval inbox) says so in its own words.
      deny(policy?.approval ? policy.reasons[0] : policy?.decision === 'ask' ? 'ask is deny on the egress proxy' : 'not on the allow-list', { policy });
      return { code: 403, text: `${target.host}:${target.port} is not allowed for this session.` };
    }
    let addresses;
    try { addresses = await lookup(target.host); } catch (e) {
      deny(`lookup failed: ${/** @type {any} */ (e).code ?? /** @type {Error} */ (e).message}`, { policy });
      return { code: 502, text: `${target.host} did not resolve.` };
    }
    if (!addresses?.length || addresses.some((a) => !isPublic(a.address))) {
      deny('resolves to a loopback, private or non-public address', { policy, address: addresses?.map((a) => a.address).join(',') });
      return { code: 403, text: `${target.host} does not resolve to a public address.` };
    }
    return { address: addresses[0].address, policy };
  }

  /** @type {Set<net.Socket>} */
  const tunnels = new Set();

  // Plain HTTP: GET and HEAD only, forwarded to the checked address. Windows' own TLS needs
  // this to fetch revocation lists (H1 egress check); a session reaches only the http hosts
  // its policy names (`net:c.pki.goog:80`).
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/')) {
      if (fallback) return fallback(req, res);
      res.writeHead(404).end();
      return;
    }
    /** @param {number} code @param {string} text */
    const refuse = (code, text) => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain', connection: 'close' });
      res.end(`${text}\n`);
    };
    const kind = /** @type {const} */ ({ scheme: 'http', method: req.method });
    let url = null;
    try { url = new URL(req.url ?? ''); } catch { /* malformed below */ }
    const target = url?.protocol === 'http:' && !url.username && !url.password ? parseAuthority(`${url.hostname}:${url.port || 80}`) : null;
    if (!url || !target) {
      emit({ type: 'egress.connect', host: String(req.url ?? '').slice(0, 300), port: 0, ...kind, decision: 'deny', reason: 'malformed target' });
      return refuse(400, 'A plain-HTTP request names an http:// URL. HTTPS goes through CONNECT.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      emit({ type: 'egress.connect', ...target, ...kind, decision: 'deny', reason: `plain HTTP ${req.method} is not proxied` });
      return refuse(405, 'Only GET and HEAD go through this proxy over plain HTTP.');
    }
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) {
      emit({ type: 'egress.connect', ...target, ...kind, decision: 'deny', reason: 'a GET with a body' });
      return refuse(400, 'A GET has no body.');
    }

    const ok = await authorize(target, kind);
    if (!('address' in ok)) return refuse(ok.code, ok.text);
    const { address, policy } = ok;

    const up = http.request({
      host: address, port: target.port, method: req.method, path: `${url.pathname}${url.search}`,
      headers: { ...endToEnd(req.headers), host: url.host }, setHost: false, agent: false, timeout: connectTimeoutMs,
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
      if (res.headersSent) return void res.destroy();
      emit({ type: 'egress.connect', ...target, ...kind, decision: 'deny', reason: `connect failed: ${/** @type {any} */ (e).code ?? e.message}`, address, policy });
      refuse(502, `Could not reach ${target.host}:${target.port}.`);
    });
    up.on('response', (r) => {
      emit({ type: 'egress.connect', ...target, ...kind, decision: 'allow', reason: policy?.approval ? policy.reasons[0] : 'allowed', address, policy });
      res.writeHead(r.statusCode ?? 502, endToEnd(r.headers));
      let bytes = 0;
      r.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) { r.destroy(); res.destroy(); }
      });
      r.pipe(res);
    });
    res.on('close', () => up.destroy());
    up.end();
  });

  // HTTPS: a CONNECT tunnel to the checked address.
  server.on('connect', async (req, client, head) => {
    /** @param {number} code @param {string} text */
    const refuse = (code, text) => {
      if (!client.destroyed) client.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text) + 1}\r\nConnection: close\r\n\r\n${text}\n`);
    };
    client.on('error', () => client.destroy());
    tunnels.add(/** @type {net.Socket} */ (client));
    client.on('close', () => tunnels.delete(/** @type {net.Socket} */ (client)));

    const kind = /** @type {const} */ ({ scheme: 'https' });
    const target = parseAuthority(req.url);
    if (!target) {
      emit({ type: 'egress.connect', host: String(req.url ?? '').slice(0, 300), port: 0, ...kind, decision: 'deny', reason: 'malformed target' });
      return refuse(400, 'The target is host:port.');
    }
    const ok = await authorize(target, kind);
    if (!('address' in ok)) return refuse(ok.code, ok.text);
    if (client.destroyed) return;
    const { address, policy } = ok;

    const upstream = net.connect({ host: address, port: target.port });
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('connect timeout')));
    let established = false;
    upstream.on('error', (e) => {
      if (!established) {
        emit({ type: 'egress.connect', ...target, ...kind, decision: 'deny', reason: `connect failed: ${/** @type {any} */ (e).code ?? e.message}`, address, policy });
        refuse(502, `Could not reach ${target.host}:${target.port}.`);
      } else {
        client.destroy();
      }
    });
    upstream.once('connect', () => {
      established = true;
      upstream.setTimeout(0);
      emit({ type: 'egress.connect', ...target, ...kind, decision: 'allow', reason: policy?.approval ? policy.reasons[0] : 'allowed', address, policy });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    client.on('close', () => { if (!established) upstream.destroy(); });
  });

  server.on('clientError', (_e, socket) => socket.destroy());
  TUNNELS.set(server, tunnels);
  return server;
}


/**
 * Start a proxy on 127.0.0.1 and a free port.
 * @param {ProxyOptions & { port?: number }} opts
 * @returns {Promise<{ port: number, server: http.Server, close: () => Promise<void> }>}
 */
export async function startEgressProxy({ port = 0, ...opts }) {
  const server = createEgressProxy(opts);
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve(undefined)));
  return {
    port: /** @type {net.AddressInfo} */ (server.address()).port,
    server,
    close: () => new Promise((resolve) => {
      for (const s of TUNNELS.get(server) ?? []) s.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
