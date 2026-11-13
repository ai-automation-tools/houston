// The client side of the Control API: where the Core's data folder is, and one call to it.
// Its own file with nothing but node built-ins, so Houston's main process and `npm run ctl`
// can talk to the Core without loading the Core (its database, runner and SDK).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the Core keeps its state. Under the user profile on purpose: a session
 * container is denied the profile, so it cannot read this folder (abuse test AT-01).
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function dataDir(env = process.env) {
  const set = env.HOUSTON_CORE_DATA?.trim();
  if (set) {
    if (!path.isAbsolute(set)) throw new Error('HOUSTON_CORE_DATA must be an absolute path');
    return path.resolve(set);
  }
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'houston-core');
  return path.join(os.homedir(), '.houston-core');
}

/**
 * Attach to a running session's terminal: its recent output first, then everything it prints,
 * on a connection of its own. Detaching (`close`) leaves the session running.
 *
 * @param {string} dir the Core's data folder
 * @param {string} id the session
 * @param {{ onData: (data: string) => void, onEnd: (end: { reason: string, exitCode: number | null }) => void }} on
 *   onEnd: once, when the session ends or the connection closes (reason `detached`)
 * @returns {Promise<{ write: (input: string) => void, resize: (rows: number, columns: number) => void, close: () => void }>}
 * @throws {Error & { code?: string }} not_found for a session that isn't running; ENOENT when the Core isn't
 */
export function attachSession(dir, id, { onData, onEnd }) {
  return new Promise((resolve, reject) => {
    const { pipe, token } = JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
    const sock = net.connect(pipe);
    const line = (/** @type {object} */ m) => { if (!sock.destroyed && !sock.writableEnded) sock.write(`${JSON.stringify(m)}\n`); };
    let attached = false;
    let ended = false;
    const end = (/** @type {{ reason: string, exitCode: number | null }} */ e) => { if (!ended) { ended = true; onEnd(e); } };
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => line({ id: 1, token, method: 'session.attach', params: { id } }));
    sock.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!attached) {
          if (m.error) { sock.destroy(); return reject(Object.assign(new Error(m.error.message), { code: m.error.code })); }
          attached = true;
          resolve({
            write: (/** @type {string} */ input) => line({ input }),
            resize: (/** @type {number} */ rows, /** @type {number} */ columns) => line({ resize: { rows, columns } }),
            close: () => sock.end(),
          });
        } else if (typeof m.data === 'string') onData(m.data);
        else if (m.end) end(m.end);
      }
    });
    sock.on('error', (e) => { if (!attached) reject(e); });
    // The Core gone, or the connection closed: the terminal has nothing more to show.
    sock.on('close', () => { if (attached) end({ reason: 'detached', exitCode: null }); });
  });
}

/**
 * Call the Core's Control API once: read control.json from the data folder, send one request,
 * wait for its answer.
 *
 * @param {string} dir the Core's data folder
 * @param {string} method
 * @param {object} [params]
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any>} the result
 * @throws {Error & { code?: string }} the Core's error, with its code; ENOENT when the Core isn't running
 */
export function callControl(dir, method, params = {}, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    // Inside the promise, so a missing control.json rejects (ENOENT) instead of throwing.
    const { pipe, token } = JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, token, method, params })}\n`));
    sock.on('data', (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      const res = JSON.parse(buf.slice(0, i));
      if (res.error) reject(Object.assign(new Error(res.error.message), { code: res.error.code }));
      else resolve(res.result);
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
