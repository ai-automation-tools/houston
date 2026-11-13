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
