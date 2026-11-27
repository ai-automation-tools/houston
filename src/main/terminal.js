// Shell sessions behind the xterm.js panel. The renderer can pick a starting folder
// and a profile from shared/shells.js by id, and nothing else: each profile's
// executable and arguments are fixed, so no message from a page can start a shell
// with chosen arguments (the rule from the Project Control Center's ADR-004).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { pickShell, runShell, shellProfiles } from '../shared/shells.js';
import { appendOutput } from '../shared/output.js';
import { RUN_SCRIPT } from '../shared/runs.js';
import { childEnv } from './env.js';
import { killTree } from './kill.js';

// node-pty stops a terminal's ConPTY output thread 1 s after the terminal ends
// (FLUSH_DATA_INTERVAL). A process that exits with one still running crashes with
// 0xC0000409, about 2 runs in 5 when it exits right after killing them (2026-11-27).
const PTY_DRAIN_MS = 1500;
let lastEnd = 0;
/** How long until every ended terminal's output thread has stopped; wait this long before exiting. */
export const ptyDrainMs = () => Math.max(0, lastEnd + PTY_DRAIN_MS - Date.now());

/** @param {unknown} dir */
function safeCwd(dir) {
  if (typeof dir === 'string' && dir) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch { /* fall through to home */ }
  }
  return os.homedir();
}

export class Terminals {
  /** @param {(channel: string, ...args: unknown[]) => void} send */
  constructor(send) {
    this.send = send;
    /** @type {Map<number, import('node-pty').IPty>} */
    this.sessions = new Map();
    /** What list_terminals reports; kept after exit until the UI closes the tab. */
    /** @type {Map<number, { id: number, shell: string, profile: string, cwd: string, powershell: boolean, exited: boolean, ws: string, run: boolean, agent?: string, session?: string }>} */
    this.meta = new Map();
    /** Hears every session's exit with its code; main hands it to the runs. @type {(id: number, exitCode: number) => void} */
    this.onExit = () => {};
    /** Raw pty output per session, newest OUTPUT_MAX_CHARS, for terminal_read. */
    /** @type {Map<number, string>} */
    this.output = new Map();
    /** The session the UI shows, as it reports it; terminal_read's default. */
    /** @type {number | null} */
    this.activeId = null;
    this.nextId = 1;
    /** @type {Record<string, string>} set once the MCP server is up: ACC_MCP_URL and ACC_MCP_TOKEN */
    this.env = {};
    this.profiles = shellProfiles(process.env, (f) => fs.existsSync(f));
    this.shell = this.profiles[0].file;
  }

  /** Look for the shells again, so one installed since the app started shows up without a restart. */
  rescanShells() {
    this.profiles = shellProfiles(process.env, (f) => fs.existsSync(f));
    return this.list();
  }

  /** The installed shells, for the new-terminal menu. */
  list() {
    return this.profiles.map(({ id, label, powershell }) => ({ id, label, powershell }));
  }

  /**
   * @param {{ cwd?: string, cols?: number, rows?: number, shell?: string, ws?: string, run?: string }} opts
   *   ws: the workspace it opens in; run: a confirmed terminal_run command, which main passes
   *   and no IPC message can: the session runs that and ends (shared/runs.js RUN_SCRIPT)
   * @returns {{ id: number, cwd: string, shell: string, profile: string, powershell: boolean, ws: string, run: boolean }}
   */
  create(opts = {}) {
    const cwd = safeCwd(opts.cwd);
    const id = this.nextId++;
    const run = typeof opts.run === 'string';
    const profile = run ? runShell(this.profiles, RUN_SCRIPT) : pickShell(this.profiles, opts.shell);
    const p = pty.spawn(profile.file, profile.args, {
      name: 'xterm-256color',
      cols: clamp(opts.cols, 20, 500, 100),
      rows: clamp(opts.rows, 5, 200, 30),
      cwd,
      env: childEnv(process.env, { TERM_PROGRAM: 'ai-command-center', ...this.env, ...(run && { ACC_RUN_COMMAND: /** @type {string} */ (opts.run) }) }),
      useConpty: true,
      // The bundled conpty.dll path kills without forking node-pty's console-list helper,
      // which crashes (AttachConsole failed) and keeps the app alive when it quits.
      useConptyDll: true,
    });
    p.onData((data) => this.data(id, data));
    p.onExit(({ exitCode }) => this.exited(id, exitCode));
    this.sessions.set(id, p);
    const info = { id, cwd, shell: path.basename(profile.file), profile: profile.id, powershell: profile.powershell, ws: opts.ws || '', run };
    this.meta.set(id, { ...info, exited: false });
    this.output.set(id, '');
    return info;
  }

