// `node scripts/mcp-stdio.js`: Houston's MCP server over stdio, for any MCP client
// (Claude Code, Codex, opencode, Antigravity) started anywhere, not only in the app's
// terminals. Each JSON-RPC line on stdin is POSTed to the URL in the app's mcp.json with
// its token, and the reply goes to stdout. mcp.json is read per message, so restarting
// the app (new port, new token) needs no client restart. HOUSTON_MCP_JSON overrides the
// file's path. A modern (2026-07-28) request's _meta goes into the headers HTTP wants
// mirrored, and the Mcp-Session-Id the app gives at initialize goes back on every later
// request, so the MCP tab names the client on each call. Never write anything but
// replies to stdout.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { mirrorHeaders } from '../src/shared/mcp.js';

const infoFile = process.env.HOUSTON_MCP_JSON || path.join(process.env.APPDATA || '', 'ai-command-center', 'mcp.json');
/** @type {Set<http.ClientRequest>} */
const pending = new Set();
let closed = false;
// The app's session id for this client, with the token it came under: a restarted app
// has a new token and doesn't know the old id.
let session = { token: '', id: '' };

/** @param {unknown} msg */
const send = (msg) => closed || process.stdout.write(`${JSON.stringify(msg)}\n`);

/** @param {string} line */
function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const id = msg && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : undefined;
  /** @param {string} message */
  const fail = (message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };
  let info;
  try {
    info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  } catch {
    return fail("Houston isn't running (no mcp.json). Start the app, then retry.");
  }
  const body = Buffer.from(line);
  // node:http, not fetch: fetch gives up on headers after 300 s, and terminal_run waits
  // up to 5 minutes for the user's click.
  const req = http.request(info.url, {
    method: 'POST',
    headers: { ...mirrorHeaders(msg), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${info.token}`, 'Content-Length': body.length,
      ...(session.id && session.token === info.token && { 'Mcp-Session-Id': session.id }) },
  }, (res) => {
    const sid = res.headers['mcp-session-id'];
    if (typeof sid === 'string') session = { token: info.token, id: sid };
    /** @type {Buffer[]} */
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      pending.delete(req);
      if (res.statusCode === 202) return;
      try {
        const out = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (out && out.jsonrpc === '2.0') return send(out);
      } catch { /* fall through */ }
      fail(`Houston answered HTTP ${res.statusCode}`);
    });
  });
  req.on('error', () => { pending.delete(req); fail("Houston isn't answering. Is the app running?"); });
  pending.add(req);
  req.end(body);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim()) forward(line); })
  // The client went away: drop what's in flight, which withdraws any confirm bar it was waiting on.
  .on('close', () => { closed = true; for (const r of pending) r.destroy(); });
