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
  /**
   * Put this app's own MCP server behind the Core's gateway (H3): registered once as the http
   * server `houston`. Its address and token change at every start, so both are refreshed here;
   * the token goes to the vault as `houston-mcp`, never into the registration. The operator
   * still installs and pins it before a session sees its tools. A smoke run's throwaway app
   * stays out of it. True once the Core has it.
   * @param {{ url: string, token: string }} m
   */
  async offerMcp(m) {
    if (process.platform !== 'win32' || process.env.ACC_SMOKE_DIR) return false;
    try {
      const reg = await core.call('mcp.get', { name: 'houston' }).catch((e) => { if (e.code === 'not_found') return null; throw e; });
      await core.call('secret.set', { name: 'houston-mcp', value: m.token });
      if (!reg) {
        await core.call('mcp.add', { name: 'houston', transport: 'http', url: m.url, env: { Authorization: 'Bearer secret:houston-mcp' } });
        await core.call('grant.add', { identity: 'local:mcp/houston', resource: 'secret:houston-mcp', permission: 'use' });
      } else if (reg.url !== m.url) {
        await core.call('mcp.update', { name: 'houston', url: m.url });
      }
      return true;
    } catch {
      return false;
    }
  },

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