  /**
   * A contained session the Core runs (agents.js), shown like any other terminal: typing and
   * resizing go to `remote`, and closing the tab calls `remote.kill`. Feed it with the returned
   * `data` and `exit`.
   * @param {{ write: (data: string) => void, resize: (cols: number, rows: number) => void, kill: () => void }} remote
   * @param {{ cwd: string, ws: string, agent: string, session: string }} about
   */
  adopt(remote, { cwd, ws, agent, session }) {
    const id = this.nextId++;
    this.sessions.set(id, /** @type {any} */ ({ pid: 0, ...remote }));
    const info = { id, cwd, shell: agent, profile: 'agent', powershell: false, ws, run: false, agent, session };
    this.meta.set(id, { ...info, exited: false });
    this.output.set(id, '');
    return {
      info,
      data: (/** @type {string} */ d) => this.data(id, d),
      exit: (/** @type {number | null} */ code, /** @type {string} */ reason) => this.exited(id, code ?? -1, reason),
    };
  }

  /** The terminal id showing a Core session, if one does. @param {string} session */
  bySession(session) {
    for (const m of this.meta.values()) if (m.session === session) return m.id;
    return undefined;
  }

  /** @param {number} id @param {string} data */
  data(id, data) {
    this.output.set(id, appendOutput(this.output.get(id) || '', data));
    this.send('term:data', id, data);
  }

  /** @param {number} id @param {number} exitCode @param {string} [reason] a contained session's end, shown in place of the code */
  exited(id, exitCode, reason) {
    lastEnd = Date.now();
    this.sessions.delete(id);
    const m = this.meta.get(id);
    if (m) m.exited = true;
    this.onExit(id, exitCode);
    this.send('term:exit', id, exitCode, reason);
  }

  /** Every session the UI still shows, oldest first, for list_terminals. */
  listSessions() {
    return [...this.meta.values()].map((m) => ({ ...m, active: m.id === this.activeId }));
  }

  /**
   * The raw output of a session: the one asked for, else the one the UI shows, else
   * the newest. Null when there's no such session.
   * @param {number} [id]
   */
  read(id) {
    const pick = id ?? (this.activeId !== null && this.meta.has(this.activeId) ? this.activeId : [...this.meta.keys()].pop());
    return pick === undefined ? null : { id: pick, raw: this.output.get(pick) ?? null };
  }

  /** @param {number} id what list_terminals reports for one session, or undefined */
  info(id) {
    return this.meta.get(id);
  }

  /**
   * Where terminal_run opens by default: the folder the active terminal started in, else
   * the workspace's folder, else home.
   * @param {string} [fallback]
   */
  defaultFolder(fallback) {
    return (this.activeId !== null && this.meta.get(this.activeId)?.cwd) || fallback || os.homedir();
  }

  /** The starting folders of a workspace's running terminals, oldest first. @param {string} ws */
  folders(ws) {
    return [...this.meta.values()].filter((m) => m.ws === ws && !m.exited).map((m) => m.cwd);
  }

  /** @param {number} id @param {string} data */
  write(id, data) {
    if (typeof data === 'string') this.sessions.get(id)?.write(data);
  }

  /** @param {number} id @param {number} cols @param {number} rows */
  resize(id, cols, rows) {
    const p = this.sessions.get(id);
    if (!p) return;
    try { p.resize(clamp(cols, 20, 500, 100), clamp(rows, 5, 200, 30)); } catch { /* exited mid-resize */ }
  }

  /** @param {number} id */
  kill(id) {
    const run = this.meta.get(id)?.run;
    this.meta.delete(id);
    this.output.delete(id);
    const p = this.sessions.get(id);
    if (!p) return;
    this.sessions.delete(id);
    // A run's command may have started programs of its own; end them with it.
    if (run) killTree(p.pid);
    lastEnd = Date.now();
    try { p.kill(); } catch { /* already gone */ }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} dflt */
function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
}
