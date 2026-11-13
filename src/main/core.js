// Houston's client for the Core, the harness's background process (core/README.md): calls over
// its Control API. The data folder and control.json are read at every call, so a Core started
// or restarted after the app is found without restarting the app.

import { callControl, dataDir } from '../../core/client.js';

export const core = {
  /**
   * @param {string} method a Control API method (core/control.js METHODS)
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} the result; rejects with the Core's error code, or ENOENT when it isn't running
   */
  call: (method, params = {}, timeoutMs = 10_000) => callControl(dataDir(), method, params, { timeoutMs }),

  /**
   * For the Connections row: the Core's status, or why there isn't one. Null off Windows,
   * where the Core serves no Control API (sessions are Windows containers).
   * @returns {Promise<{ pid: number, startedAt: string, schema: number, containment: string, sessions: number } | { error: string, code?: string } | null>}
   */
  async status() {
    if (process.platform !== 'win32') return null;
    try {
      return await core.call('core.status', {}, 3000);
    } catch (e) {
      const err = /** @type {Error & { code?: string }} */ (e);
      return { error: err.message, code: err.code };
    }
  },
};
