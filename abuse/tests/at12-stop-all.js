// AT-12: Stop All with three sessions and a WMI-spawned child. Session 1 is an idle shell,
// session 2 a shell with a second shell started from it, session 3 asks WMI to start a process
// (which, if WMI does it, runs outside the container) and then idles. Pass: 5 seconds after
// stop.all, none of their processes is alive, the WMI one included.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { attempt, firstLine, removeDir, sleep, AGENT } from '../harness.js';

export const id = 'AT-12';
export const title = 'Stop All with three sessions and a WMI-spawned child';

/** @param {Awaited<ReturnType<typeof import('../harness.js').createHarness>>} h */
export async function run(h) {
  const marker = `HOUSTON-ABUSE-${crypto.randomBytes(6).toString('hex')}`;
  const child = `cmd.exe /d /c rem ${marker} & ping -n 600 127.0.0.1`;
  const ps = '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command';
  const s1 = await h.call('session.start', { identity: AGENT, workspace: h.ws, command: 'cmd.exe /d /q /k' });
  const s2 = await h.call('session.start', { identity: AGENT, workspace: h.ws, command: 'cmd.exe /d /c start "" /b cmd.exe /d /q /k & cmd.exe /d /q /k' });
  const s3 = await h.startScript('at12', [
    ...attempt('wmi', `${ps} "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${child}' }; 'ReturnValue=' + $r.ReturnValue + ' ProcessId=' + $r.ProcessId"`),
    ...attempt('wmi-legacy', `${ps} "$r = ([wmiclass]'Win32_Process').Create('${child}'); 'ReturnValue=' + $r.ReturnValue + ' ProcessId=' + $r.ProcessId"`),
  ], { keepOpen: true });
  const sessions = [s1.id, s2.id, s3.session];

  // Wait for session 3's WMI attempts to finish, then let the shells settle.
  for (let i = 0; i < 120 && !h.result(s3.dir, 'wmi-legacy').ran; i++) await sleep(500);
  await sleep(2000);
  const before = h.sessionProcesses(sessions, marker);
  const wmi = h.result(s3.dir, 'wmi');
  const legacy = h.result(s3.dir, 'wmi-legacy');
  const spawned = before.filter((p) => p.cmd?.includes(marker) && p.name.toLowerCase() === 'cmd.exe');

  const t0 = Date.now();
  const stopped = await h.call('stop.all');
  const took = Date.now() - t0;
  await sleep(Math.max(0, 5000 - took));
  const left = h.alive(before);
  // Never leave a WMI child running, whatever the result.
  for (const p of h.alive(h.sessionProcesses([], marker))) spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true });
  removeDir(s3.dir);

  const wmiSaid = (/** @type {{ code: number | null, out: string, err: string }} */ r) => (/ReturnValue=\d/.test(r.out) ? firstLine(r.out) : firstLine(r.err) || firstLine(r.out)) || `exit ${r.code}`;
  /** @type {import('../harness.js').Attempt[]} */
  const attempts = [
    { name: 'WMI Invoke-CimMethod Win32_Process.Create from session 3', result: /ReturnValue=0 /.test(wmi.out) ? 'got through' : 'blocked', evidence: wmiSaid(wmi) },
    { name: 'WMI [wmiclass] Win32_Process.Create from session 3', result: /ReturnValue=0 /.test(legacy.out) ? 'got through' : 'blocked', evidence: wmiSaid(legacy) },
    {
      name: 'every process of the three sessions gone 5 s after stop.all', result: left.length ? 'got through' : 'blocked',
      evidence: `stop.all stopped ${stopped.stopped} in ${took} ms; ${before.length} processes before (${spawned.length} started by WMI), ${left.length} alive after 5 s${left.length ? `: ${left.map((p) => p.name).join(', ')}` : ''}`,
    },
  ];
  const notes = [];
  if (spawned.length) notes.push('WMI started a process for a contained session. It ran outside the container, so only the 5-second check decides whether Stop All caught it.');
  // The WMI attempts are recorded, but AT-12's bar is the processes: nothing alive after 5 seconds.
  return { id, title, attempts, notes, pass: stopped.stopped === 3 && left.length === 0 };
}
