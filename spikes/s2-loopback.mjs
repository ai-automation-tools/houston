// Spike S2 (throwaway): which network policy stops a contained process reaching the other
// local apps on loopback while one "gateway" port stays reachable?
// Usage (PowerShell): node spikes/s2-loopback.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run } from '@microsoft/mxc-sdk/v1';

const ROOT = 'D:\\AI_Agents\\_maintenance\\tmp\\houston-s2';
const WS = path.join(ROOT, 'ws');
mkdirSync(WS, { recursive: true });

const APP_PORTS = [4273, 3010, 8765]; // Project Hub, Promptbook, Roundtable
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;

// The stand-in gateway: answers on every interface so loopback and LAN paths can both be tried.
const gateway = http.createServer((req, res) => res.end('GATEWAY_OK')).listen(0, '0.0.0.0');
await new Promise((r) => gateway.once('listening', r));
const G = gateway.address().port;
// A tiny forward proxy on the host for the proxy variant: answers every request itself.
const proxy = http.createServer((req, res) => res.end(`PROXIED ${req.url}`)).listen(0, '127.0.0.1');
await new Promise((r) => proxy.once('listening', r));
const P = proxy.address().port;

// Runs inside the container: raw TCP connects, then one outbound HTTPS request.
writeFileSync(path.join(WS, 'probe.mjs'), `
import net from 'node:net';
const targets = JSON.parse(process.argv[2]);
const tryOne = ([host, port]) => new Promise((res) => {
  const s = net.connect({ host, port, timeout: 1500 });
  const done = (v) => { s.destroy(); res([host + ':' + port, v]); };
  s.once('connect', () => done('OPEN')); s.once('timeout', () => done('timeout')); s.once('error', (e) => done(e.code));
});
const out = Object.fromEntries(await Promise.all(targets.map(tryOne)));
try { const r = await fetch('https://registry.npmjs.org/is-odd/latest', { signal: AbortSignal.timeout(4000) }); out.internet = 'HTTP ' + r.status; }
catch (e) { out.internet = e.cause?.code ?? e.name; }
console.log(JSON.stringify(out));
`);

const targets = [
  ...APP_PORTS.map((p) => ['127.0.0.1', p]),
  ['127.0.0.1', G], ['127.0.0.1', P], ['::1', 4273],
  ...(lanIp ? [[lanIp, G], [lanIp, 4273]] : []),
];
const lo = (port) => ({ to: [{ cidr: '127.0.0.0/8' }], ports: port ? [{ protocol: 'tcp', port }] : undefined });
const VARIANTS = {
  'A omitted': undefined,
  'B egress allow': { egress: { default: 'allow' } },
  'C egress allow + hostLoopback allow': { egress: { default: 'allow' }, ingress: { hostLoopback: 'allow' } },
  'D egress deny + hostLoopback allow': { egress: { default: 'deny' }, ingress: { hostLoopback: 'allow' } },
  'E egress deny, allow 127.0.0.1:gateway only, hostLoopback allow': { egress: { default: 'deny', allow: [lo(G)] }, ingress: { hostLoopback: 'allow' } },
  'F egress allow, deny 127/8 except gateway, hostLoopback allow': {
    egress: { default: 'allow', deny: [{ to: [{ cidr: '127.0.0.0/8' }], ports: [{ protocol: 'tcp', port: 1, endPort: G - 1 }, { protocol: 'tcp', port: G + 1, endPort: 65535 }] }] },
    ingress: { hostLoopback: 'allow' },
  },
  'G egress allow, deny the three app ports, hostLoopback allow': {
    egress: { default: 'allow', deny: [{ ports: APP_PORTS.map((port) => ({ protocol: 'tcp', port })) }] },
    ingress: { hostLoopback: 'allow' },
  },
  // The proxy setting needs egress deny with no rules, ingress.default allow and hostLoopback allow.
  'H container proxy: egress deny, ingress allow, hostLoopback allow, networkProxy = host port': {
    egress: { default: 'deny' }, ingress: { default: 'allow', hostLoopback: 'allow' }, runtimeConfig: { networkProxy: `http://127.0.0.1:${P}` },
  },
};

console.log(JSON.stringify({ gatewayPort: G, proxyPort: P, lanIp: lanIp ? 'present' : 'none', targets: targets.map(([h, p]) => `${h === lanIp ? 'LAN' : h}:${p === G ? 'gateway' : p}`) }));
for (const [name, network] of Object.entries(VARIANTS)) {
  const req = {
    command: `node probe.mjs ${JSON.stringify(JSON.stringify(targets))}`,
    workingDirectory: WS,
    timeoutMs: 30_000,
    filesystem: { readwritePaths: [WS], readonlyPaths: ['C:\\Program Files\\nodejs'], deniedPaths: ['C:\\Users'] },
    ui: { disable: false },
    containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'D:\\'] } } },
    ...(network ? { network } : {}),
  };
  let line;
  try {
    const r = await run(req);
    line = r.exitCode === 0 ? r.stdout.trim() : `exit ${r.exitCode}: ${(r.stdout + r.stderr).trim().slice(-300)}`;
    if (r.warnings.length) line += `  warnings=${JSON.stringify(r.warnings)}`;
  } catch (e) { line = `REJECTED ${e.code}: ${e.message}`; }
  console.log(`\n${name}\n  ${line.replaceAll(String(G), 'gateway').replaceAll(String(P), 'proxy').replaceAll(lanIp ?? '\0', 'LAN')}`);
}
gateway.close(); proxy.close();
