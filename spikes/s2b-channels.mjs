// Spike S2, part 2 (throwaway): loopback is all-or-nothing, so how else can a contained agent
// reach the gateway and nothing else? Tries the container proxy, same-container loopback and named pipes.
// Usage (PowerShell): node spikes/s2b-channels.mjs
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { run, spawn } from '@microsoft/mxc-sdk/v1';

const ROOT = 'D:\\AI_Agents\\_maintenance\\tmp\\houston-s2';
const WS = path.join(ROOT, 'ws');
mkdirSync(WS, { recursive: true });
const base = (command, extra = {}) => ({
  command, workingDirectory: WS, timeoutMs: 30_000,
  filesystem: { readwritePaths: [WS], readonlyPaths: ['C:\\Program Files\\nodejs'], deniedPaths: ['C:\\Users'] },
  ui: { disable: false },
  containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'D:\\'] } } },
  ...extra,
});
const show = async (name, req) => {
  try { const r = await run(req); console.log(`\n${name}\n  exit ${r.exitCode}: ${(r.stdout + r.stderr).trim().slice(-500)}${r.warnings.length ? `\n  warnings=${JSON.stringify(r.warnings)}` : ''}`); }
  catch (e) { console.log(`\n${name}\n  REJECTED ${e.code}: ${e.message}`); }
};

// --- T1: the container proxy. A host proxy that answers every request itself.
const seen = [];
const proxy = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end('VIA_PROXY'); });
proxy.on('connect', (req, sock) => { seen.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const P = proxy.address().port;
writeFileSync(path.join(WS, 't1.mjs'), `
import net from 'node:net';
const tcp = (port) => new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
  const d = (v) => { s.destroy(); res(v); }; s.once('connect', () => d('OPEN')); s.once('timeout', () => d('timeout')); s.once('error', (e) => d(e.code)); });
const out = { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /proxy/i.test(k))), hub4273: await tcp(4273), proxyPort: await tcp(${P}) };
try { const r = await fetch('http://127.0.0.1:${P}/direct', { signal: AbortSignal.timeout(3000) }); out.directToProxy = await r.text(); } catch (e) { out.directToProxy = e.cause?.code ?? e.name; }
console.log(JSON.stringify(out));
`);
for (const hostLoopback of ['deny', 'allow']) {
  for (const egress of ['deny', 'allow']) {
    await show(`T1 proxy: egress ${egress}, ingress.default allow, hostLoopback ${hostLoopback}`, base('node t1.mjs', {
      network: { egress: { default: egress }, ingress: { default: 'allow', hostLoopback }, runtimeConfig: { networkProxy: `http://127.0.0.1:${P}` } },
    }));
  }
}
console.log('  proxy saw:', JSON.stringify(seen));
proxy.close();

// --- T2: loopback inside one container, with the default network policy (no host loopback).
writeFileSync(path.join(WS, 't2.mjs'), `
import net from 'node:net';
import { spawnSync } from 'node:child_process';
if (process.argv[2]) { // child: connect to the parent's listener
  const s = net.connect({ host: '127.0.0.1', port: +process.argv[2], timeout: 1500 });
  s.once('connect', () => { console.log('child OPEN'); s.destroy(); }); s.once('error', (e) => console.log('child ' + e.code)); s.once('timeout', () => { console.log('child timeout'); s.destroy(); });
} else {
  const srv = net.createServer((c) => c.end()).listen(0, '127.0.0.1', async () => {
    const { execFile } = await import('node:child_process');
    execFile(process.execPath, ['t2.mjs', String(srv.address().port)], (err, so, se) => { console.log('listen ok;', (so + se).trim() || err?.message); srv.close(); });
  });
  srv.on('error', (e) => console.log('listen ' + e.code));
}
`);
await show('T2 same-container loopback, network omitted', base('node t2.mjs'));

// --- T3: a pipe the host creates; can the container open it?
const hostPipe = '\\\\.\\pipe\\houston-s2-host';
const hp = net.createServer((c) => c.end('HOST_PIPE_OK'));
await new Promise((r) => hp.listen(hostPipe, r));
writeFileSync(path.join(WS, 't3.mjs'), `
import net from 'node:net';
const s = net.connect(${JSON.stringify(hostPipe)});
s.on('data', (d) => console.log(String(d))); s.on('error', (e) => console.log(e.code));
`);
await show('T3 container opens a host-created named pipe (default ACL)', base('node t3.mjs'));
hp.close();

// --- T4: a pipe the container creates; can the host find and open it?
writeFileSync(path.join(WS, 't4.mjs'), `
import net from 'node:net';
const results = [];
for (const name of ['\\\\\\\\.\\\\pipe\\\\houston-s2-ctr', '\\\\\\\\.\\\\pipe\\\\LOCAL\\\\houston-s2-ctr']) {
  await new Promise((res) => { const srv = net.createServer((c) => c.end('CONTAINER_PIPE_OK'));
    srv.once('error', (e) => { results.push(name + ' ' + e.code); res(); });
    srv.listen(name, () => { results.push(name + ' listening'); res(); }); });
}
console.log(JSON.stringify(results));
setTimeout(() => process.exit(0), 6000);
`);
const p = await spawn(base('node t4.mjs'));
let out = ''; p.standardOutput?.on('data', (c) => { out += c; });
await new Promise((r) => setTimeout(r, 2500));
const pipes = readdirSync('\\\\.\\pipe\\').filter((n) => /houston-s2-ctr/i.test(n));
console.log(`\nT4 container-created pipe\n  container says: ${out.trim()}\n  host sees: ${JSON.stringify(pipes.map((n) => n.replace(/S-1-15-2-[\d-]+/, 'S-1-15-2-<container sid>')))}`);
for (const n of pipes) {
  const r = await new Promise((res) => { const s = net.connect('\\\\.\\pipe\\' + n); s.on('data', (d) => res(String(d))); s.on('error', (e) => res(e.code)); });
  console.log(`  host connect -> ${r}`);
}
await p.wait(); p.dispose();
