// H1 check (run by hand from PowerShell): a contained session behind core/egress.js reaches the
// hosts on its list and nothing else.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h1-egress-proxy.mjs
// It works in a houston-egress-check subfolder there, wiped first. Needs internet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@microsoft/mxc-sdk/v1';
import { startEgressProxy } from '../core/egress.js';
import { launchRequest } from '../core/launch.js';
import { globalDenies } from '../core/policy.js';

if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-egress-check');
fs.rmSync(ROOT, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws'); const TMP = path.join(ROOT, 'tmp');
fs.mkdirSync(WS, { recursive: true }); fs.mkdirSync(TMP, { recursive: true });

// The list: one public host, plus a loopback address and a name that resolves to loopback, so
// the address rule (not the list) has to stop those two.
const ALLOW = ['registry.npmjs.org:443', '127.0.0.1:4273', 'localhost:4273'];
const proxy = await startEgressProxy({
  check: ({ host, port }) => ({ decision: ALLOW.includes(`${host}:${port}`) ? 'allow' : 'deny' }),
  onEvent: (e) => console.log(`  proxy: ${e.decision} ${e.host}:${e.port} (${e.reason}${e.address ? `, ${e.address}` : ''})`),
});

const home = os.homedir();
const base = {
  workspace: WS, temp: TMP, home, proxyPort: proxy.port,
  globals: globalDenies({ home, coreDir: path.join(process.env.LOCALAPPDATA ?? home, 'houston-core') }),
  readonly: ['C:\\Program Files\\nodejs'], pathDirs: ['C:\\Program Files\\nodejs'], timeoutMs: 60_000,
};
const curl = (url, flags = '') => `curl.exe -sS ${flags} -o NUL -w "HTTP %{http_code}" ${url}`;
const probes = [
  ['proxy variables', 'cmd /d /c set | findstr /i "_proxy"'],
  ['curl allowed host', curl('https://registry.npmjs.org/')],
  // Windows' own TLS (schannel) checks revocation over plain HTTP, which the proxy refuses; without that check:
  ['curl allowed host, no revocation check', curl('https://registry.npmjs.org/', '--ssl-no-revoke')],
  ['curl other host', curl('https://example.com/')],
  ['node fetch allowed host', `node -e "fetch('https://registry.npmjs.org/').then(r=>console.log('HTTP',r.status),e=>console.log('ERR',e.cause?.code??e.message))"`],
  ['curl plain http', curl('http://example.com/')],
  ['curl loopback through proxy', curl('https://127.0.0.1:4273/', '-k')],
  ['curl localhost through proxy', curl('https://localhost:4273/', '-k')],
  ['curl around the proxy', curl('https://registry.npmjs.org/', '--noproxy "*"')],
];
for (const [name, command] of probes) {
  console.log(`=== ${name}`);
  let r;
  try { r = await run(launchRequest({ ...base, command })); } catch (e) { r = { exitCode: -1, stdout: '', stderr: `${e.code ?? ''} ${e.message}` }; }
  console.log(`  exit ${r.exitCode}: ${(r.stdout + r.stderr).trim().replaceAll(String(proxy.port), '<port>').split('\n').join(' | ')}`);
}
await proxy.close();
