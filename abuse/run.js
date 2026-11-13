// The abuse suite: run by hand from PowerShell on a real Windows 11 machine.
//   $env:H1_ROOT = '<a scratch folder outside your user profile>'; node abuse/run.js [AT-01 AT-04 ...]
// It works in <H1_ROOT>\houston-abuse and in %LOCALAPPDATA%\houston-core-abuse (the Core's data
// folder, in the profile as a real one is), both wiped first. It needs internet for AT-04's
// control. It prints each test and writes the run, with names and paths anonymized, to
// abuse/results/<date>.md. Exit code 0 only if every test it ran passed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT, anonymize, createHarness } from './harness.js';
import * as at01 from './tests/at01-private-folders.js';
import * as at02 from './tests/at02-links.js';
import * as at03 from './tests/at03-path-forms.js';
import * as at04 from './tests/at04-hosts.js';
import * as at05 from './tests/at05-loopback-apps.js';
import * as at12 from './tests/at12-stop-all.js';
import * as at14 from './tests/at14-audit-edit.js';
import * as at15 from './tests/at15-secret-in-output.js';
import * as at16 from './tests/at16-core-killed.js';

// AT-16 and AT-14 restart the Core, so they go last; AT-14 edits the log, so it is last of all.
const TESTS = [at01, at02, at03, at04, at05, at12, at15, at16, at14];

if (process.platform !== 'win32' || !process.env.H1_ROOT || !process.env.LOCALAPPDATA) {
  console.error('Run on Windows from PowerShell, with H1_ROOT set to a scratch folder outside your user profile.');
  process.exit(1);
}
const wanted = process.argv.slice(2).map((a) => a.toUpperCase());
const tests = wanted.length ? TESTS.filter((t) => wanted.includes(t.id)) : TESTS;
if (!tests.length) { console.error(`No such test. Tests: ${TESTS.map((t) => t.id).join(', ')}`); process.exit(1); }

const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-abuse'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-abuse') });
await h.startCore();
// The agent every attack runs as: write on its workspace, one host on the internet (the AT-04
// control) and the revocation hosts Windows TLS needs, nothing else.
await h.call('identity.create', { id: AGENT, kind: 'ai-agent', displayName: 'Abuse suite agent', purpose: 'Runs the abuse tests' });
for (const [resource, permission] of [[`file:${h.ws.replaceAll('\\', '/')}/**`, 'write'], ['net:registry.npmjs.org:443', 'connect'], ['net:c.pki.goog:80', 'connect'], ['net:o.pki.goog:80', 'connect']]) {
  await h.call('grant.add', { identity: AGENT, resource, permission });
}
await h.call('identity.activate', { id: AGENT });

/** @type {import('./harness.js').Result[]} */
const results = [];
for (const t of tests) {
  process.stdout.write(`${t.id} ${t.title} ... `);
  try {
    results.push(await t.run(h));
  } catch (e) {
    results.push({ id: t.id, title: t.title, pass: false, attempts: [], notes: [`The test itself failed: ${/** @type {Error} */ (e).message}`] });
  }
  const r = /** @type {import('./harness.js').Result} */ (results.at(-1));
  console.log(r.pass ? 'PASS' : 'FAIL');
  for (const a of r.attempts) console.log(`  ${a.result.padEnd(12)} ${a.name}: ${anonymize(h, a.evidence)}`);
  for (const n of r.notes) console.log(`  note: ${anonymize(h, n)}`);
}
await h.close();

// The record.
const winver = spawnSync('cmd.exe', ['/d', '/c', 'ver'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
const elevated = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true }).stdout.includes('S-1-16-12288');
const sdk = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../node_modules/@microsoft/mxc-sdk/package.json', import.meta.url)), 'utf8')).version;
const all = results.flatMap((r) => r.attempts.filter((a) => a.result === 'blocked' || a.result === 'got through'));
const through = all.filter((a) => a.result === 'got through').length;
const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
const cell = (/** @type {string} */ s) => anonymize(h, s).replaceAll('|', '\\|').replaceAll('\n', ' ');
const md = [
  `# Abuse suite run, ${date}`,
  '',
  `${winver}, ${os.arch()}, Node ${process.version}, \`@microsoft/mxc-sdk\` ${sdk}, ${elevated ? 'elevated' : 'not elevated'}. Run with \`node abuse/run.js${wanted.length ? ` ${wanted.join(' ')}` : ''}\`.`,
  '',
  `**${results.filter((r) => r.pass).length} of ${results.length} tests pass. ${through} of ${all.length} attempts got through.**`,
  '',
  '| Test | Result |',
  '|:---|:---|',
  ...results.map((r) => `| ${r.id} | ${r.pass ? 'PASS' : '**FAIL**'}: ${cell(r.title)} |`),
  '',
  ...results.flatMap((r) => [
    `## ${r.id}: ${r.pass ? 'PASS' : 'FAIL'}`,
    '',
    cell(r.title),
    '',
    '| Attempt | Result | Evidence |',
    '|:---|:---|:---|',
    ...r.attempts.map((a) => `| ${cell(a.name)} | ${a.result === 'got through' ? '**got through**' : a.result} | ${cell(a.evidence)} |`),
    '',
    ...r.notes.map((n) => `- ${cell(n)}`),
    ...(r.notes.length ? [''] : []),
  ]),
].join('\n');
const out = fileURLToPath(new URL(`./results/${date}.md`, import.meta.url));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} pass, ${through}/${all.length} attempts got through. Saved ${path.relative(process.cwd(), out)}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
