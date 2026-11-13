// Call the running Core's Control API from a terminal. The window calls it through src/main/core.js.
//   node core/ctl.js <method> [key=value ...]       or   node core/ctl.js <method> '<JSON params>'
//   npm run ctl -- identity.create id=local:dev-shell kind=ai-agent displayName="Dev shell"
// A value that parses as JSON (a number, true, ["a","b"]) is taken as JSON, anything else as text.
import { callControl, dataDir } from './client.js';

const [method, ...args] = process.argv.slice(2);
if (!method) {
  console.error('usage: node core/ctl.js <method> [key=value ...] | [JSON params]   e.g. identity.list, session.list');
  process.exit(1);
}

/** @returns {Promise<string>} one line from stdin; typed without echo when it's a terminal */
async function readValue() {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const c of process.stdin) text += c;
    return text.replace(/\r?\n$/, '');
  }
  process.stderr.write('Value (not shown), then Enter: ');
  process.stdin.setRawMode(true);
  let text = '';
  let done = false;
  // A paste arrives as one chunk, Enter included.
  for await (const c of process.stdin) {
    for (const ch of c.toString('utf8')) {
      if (ch === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
      if (ch === '\r' || ch === '\n') { done = true; break; }
      text = ch === '\b' || ch === '\x7f' ? text.slice(0, -1) : text + ch;
    }
    if (done) break;
  }
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stderr.write('\n');
  return text;
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
  // A secret's value never goes on the command line (history, process lists): it's read from
  // stdin, piped or typed with no echo.  Get-Content token.txt | npm run ctl -- secret.set name=github-token
  if (method === 'secret.set' && params.value === undefined) params.value = await readValue();
  console.log(JSON.stringify(await callControl(dataDir(), method, params), null, 2));
} catch (e) {
  const err = /** @type {Error & { code?: string }} */ (e);
  console.error(err.code === 'ENOENT' ? 'the Core is not running (no control.json in its data folder)' : `${err.code ?? 'error'}: ${err.message}`);
  process.exit(1);
}
