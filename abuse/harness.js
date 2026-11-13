// The abuse suite's harness: a real Core (`node core/main.js`) in a scratch data folder, driven
// over its Control API, with one agent identity whose sessions run attack scripts in real
// containers. Each attempt saves its stdout, stderr and exit code in the workspace, and the
// test reads them from the host side. Contents read from protected places are only ever
// checked for a planted token or counted, never kept or printed.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callControl } from '../core/control.js';
import { containerName, listBrokers } from '../core/runner.js';

export const AGENT = 'local:abuse-agent';
const MAIN = fileURLToPath(new URL('../core/main.js', import.meta.url));
export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
export const token = () => `HOUSTON-ABUSE-${crypto.randomBytes(12).toString('hex')}`;

/**
 * @typedef {{ name: string, result: 'blocked' | 'got through' | 'inconclusive' | 'observed', evidence: string }} Attempt
 * @typedef {{ id: string, title: string, pass: boolean, attempts: Attempt[], notes: string[] }} Result
 */

/**
 * The batch lines for one attempt: run it, keep stdout, stderr and the exit code as <n>.out/.err/.code.
 * The parentheses matter: a redirection inside them that fails (`more < "denied"`) reports its
 * error into <n>.err and sets the exit code, instead of skipping the command silently.
 * @param {string} n @param {string} command
 */
export const attempt = (n, command) => [`(${command}) > ${n}.out 2> ${n}.err`, `echo %errorlevel%> ${n}.code`];

