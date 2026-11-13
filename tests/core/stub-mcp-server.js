// A tiny stdio MCP server for the gateway tests and the abuse suite. Tools:
//   echo { text }      -> the text back
//   env { name }       -> the value of an environment variable (to show what was injected)
//   big { bytes }      -> that many x's
// STUB_ECHO_DESC changes echo's description, so its tool list hashes differently (AT-08).
// STUB_CALLS, when set, is a file each tools/call appends a line to, so a test can see the server was never called.
import fs from 'node:fs';
import readline from 'node:readline';

const tools = [
  { name: 'echo', description: process.env.STUB_ECHO_DESC ?? 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'env', description: 'Read one environment variable.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'big', description: 'A long text result.', inputSchema: { type: 'object', properties: { bytes: { type: 'number' } } } },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

// A server that logs to stdout before it starts: the gateway skips lines that aren't JSON.
process.stdout.write('stub server starting\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  let m;
  try { m = JSON.parse(line); } catch { continue; }
  if (m.id === undefined) continue;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    if (process.env.STUB_CALLS) fs.appendFileSync(process.env.STUB_CALLS, `${m.params.name}\n`);
    const a = m.params.arguments ?? {};
    const out = m.params.name === 'echo' ? text(String(a.text ?? ''))
      : m.params.name === 'env' ? text(String(process.env[a.name] ?? '(unset)'))
        : m.params.name === 'big' ? text('x'.repeat(Number(a.bytes) || 0))
          : null;
    send(out ? { jsonrpc: '2.0', id: m.id, result: out } : { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } });
  } else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
}
