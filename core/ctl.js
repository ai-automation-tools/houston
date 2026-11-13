// Call the running Core's Control API by hand, until the window does it (H2).
//   node core/ctl.js <method> [key=value ...]       or   node core/ctl.js <method> '<JSON params>'
//   npm run ctl -- identity.create id=local:dev-shell kind=ai-agent displayName="Dev shell"
// A value that parses as JSON (a number, true, ["a","b"]) is taken as JSON, anything else as text.
import { callControl, dataDir } from './client.js';

const [method, ...args] = process.argv.slice(2);
if (!method) {
  console.error('usage: node core/ctl.js <method> [key=value ...] | [JSON params]   e.g. identity.list, session.list');
  process.exit(1);
}

/** @type {Record<string, unknown>} */
let params = {};
try {
  if (args.length === 1 && args[0].trim().startsWith('{')) params = JSON.parse(args[0]);
  else for (const a of args) {
    const i = a.indexOf('=');
    if (i < 1) throw new Error(`'${a}' is not key=value`);
    const v = a.slice(i + 1);
    try { params[a.slice(0, i)] = JSON.parse(v); } catch { params[a.slice(0, i)] = v; }
  }
  console.log(JSON.stringify(await callControl(dataDir(), method, params), null, 2));
} catch (e) {
  const err = /** @type {Error & { code?: string }} */ (e);
  console.error(err.code === 'ENOENT' ? 'the Core is not running (no control.json in its data folder)' : `${err.code ?? 'error'}: ${err.message}`);
  process.exit(1);
}
