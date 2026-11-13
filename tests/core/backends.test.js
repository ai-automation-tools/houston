import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BACKENDS, BackendError, gatewayArgs, listBackends, quote, resolveBackend } from '../../core/backends.js';

const where = { home: 'C:\\Users\\op', appData: 'C:\\Users\\op\\AppData\\Roaming', PATH: 'relative\\git;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32' };
const CLAUDE = 'C:\\Users\\op\\.local\\bin\\claude.exe';
const CODEX = 'C:\\Users\\op\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const GIT = ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'];
const on = (...files) => (p) => files.includes(p);
const opts = (isFile, identity = 'local:dev-claude') => ({ identity, agentsRoot: 'C:\\Users\\op\\AppData\\Local\\houston-agents', where, isFile });

test('claude-code: its own home, the program file read-only, Git Bash, no MCP servers', () => {
  const b = resolveBackend('claude-code', opts(on(CLAUDE, ...GIT)));
  const home = 'C:\\Users\\op\\AppData\\Local\\houston-agents\\dev-claude\\claude-code';
  assert.equal(b.command, `${CLAUDE} --strict-mcp-config`);
  assert.deepEqual(b.readwrite, [home]);
  assert.deepEqual(b.readonly, [CLAUDE, 'C:\\Program Files\\Git']);
  assert.deepEqual(b.pathDirs, ['C:\\Users\\op\\.local\\bin', 'C:\\Program Files\\Git\\cmd']);
  assert.equal(b.env.CLAUDE_CONFIG_DIR, home);
  assert.equal(b.env.CLAUDE_CODE_GIT_BASH_PATH, GIT[1]);
  assert.equal(b.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.deepEqual(b.hosts, ['api.anthropic.com:443', 'platform.claude.com:443']);
  // Never the operator's own config folder, which holds their MCP list and its tokens.
  assert.ok(![...b.readwrite, ...b.readonly].some((p) => /\\\.claude$/i.test(p)));
});

test('codex: the native program\'s folder, CODEX_HOME per identity, its own sandbox off', () => {
  const b = resolveBackend('codex', opts(on(CODEX), 'local:team/dev-codex'));
  const home = 'C:\\Users\\op\\AppData\\Local\\houston-agents\\team+dev-codex\\codex';
  assert.equal(b.command, `${CODEX} --sandbox danger-full-access -c check_for_update_on_startup=false -c analytics.enabled=false`);
  assert.deepEqual(b.readonly, [CODEX.replace(/\\codex\.exe$/, '')]);
  assert.deepEqual(b.env, { CODEX_HOME: home });
  assert.ok(b.hosts.includes('chatgpt.com:443'));
});

test('a program path with spaces is quoted', () => {
  const b = resolveBackend('codex', { ...opts(() => true), where: { ...where, appData: 'D:\\App Data' } });
  assert.match(b.command, /^"D:\\App Data\\npm\\.+\\codex\.exe" --sandbox/);
});

test('refusals: unknown backend, inherited names, not installed, no Git', () => {
  for (const name of ['gemini', 'constructor', '__proto__']) assert.throws(() => resolveBackend(name, opts(() => true)), (e) => e instanceof BackendError && /unknown backend/.test(e.message));
  assert.throws(() => resolveBackend('codex', opts(on())), /Codex is not installed/);
  assert.throws(() => resolveBackend('claude-code', opts(on(CLAUDE))), /needs Git for Windows/);
  // git.exe found but no bash.exe beside it.
  assert.throws(() => resolveBackend('claude-code', opts(on(CLAUDE, GIT[0]))), /needs Git for Windows/);
});

test('listBackends says which are installed', () => {
  assert.deepEqual(listBackends(where, on(CODEX)).map((b) => [b.name, b.installed]), [['claude-code', false], ['codex', true]]);
  assert.deepEqual(Object.keys(BACKENDS), ['claude-code', 'codex']);
});

test('gatewayArgs points each CLI at the session gateway, with the token left in the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-gwargs-'));
  // Windows paths, as the Core builds them; on Linux CI this is a file named with a backslash.
  const file = path.win32.join(dir, 'houston-mcp.json');
  try {
    const url = 'http://127.0.0.1:50123/mcp';
    const claude = gatewayArgs('claude-code', url, dir);
    assert.ok(claude.startsWith('--mcp-config '));
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(cfg, { mcpServers: { houston: { type: 'http', url, headers: { Authorization: 'Bearer ${HOUSTON_MCP_TOKEN}' } } } });
    const codex = gatewayArgs('codex', url, dir);
    assert.match(codex, /mcp_servers\.houston\.url=http:\/\/127\.0\.0\.1:50123\/mcp/);
    assert.match(codex, /bearer_token_env_var=HOUSTON_MCP_TOKEN/);
    assert.equal(gatewayArgs('other', url, dir), '');
  } finally { fs.rmSync(file, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a prompt runs Claude Code and Codex unattended, their prompts off; interactive has no tail', () => {
  const b = resolveBackend('claude-code', { ...opts(on(CLAUDE, ...GIT)), prompt: 'Fix the "flaky" test in C:\\work\\' });
  assert.ok(b.command.endsWith(' --strict-mcp-config'), b.command);
  assert.equal(b.tail, '-p "Fix the \\"flaky\\" test in C:\\work\\\\" --dangerously-skip-permissions');
  const c = resolveBackend('codex', { ...opts(on(CODEX)), prompt: '-v is a flag' });
  assert.match(c.command, / --sandbox danger-full-access .*analytics\.enabled=false$/);
  assert.equal(c.tail, 'exec --skip-git-repo-check -- "-v is a flag"');
  assert.equal(resolveBackend('claude-code', opts(on(CLAUDE, ...GIT))).tail, '', 'interactive without one');
  const saved = BACKENDS.codex.headless;
  try {
    delete BACKENDS.codex.headless;
    assert.throws(() => resolveBackend('codex', { ...opts(on(CODEX)), prompt: 'x' }), /Codex has no unattended start yet/);
  } finally { BACKENDS.codex.headless = saved; }
});

test('quote: every argument comes back as it went in, through a real Windows program\'s argv', { skip: process.platform !== 'win32' && 'Windows command lines' }, () => {
  const cases = ['plain', 'two words', 'say "hi"', 'ends with \\', 'C:\\x\\ "q"', '', 'a\\\\"b', 'tab\there', '\\\\server\\share\\'];
  for (const c of cases) {
    // Verbatim: the arguments go on the command line exactly as quote() wrote them.
    const r = spawnSync(process.execPath, ['-e', '"console.log(JSON.stringify(process.argv[1]))"', quote(c)], { argv0: 'node', windowsVerbatimArguments: true, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), JSON.stringify(c), `${JSON.stringify(c)} quoted as ${quote(c)}`);
  }
});
