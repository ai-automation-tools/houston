// H1 check (run by hand from PowerShell): a Core that dies mid-session leaves no container
// running once the next Core starts (AT-16). Two ways to die: killed while the session runs,
// and crashed right after the spawn (the one that left wxc-exec.exe and cmd.exe behind).
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h1-dead-core.mjs
// It works in a houston-dead-core-check subfolder there, wiped first.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../core/main.js';
import { containerName, createRunner, listBrokers } from '../core/runner.js';

if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ROOT = path.join(process.env.H1_ROOT, 'houston-dead-core-check');
const [, , role, mode] = process.argv;

if (role === 'core') {
  // The Core that dies. 'kill': waits to be killed. 'crash': exits as soon as the container is spawned.
  const WS = path.join(ROOT, 'ws');
  const core = start(path.join(ROOT, 'core'));
  const real = await import('@microsoft/mxc-sdk/v1');
  const sdk = { spawnWithPty: async (/** @type {any[]} */ ...a) => { const t = await real.spawnWithPty(...a); if (mode === 'crash') process.exit(1); return t; } };
  const runner = createRunner({ db: core.db, audit: core.audit, coreDir: core.dir, tempRoot: path.join(ROOT, 'sessions'), sdk });
  const s = await runner.start({ identity: 'local:dev-shell', workspace: WS, command: 'cmd.exe /d /q /k prompt $G', size: { rows: 30, columns: 120 } });
  s.output.on('data', () => {});
  console.log(`READY ${s.id}`);
  setInterval(() => {}, 2 ** 30);
} else {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'ws'), { recursive: true });
  const core = start(path.join(ROOT, 'core'));
  const at = new Date().toISOString();
  core.db.exec(`INSERT INTO identities (id, kind, display_name, containment, created_at, status) VALUES ('local:operator', 'operator', 'Operator', 'unconfined', '${at}', 'active');
    INSERT INTO identities (id, kind, display_name, owner, containment, created_at, status) VALUES ('local:dev-shell', 'ai-agent', 'Dev shell', 'local:operator', 'container', '${at}', 'active');`);
  core.db.prepare("INSERT INTO grants (id, identity_id, resource, permission, effect, granted_at, granted_by) VALUES ('ws', 'local:dev-shell', ?, 'write', 'allow', ?, 'local:operator')")
    .run(`file:${path.join(ROOT, 'ws').replaceAll('\\', '/')}/**`, at);
  core.close();

  const ps = (/** @type {string} */ cmd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const children = (/** @type {number} */ pid) => ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`).split(/\s+/).filter(Boolean).map(Number);
  const alive = (/** @type {number[]} */ pids) => pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

  for (const how of ['kill', 'crash']) {
    const before = new Set(listBrokers().map((b) => b.pid));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'core', how], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('exit', r));
    // Wait for the session (kill) or the crash, then for the container to settle.
    for (let i = 0; i < 60 && !/READY/.test(out) && child.exitCode === null; i++) await sleep(500);
    if (how === 'kill') child.kill();
    await exited;
    await sleep(4000);

    const left = listBrokers().filter((b) => !before.has(b.pid));
    const contained = left.flatMap((b) => children(b.pid));
    const restart = start(path.join(ROOT, 'core'));
    const ended = [...restart.audit.events()].filter((e) => e.type === 'session.end' && restart.interrupted.includes(e.session_id));
    restart.close();
    await sleep(2000);
    const still = alive([...left.map((b) => b.pid), ...contained]);
    console.log(`--- ${how}: Core exit ${how === 'kill' ? 'killed' : child.exitCode} ---`);
    console.log(`left running before restart: ${left.length} broker(s), ${contained.length} contained process(es); names match a session: ${left.every((b) => restart.interrupted.some((id) => containerName(id) === b.containerId))}`);
    for (const e of ended) console.log(`restart: session.end ${e.outcome.error_code}: ${e.decision.reasons[0]}`);
    console.log(`still running after restart: ${still.length}`);
  }
}
