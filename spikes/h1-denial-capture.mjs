// H1 check (run by hand from PowerShell, once normally and once from an elevated prompt): can
// the Core learn which path a container was denied? Spike S1 found captureDenials failing
// un-elevated with 0x80004001.
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h1-denial-capture.mjs [--out <file>]
// It works in a houston-denial-check subfolder there, wiped first. --out also writes the report to a file.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@microsoft/mxc-sdk/v1';
import { launchRequest } from '../core/launch.js';
import { globalDenies } from '../core/policy.js';

if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const outAt = process.argv.indexOf('--out');
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

const ROOT = path.join(process.env.H1_ROOT, 'houston-denial-check');
fs.rmSync(ROOT, { recursive: true, force: true });
const WS = path.join(ROOT, 'ws'); const TMP = path.join(ROOT, 'tmp'); const OUTSIDE = path.join(ROOT, 'outside');
for (const d of [WS, TMP, OUTSIDE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'not for the container\n');

const home = os.homedir();
const anon = (s) => String(s).replaceAll(home, '%USERPROFILE%').replaceAll(ROOT, '<root>');
let elevated = false;
try { execSync('net session', { stdio: 'ignore' }); elevated = true; } catch { /* not elevated */ }
log(`elevated: ${elevated}`);

const request = launchRequest({
  command: `cmd /d /c type "${path.join(OUTSIDE, 'secret.txt')}" & type "${path.join(home, '.ssh', 'known_hosts')}" & echo done`,
  workspace: WS, temp: TMP, home, timeoutMs: 60_000,
  globals: globalDenies({ home, coreDir: path.join(process.env.LOCALAPPDATA ?? home, 'houston-core') }),
});
const report = path.join(ROOT, 'denials.json');
request.containment.config.captureDenials = { mode: 'block', outputPath: report };

let r;
try { r = await run(request); } catch (e) { r = { exitCode: -1, stdout: '', stderr: `${e.code ?? ''} ${e.message}` }; }
log(`exit ${r.exitCode}: ${anon((r.stdout + r.stderr).trim()).split('\n').join(' | ')}`);
if (r.outputMetadata) log(`metadata: ${anon(JSON.stringify(r.outputMetadata))}`);
if (fs.existsSync(report)) log(`report:\n${anon(fs.readFileSync(report, 'utf8')).slice(0, 4000)}`);
else log('report: none written');
if (outAt > 0) fs.writeFileSync(process.argv[outAt + 1], lines.join('\n') + '\n');
