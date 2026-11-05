// `node scripts/mcp-stdio.js`: Houston's MCP server over stdio, for any MCP client
// (Claude Code, Codex, opencode, Antigravity) started anywhere, not only in the app's
// terminals. Each JSON-RPC line on stdin is POSTed to the URL in the app's mcp.json with
// its token, and the reply goes to stdout. mcp.json is read per message, so restarting
// the app (new port, new token) needs no client restart. HOUSTON_MCP_JSON overrides the
// file's path. A modern (2026-07-28) request's _meta goes into the headers HTTP wants
// mirrored, and the Mcp-Session-Id the app gives at initialize goes back on every later
// request, so the MCP tab names the client on each call. While the app is closed the
// bridge answers itself: the handshake and the tool list as usual, so a client lists the
// server as connected, and every tool call with "Houston isn't running". Never write
// anything but replies to stdout.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { checkRequest, handleMessage, mirrorHeaders } from '../src/shared/mcp.js';
import { allTools } from '../src/shared/tools.js';

const infoFile = process.env.HOUSTON_MCP_JSON || path.join(process.env.APPDATA || '', 'ai-command-center', 'mcp.json');
const NOT_RUNNING = "Houston isn't running. Start the app, then retry.";
// The real tools' names and schemas over sources that all refuse, for answering offline.
const offlineTools = allTools(/** @type {any} */ (new Proxy({}, { get: () => () => { throw new Error(NOT_RUNNING); } })));
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
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
    return offline(msg);
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

/**
 * Answers a message with the app closed, the way the app would, but every tool fails.
 * @param {any} msg
 */
async function offline(msg) {
  const headers = Object.fromEntries(Object.entries(mirrorHeaders(msg)).map(([k, v]) => [k.toLowerCase(), v]));
  const { modern, reject } = checkRequest(msg, headers);
  const out = reject ? reject.out : await handleMessage(msg, offlineTools, version, undefined, modern);
  if (out) send(out);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim()) forward(line); })
  // The client went away: drop what's in flight, which withdraws any confirm bar it was waiting on.
  .on('close', () => { closed = true; for (const r of pending) r.destroy(); });
