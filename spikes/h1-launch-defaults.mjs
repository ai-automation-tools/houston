// H1 check (run by hand from PowerShell): core/launch.js's defaults against the real SDK.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h1-launch-defaults.mjs
// It works in a houston-launch-check subfolder there, wiped first. It must sit outside the profile: launch.js refuses a workspace under a denied folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@microsoft/mxc-sdk/v1';
import { launchRequest } from '../core/launch.js';
import { globalDenies } from '../core/policy.js';

if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-launch-check');
fs.rmSync(ROOT, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws'); const TMP = path.join(ROOT, 'tmp');
fs.mkdirSync(WS, { recursive: true }); fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(WS, 'a.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
const home = os.homedir();
const globals = globalDenies({ home, coreDir: path.join(process.env.LOCALAPPDATA, 'houston-core') });
const base = { workspace: WS, temp: TMP, home, globals, readonly: ['C:\\Program Files\\Git', 'C:\\Program Files\\nodejs'], pathDirs: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\nodejs'], timeoutMs: 60_000 };
const anon = (s) => s.replaceAll(home, '%USERPROFILE%');
const probes = [
  ['node --version', 'node --version'],
  ['git --version', 'git --version'],
  ['node --test', 'node --test'],
  ['PATH', 'cmd /d /c echo %PATH%'],
  ['list profile', `cmd /d /c dir /b "${home}"`],
  ['read .ssh', `cmd /d /c dir /b "${path.join(home, '.ssh')}"`],
  ['write outside', `cmd /d /c echo x> "${path.join(ROOT, 'outside.txt')}"`],
  ['write workspace', 'cmd /d /c echo x> w.txt && type w.txt'],
  ['internet', `node -e "fetch('https://registry.npmjs.org/').then(r=>console.log('HTTP',r.status),e=>console.log('ERR',e.cause?.code??e.message))"`],
  ['loopback 4273', `node -e "require('net').connect(4273,'127.0.0.1').on('connect',()=>{console.log('OPEN');process.exit()}).on('error',e=>console.log(e.code))"`],
];
for (const [name, command] of probes) {
  let r;
  try { r = await run(launchRequest({ ...base, command })); } catch (e) { r = { exitCode: -1, stdout: '', stderr: `${e.code ?? ''} ${e.message}` }; }
  console.log(`=== ${name} -> exit ${r.exitCode}\n${anon((r.stdout + r.stderr).trim()).split('\n').slice(0, 4).join('\n')}`);
}
console.log('\nrequest:', anon(JSON.stringify(launchRequest({ ...base, command: 'node --test', proxyPort: 18080 }), null, 1)));
