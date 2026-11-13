// A broad-access session's terminal (H5): the command on the host, unconfined, in a ConPTY, with
// the same shape as the container SDK's PTY process so the runner treats both alike. Ending it
// ends the whole process tree. Nothing here contains anything: the identity says so everywhere.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

/**
 * @param {{ command: string, cwd: string, env: Record<string, string>, size?: { rows: number, columns: number }, pty?: any }} o
 *   pty: node-pty, for tests
 */
export async function spawnHostPty({ command, cwd, env, size, pty }) {
  const lib = pty ?? (await import('node-pty')).default;
  const sys = process.env.SystemRoot ?? 'C:\\Windows';
  // One command line, as cmd reads it: /s keeps the quotes inside the outer pair.
  const p = lib.spawn(path.win32.join(sys, 'System32', 'cmd.exe'), `/d /s /c "${command}"`, {
    name: 'xterm-256color', cols: size?.columns ?? 120, rows: size?.rows ?? 30, cwd, env,
    // The bundled conpty.dll: without it node-pty's console-list helper keeps the process alive (src/main/terminal.js).
    useConpty: true, useConptyDll: true,
  });
  const output = new PassThrough();
  p.onData((/** @type {string} */ d) => output.write(d));
  /** @type {Promise<{ exitCode: number, timedOut: boolean }>} */
  const exited = new Promise((resolve) => p.onExit((/** @type {{ exitCode: number }} */ e) => { output.end(); resolve({ exitCode: e.exitCode, timedOut: false }); }));
  const input = new Writable({
    write(chunk, _enc, cb) {
      try { p.write(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); cb(); } catch (e) { cb(/** @type {Error} */ (e)); }
    },
  });
  let killed = false;
  return {
    pid: p.pid, input, output,
    wait: () => exited,
    resize: (/** @type {{ rows: number, columns: number }} */ s) => { try { p.resize(s.columns, s.rows); } catch { /* exited */ } },
    kill() {
      if (killed) return;
      killed = true;
      // The tree, not just cmd: an agent CLI's children would outlive it.
      if (process.platform === 'win32' && p.pid) spawn(path.win32.join(sys, 'System32', 'taskkill.exe'), ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      try { p.kill(); } catch { /* already gone */ }
    },
    dispose() {},
  };
}
