// The egress proxy: a session's only way out. A container launched with the container proxy
// setting (spike S2) reaches one host port and nothing else; this listens on that port and
// opens a tunnel only to a host:port the policy allows.
//
// - One proxy per session, so a connection's identity is the port it arrived on: no header,
//   token or client name to trust. The gateway (H3) serves its MCP endpoint on the same port
//   through `fallback`, which gets every origin-form request (`POST /mcp`).
// - HTTPS only, through CONNECT. Plain-HTTP proxying is refused: model providers are HTTPS,
//   and forwarding requests would mean parsing and rewriting them.
// - The allow-list is by name, and the name is resolved here. A tunnel is refused when any
//   address the name resolves to is loopback, private, link-local or otherwise not public,
//   and the tunnel goes to the address that was checked. Without that the proxy, which runs
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

/**
 * @typedef {{ host: string, port: number }} Target
 * @typedef {{ type: 'egress.connect', host: string, port: number, decision: 'allow' | 'deny', reason: string, address?: string, policy?: any }} EgressEvent
 * @typedef {object} ProxyOptions
 * @property {(t: Target) => any} check  the policy answer for `net.connect` on `host:port`; only
 *   `{ decision: 'allow' }` opens a tunnel. There is nobody to ask mid-connection, so `ask` is deny.
 * @property {(e: EgressEvent) => void} [onEvent]  one event per CONNECT and per refused request
 * @property {(host: string) => Promise<{ address: string, family: number }[]>} [lookup]
 * @property {(address: string) => boolean} [isPublic]  tests only; leave it alone
 * @property {(req: http.IncomingMessage, res: http.ServerResponse) => void} [fallback]  origin-form requests
 * @property {number} [connectTimeoutMs]
 */

/**
 * @param {ProxyOptions} opts
 * @returns {http.Server} not listening yet; see startEgressProxy
 */
export function createEgressProxy({ check, onEvent = () => {}, lookup = defaultLookup, isPublic = isPublicAddress, fallback, connectTimeoutMs = 10_000 }) {
  /** @param {EgressEvent} e */
  const emit = (e) => { try { onEvent(e); } catch { /* a logging failure must not open or kill a tunnel */ } };

  /** @type {Set<net.Socket>} */
  const tunnels = new Set();
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/')) {
      if (fallback) return fallback(req, res);
      res.writeHead(404).end();
      return;
    }
    let target = { host: '', port: 0 };
    try { const u = new URL(req.url ?? ''); target = { host: u.hostname, port: Number(u.port) || 80 }; } catch { /* reported as is */ }
    emit({ type: 'egress.connect', ...target, decision: 'deny', reason: 'plain HTTP is not proxied' });
    res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }).end('Only HTTPS (CONNECT) goes through this proxy.\n');
  });

  server.on('connect', async (req, client, head) => {
    /** @param {number} code @param {string} text */
    const refuse = (code, text) => {
      if (!client.destroyed) client.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text) + 1}\r\nConnection: close\r\n\r\n${text}\n`);
    };
    client.on('error', () => client.destroy());
    tunnels.add(/** @type {net.Socket} */ (client));
    client.on('close', () => tunnels.delete(/** @type {net.Socket} */ (client)));

    const target = parseAuthority(req.url);
    if (!target) {
      emit({ type: 'egress.connect', host: String(req.url ?? '').slice(0, 300), port: 0, decision: 'deny', reason: 'malformed target' });
      return refuse(400, 'The target is host:port.');
    }
    /** @param {string} reason @param {object} [extra] */
    const deny = (reason, extra = {}) => emit({ type: 'egress.connect', ...target, decision: 'deny', reason, ...extra });

    let policy;
    try { policy = await check(target); } catch (e) {
      deny(`policy check failed: ${/** @type {Error} */ (e).message}`);
      return refuse(403, 'Refused by policy.');
    }
    if (policy?.decision !== 'allow') {
      deny(policy?.decision === 'ask' ? 'ask is deny on the egress proxy' : 'not on the allow-list', { policy });
      return refuse(403, `${target.host}:${target.port} is not allowed for this session.`);
    }

    let addresses;
    try { addresses = await lookup(target.host); } catch (e) {
      deny(`lookup failed: ${/** @type {any} */ (e).code ?? /** @type {Error} */ (e).message}`, { policy });
      return refuse(502, `${target.host} did not resolve.`);
    }
    if (!addresses?.length || addresses.some((a) => !isPublic(a.address))) {
      deny('resolves to a loopback, private or non-public address', { policy, address: addresses?.map((a) => a.address).join(',') });
      return refuse(403, `${target.host} does not resolve to a public address.`);
    }
    if (client.destroyed) return;

    const address = addresses[0].address;
    const upstream = net.connect({ host: address, port: target.port });
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error('connect timeout')));
    let established = false;
    upstream.on('error', (e) => {
      if (!established) {
        deny(`connect failed: ${/** @type {any} */ (e).code ?? e.message}`, { policy, address });
        refuse(502, `Could not reach ${target.host}:${target.port}.`);
      } else {
        client.destroy();
      }
    });
    upstream.once('connect', () => {
      established = true;
      upstream.setTimeout(0);
      emit({ type: 'egress.connect', ...target, decision: 'allow', reason: 'allowed', address, policy });
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
