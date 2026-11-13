// H4 check (run by hand from PowerShell): `harness run --grant <id>` against a real Core and real
// containers, as a scheduled task would run it. A throwaway Core (data in
// %LOCALAPPDATA%\houston-core-h4check, work in <H1_ROOT>\houston-h4check, both wiped before and
// after), one command identity, and these runs, each with the exit code it must give:
//   a run that prints and exits 3, whose `ask` host is refused without a card (unattended)   3
//   a second run while the first is going                                                    74 overlap
//   the first run, ended by Stop All, and then a run of the grant Stop All paused            70, 75
//   a run after the identity got another grant, then after the operator approved again      72, 0
//   a run after the grant expired                                                             73
//   a run that outlasts its 1-minute budget                                                   71
//   a run with no Core to ask                                                                 69
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h4-standing.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, sleep } from '../abuse/harness.js';

if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const HARNESS = fileURLToPath(new URL('../core/harness.js', import.meta.url));
const ID = 'local:h4-nightly';
const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-h4check'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-h4check') });
const home = h.home;
const anon = (/** @type {string} */ s) => s.replaceAll(home, '%USERPROFILE%').replaceAll(h.root, '<root>');

/** Run the CLI as a scheduled task would. @param {string} grant @param {string} [data] @returns {Promise<{ code: number | null, out: string, err: string }>} */
function harness(grant, data = h.data) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HARNESS, 'run', '--grant', grant], { env: { ...process.env, HOUSTON_CORE_DATA: data }, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}
/** @type {[string, number, number | null, string][]} */
const rows = [];
const check = (/** @type {string} */ what, /** @type {number} */ want, /** @type {{ code: number | null, err: string }} */ r) => {
  rows.push([what, want, r.code, anon(r.err.trim().split('\n').at(-1) ?? '')]);
};

try {
  await h.startCore();
  await h.call('identity.create', { id: ID, kind: 'ai-agent', displayName: 'H4 nightly' });
  for (const [resource, permission, effect] of [[`file:${h.ws.replaceAll('\\', '/')}/**`, 'write'], ['net:example.com:443', 'connect', 'ask'], ['net:c.pki.goog:80', 'connect'], ['net:o.pki.goog:80', 'connect']]) {
    await h.call('grant.add', { identity: ID, resource, permission, ...(effect ? { effect } : {}) });
  }
  await h.call('identity.activate', { id: ID });
  const day = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const grant = (/** @type {string} */ id, /** @type {string} */ command, maxMinutes = 10, expiresAt = day) => h.call('standing.create', { id, identity: ID, workspace: h.ws, command, maxMinutes, expiresAt });
  // Through cmd, which expands %SystemRoot%; PowerShell's folder isn't on a session's PATH.
  const sleepCmd = (/** @type {number} */ s) => `cmd.exe /d /c "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command Start-Sleep ${s}`;

  await grant('nightly', 'cmd.exe /d /c curl.exe -s -o NUL -w "example.com: %{http_code}" https://example.com/ & echo. & echo nightly-ok & exit 3');
  const first = await harness('nightly');
  check('a run that exits 3', 3, first);
  const ask = (await h.call('audit.query', { type: 'egress.connect' })).events.filter((/** @type {any} */ e) => e.resource.id === 'example.com:443');
  const start = (await h.call('audit.query', { type: 'session.start' })).events.at(-1);
  console.log(`  printed: ${JSON.stringify(first.out.split(/\r?\n/).filter((l) => /nightly-ok|example\.com/.test(l)))}`);
  console.log(`  the ask host: ${ask.map((/** @type {any} */ e) => `${e.decision.result} (${e.decision.reasons[0]})`).join(', ') || 'no event'}; cards now: ${(await h.call('approval.list')).length}`);
  console.log(`  session.start: standing_grant=${start.standing_grant}, identity=${start.identity.subject}`);

  await grant('sleeper', sleepCmd(60));
  const long = harness('sleeper');
  await sleep(8000);
  check('a second run while one is going', 74, await harness('sleeper'));
  const stopped = await h.call('stop.all');
  check('the first run, ended by Stop All', 70, await long);
  check('a run of the grant Stop All paused', 75, await harness('sleeper'));
  console.log(`  stop.all: ${JSON.stringify(stopped)}; statuses ${JSON.stringify((await h.call('standing.list')).map((/** @type {any} */ s) => [s.id, s.status]))}`);

  await h.call('standing.resume', { id: 'nightly' });
  await h.call('grant.add', { identity: ID, resource: 'net:registry.npmjs.org:443', permission: 'connect' });
  check('a run after the identity got another grant', 72, await harness('nightly'));
  await h.call('standing.update', { id: 'nightly' });
  await h.call('standing.revoke', { id: 'sleeper' });
  await grant('quick', 'cmd.exe /d /c exit 0');
  check('a run after the operator approved again', 0, await harness('quick'));

  await grant('brief', 'cmd.exe /d /c exit 0', 10, new Date(Date.now() + 8000).toISOString());
  await sleep(10_000);
  check('a run after the grant expired', 73, await harness('brief'));

  await grant('budget', sleepCmd(150), 1);
  const t0 = Date.now();
  const timed = await harness('budget');
  check(`a run past its 1-minute budget (${Math.round((Date.now() - t0) / 1000)} s)`, 71, timed);

  const empty = path.join(h.root, 'no-core');
  fs.mkdirSync(empty, { recursive: true });
  check('a run with no Core to ask', 69, await harness('nightly', empty));
  check('no grant by that name', 72, await harness('nope'));
} finally {
  await h.close();
  fs.rmSync(h.root, { recursive: true, force: true });
  fs.rmSync(h.data, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(h.data), 'houston-agents', 'h4-nightly'), { recursive: true, force: true });
}

console.log('\nrun                                            want  got   last line');
for (const [what, want, got, line] of rows) console.log(`${what.padEnd(46)} ${String(want).padEnd(5)} ${String(got).padEnd(5)} ${line}`);
const bad = rows.filter(([, want, got]) => want !== got);
console.log(bad.length ? `\n${bad.length} run(s) gave the wrong exit code` : `\nall ${rows.length} runs gave the exit code they should`);
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(bad.length ? 1 : 0);
