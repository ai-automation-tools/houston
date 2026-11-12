// Spike S3, part 2b (throwaway): a signed-in agent CLI does a real task inside a container,
// with a stub MCP server over stdio. The container gets the workspace, a temp folder, the
// toolchain, the CLI's program folder (read-only) and the CLI's own config folder (read-write).
// Nothing else in the user profile is granted. Owner approved granting the two config folders
// for this test on 2026-11-12.
// Usage (PowerShell): node spikes/s3c-cli-task.mjs claude|codex [--preflight]
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { spawn } from '@microsoft/mxc-sdk/v1';

const which = process.argv[2];
const preflight = process.argv.includes('--preflight');
const home = os.homedir();
const ROOT = `D:\\AI_Agents\\_maintenance\\tmp\\houston-s3c\\${which}`;
const WS = path.join(ROOT, 'ws');
const TMP = path.join(ROOT, 'tmp');
if (!preflight) rmSync(ROOT, { recursive: true, force: true });
mkdirSync(WS, { recursive: true }); mkdirSync(TMP, { recursive: true });
if (!existsSync(path.join(WS, '.git'))) execSync('git init -q', { cwd: WS, stdio: 'ignore' });

// A stub MCP server: newline-delimited JSON-RPC on stdio, one tool, every call logged.
writeFileSync(path.join(WS, 'stub-mcp.mjs'), `
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0.0.1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'stamp', description: 'Returns a receipt string for the given note. Call it once when the task is finished.', inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } }] } });
  if (m.method === 'tools/call') { appendFileSync('mcp-calls.log', JSON.stringify(m.params) + '\\n'); return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'RECEIPT-' + String(m.params?.arguments?.note ?? '').length + '-7Q' }] } }); }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
});
`);
writeFileSync(path.join(WS, 'mcp.json'), JSON.stringify({ mcpServers: { stub: { command: 'node', args: ['stub-mcp.mjs'] } } }));

const TASK = preflight ? 'Reply with the single word READY.' : [
  'Work only in the current folder. Do all of the following, in order:',
  '1. Write tablefmt.mjs exporting formatTable(markdown): it takes a GitHub-flavoured markdown table as a string and returns it with every column padded to the same width, the separator row rebuilt, and :--- / :---: / ---: alignment honoured.',
  '2. Write tablefmt.test.mjs using node:test with at least 8 tests, including alignment, a ragged row, escaped pipes and non-ASCII text.',
  '3. Run `node --test` and fix the code until every test passes.',
  '4. Write cli.mjs that formats a file given as argv[2] in place, and a README.md that explains usage.',
  '5. Run `git add -A` and `git -c user.name=spike -c user.email=spike@example.invalid commit -m "tablefmt"`.',
  '6. Call the MCP tool `stamp` from the `stub` server with note "finished", and write the exact text it returns into RESULT.md.',
  'Then say DONE.',
].join('\n');
writeFileSync(path.join(WS, 'TASK.txt'), TASK);

const claudeDir = path.join(home, '.local', 'bin');
const npmGlobal = path.join(home, 'AppData', 'Roaming', 'npm');
const CLI = {
  claude: {
    program: [claudeDir],
    config: path.join(home, '.claude'),
    env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe', DISABLE_AUTOUPDATER: '1' },
    // User settings (hooks, plugins) are skipped; the container is the permission boundary.
    command: `"${path.join(claudeDir, 'claude.exe')}" -p "Read TASK.txt and do exactly what it says." --dangerously-skip-permissions --strict-mcp-config --mcp-config mcp.json --setting-sources project --output-format json`,
  },
  codex: {
    program: [path.join(npmGlobal, 'node_modules', '@openai')],
    config: path.join(home, '.codex'),
    env: { CODEX_HOME: path.join(home, '.codex') },
    // The native program, not the Node wrapper: Node cannot start a script that sits under a
    // denied folder (it lstats every parent), a native program can.
    command: `"${path.join(npmGlobal, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')}" exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -c mcp_servers.stub.command="node" -c "mcp_servers.stub.args=['stub-mcp.mjs']" "Read TASK.txt and do exactly what it says."`,
  },
}[which];

const denyUsers = !process.argv.includes('--no-deny');
const t0 = performance.now();
const proc = await spawn({
  command: CLI.command,
  workingDirectory: WS,
  environment: {
    TEMP: TMP, TMP: TMP, npm_config_cache: path.join(TMP, 'npm-cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(TMP, 'gitconfig'),
    PATH: ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin', 'C:\\Program Files\\nodejs', 'C:\\Python312', 'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';'),
    ...CLI.env,
  },
  inheritDefaultEnvironment: true,
  timeoutMs: preflight ? 120_000 : 20 * 60_000,
  filesystem: {
    readwritePaths: [WS, TMP, CLI.config],
    readonlyPaths: ['C:\\Program Files\\Git', 'C:\\Program Files\\nodejs', 'C:\\Python312', ...CLI.program],
    ...(denyUsers ? { deniedPaths: ['C:\\Users'] } : {}),
  },
  network: { egress: { default: 'allow' } }, // internet yes; loopback and LAN stay blocked (S2, variant B)
  ui: { disable: false },
  containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: denyUsers ? ['C:\\', 'D:\\'] : ['D:\\'] } } },
});
let out = '', err = '';
proc.standardInput?.end();
proc.standardOutput?.on('data', (c) => { out += c; });
proc.standardError?.on('data', (c) => { err += c; });
const res = await proc.wait();
proc.dispose();
const minutes = +((performance.now() - t0) / 60000).toFixed(1);
const anon = (s) => s.replaceAll(home, '%USERPROFILE%');
const read = (f) => (existsSync(path.join(WS, f)) ? readFileSync(path.join(WS, f), 'utf8').trim() : null);
let tests = null, commits = null;
if (!preflight) {
  try { tests = execSync('node --test', { cwd: WS, encoding: 'utf8' }).split('\n').filter((l) => /^ℹ (tests|pass|fail) /.test(l)).join(' '); } catch (e) { tests = 'FAILED: ' + String(e.stdout ?? e.message).slice(-300); }
  try { commits = execSync('git log --oneline', { cwd: WS, encoding: 'utf8' }).trim(); } catch { commits = 'none'; }
}
console.log(JSON.stringify({
  cli: which, preflight, exit: res, minutes,
  files: readdirSync(WS).filter((f) => !f.startsWith('.')),
  hostRerunOfTests: tests, commits,
  mcpCalls: read('mcp-calls.log'), resultMd: read('RESULT.md'),
  stdoutTail: anon(out.trim().slice(-700)), stderrTail: anon(err.trim().slice(-700)),
}, null, 2));
process.exit(0);