/** Remove links in a folder without following them, then the folder. Never recursive through a link. @param {string} dir */
export function removeDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } } else if (st.isDirectory()) removeDir(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

/**
 * @param {{ root: string, data: string }} where root: a scratch folder outside the profile; data: the Core's data folder (inside the profile, as a real one is)
 */
export async function createHarness({ root, data }) {
  for (const d of [root, data]) removeDir(d);
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const env = { ...process.env, HOUSTON_CORE_DATA: data, HOUSTON_SESSION_TEMP: path.join(root, 'sessions') };
  /** @type {{ proc: import('node:child_process').ChildProcess, started: any, stderr: () => string } | null} */
  let core = null;
  const call = (/** @type {string} */ method, /** @type {object} */ params = {}) => callControl(data, method, params, { timeoutMs: 60_000 });

  const h = {
    root, ws, data, home: os.homedir(), call,

    async startCore() {
      const proc = spawn(process.execPath, [MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      proc.stdout.on('data', (c) => { out += c; });
      proc.stderr.on('data', (c) => { err += c; });
      for (let i = 0; i < 120 && !out.includes('\n') && proc.exitCode === null; i++) await sleep(250);
      if (!out.includes('\n')) throw new Error(`the Core did not start: ${err}`);
      core = { proc, started: JSON.parse(out.split('\n')[0]), stderr: () => err };
      return core;
    },

    /** TerminateProcess, as a crash or Task Manager would. */
    async killCore() {
      if (!core) return;
      const { proc } = core;
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await exited;
      core = null;
    },

    /** The token the running Core accepts (the operator's). */
    controlToken: () => JSON.parse(fs.readFileSync(path.join(data, 'control.json'), 'utf8')).token,

    /**
     * Start a session that runs `lines` as a batch file in its own folder in the workspace.
     * @param {string} name @param {string[]} lines @param {{ keepOpen?: boolean }} [opts] keepOpen: end with an idle shell instead of exiting
     */
    async startScript(name, lines, { keepOpen = false } = {}) {
      const dir = path.join(ws, name);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'run.cmd');
      fs.writeFileSync(file, ['@echo off', `cd /d "${dir}"`, ...lines, keepOpen ? 'cmd.exe /d /q /k' : 'exit /b 0', ''].join('\r\n'));
      const s = await call('session.start', { identity: AGENT, workspace: ws, command: `cmd.exe /d /c "${file}"` });
      return { session: s.id, dir };
    },

    /** Wait for a session's session.end event. @param {string} id @param {number} [timeoutMs] */
    async waitEnd(id, timeoutMs = 180_000) {
      for (const until = Date.now() + timeoutMs; Date.now() < until; await sleep(500)) {
        const e = (await call('audit.query', { type: 'session.end', session_id: id })).events[0];
        if (e) return e;
      }
      throw new Error(`session ${id} did not end in ${timeoutMs} ms`);
    },

    /** Run a script session to its end and return a reader for its attempts. @param {string} name @param {string[]} lines */
    async runScript(name, lines) {
      const { session, dir } = await h.startScript(name, lines);
      const end = await h.waitEnd(session);
      return { session, end, dir, result: (/** @type {string} */ n) => h.result(dir, n) };
    },

    /** @param {string} dir @param {string} n */
    result(dir, n) {
      const read = (/** @type {string} */ ext) => { const p = path.join(dir, `${n}.${ext}`); return fs.existsSync(p) ? fs.readFileSync(p, 'latin1') : null; };
      const code = read('code');
      return { ran: code !== null, code: code === null ? null : Number(code.trim()), out: read('out') ?? '', err: (read('err') ?? '').trim() };
    },

    /** The session.start event for a session (it carries the launch). @param {string} id */
    async startEvent(id) {
      return (await call('audit.query', { type: 'session.start', session_id: id })).events[0];
    },

    /** Every process on the machine, with parent, creation time and command line. */
    processes() {
      const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const q = "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; created = [string]$_.CreationDate; cmd = $_.CommandLine } })";
      const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`listing processes failed: ${r.stderr}`);
      return /** @type {{ pid: number, ppid: number, name: string, created: string, cmd: string | null }[]} */ (JSON.parse(r.stdout));
    },

    /**
     * The broker of each session and every process under it, plus any process whose command
     * line has `marker`. Identity is pid plus creation time, so a reused pid doesn't count.
     * @param {string[]} sessions @param {string} [marker]
     */
    sessionProcesses(sessions, marker) {
      const all = h.processes();
      const names = new Set(sessions.map(containerName));
      const roots = listBrokers().filter((b) => names.has(b.containerId ?? '')).map((b) => b.pid);
      const found = new Map();
      const add = (/** @type {number} */ pid) => {
        for (const p of all.filter((x) => x.pid === pid || x.ppid === pid)) {
          const key = `${p.pid}@${p.created}`;
          if (found.has(key)) continue;
          found.set(key, p);
          if (p.pid !== pid) add(p.pid);
        }
      };
      roots.forEach(add);
      if (marker) for (const p of all.filter((x) => x.cmd?.includes(marker))) found.set(`${p.pid}@${p.created}`, p);
      return [...found.values()];
    },

    /** Which of these processes are still running. @param {{ pid: number, created: string }[]} list */
    alive(list) {
      const now = new Set(h.processes().map((p) => `${p.pid}@${p.created}`));
      return list.filter((p) => now.has(`${p.pid}@${p.created}`));
    },

    async close() {
      try { if (core) await call('stop.all'); } catch { /* already down */ }
      await h.killCore();
    },
  };
  return h;
}

/** Replace what would identify the machine or its owner. @param {{ root: string, data: string, home: string }} h @param {string} s */
export function anonymize(h, s) {
  let out = String(s);
  const swaps = [[h.data, '<core-data>'], [h.root, '<root>'], [h.home, '%USERPROFILE%'], [process.env.LOCALAPPDATA ?? '\0', '%LOCALAPPDATA%'],
    [os.userInfo().username, '<user>'], [process.env.COMPUTERNAME ?? '\0', '<machine>']];
  for (const [from, to] of swaps) {
    if (!from || from === '\0') continue;
    out = out.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to);
    const fwd = from.replaceAll('\\', '/');
    if (fwd !== from) out = out.replace(new RegExp(fwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to.replaceAll('\\', '/'));
  }
  return out;
}

/** The first line of an error, short. @param {string} s */
export const firstLine = (s) => (s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 120);
