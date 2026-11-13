import test from 'node:test';
import assert from 'node:assert/strict';
import { backendRows, secretRows, serverName, serverRows, toolsHashArg } from '../src/shared/integrations.js';

const tools = [{ name: 'echo', description: 'Echo it.\nSecond line.' }, { name: 'env' }];
/** @param {object} o */
const server = (o) => ({
  name: 'stub', identity: 'local:mcp/stub', transport: 'container', command: 'node stub.js', env: { TOKEN: 'secret:t' }, pathDirs: [],
  state: 'pinned', tools, toolsHash: 'a'.repeat(64), pinnedHash: 'a'.repeat(64), ...o,
});
const acts = (/** @type {any} */ r) => r.actions.map((/** @type {any} */ a) => a.act);

test('serverRows: decisions first, the command always shown, tools listed when a pin would serve them', () => {
  const rows = serverRows(/** @type {any} */ ([
    server({ name: 'zed' }),
    server({ name: 'new', state: 'discovered', tools: null, toolsHash: null, pinnedHash: null }),
    server({ name: 'read', state: 'installed', pinnedHash: null }),
    server({ name: 'changed', state: 'needs_review' }),
    server({ name: 'off', state: 'disabled' }),
    server({ name: 'app', transport: 'http', command: null, url: 'http://127.0.0.1:5000/mcp', env: { Authorization: 'Bearer secret:app' } }),
    server({ name: 'cron', transport: 'host', state: 'disabled', toolsHash: null }),
  ]));
  assert.deepEqual(rows.map((r) => r.name), ['changed', 'read', 'new', 'app', 'zed', 'cron', 'off']);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(acts(by.new), ['install']);
  assert.equal(by.new.actions[0].label, 'Install');
  assert.equal(by.new.runs, 'node stub.js', 'the full command, before it ever runs');
  assert.deepEqual(acts(by.read), ['pin', 'install', 'disable']);
  assert.equal(by.read.actions[0].label, 'Pin 2 tools');
  assert.equal(by.read.showTools, true);
  assert.deepEqual(acts(by.changed), ['pin', 'disable']);
  assert.match(by.changed.sub, /refused until then/);
  assert.deepEqual(acts(by.zed), ['install', 'disable']);
  assert.equal(by.zed.actions[0].label, 'Read again');
  assert.equal(by.zed.showTools, false);
  assert.deepEqual([acts(by.off), by.off.actions[0].label], [['pin', 'install'], 'Enable']);
  assert.deepEqual(acts(by.cron), ['install'], 'disabled before it was ever read: nothing to enable');
  assert.deepEqual([by.app.where, by.app.runs, by.app.env], ['http · unconfined', 'http://127.0.0.1:5000/mcp', ['Authorization = Bearer secret:app']]);
  assert.equal(by.cron.where, 'host · unconfined');
  assert.equal(by.zed.where, 'contained');
  assert.equal(by.read.hash, 'a'.repeat(64));
});

test('the window passes only a server name and a tools hash', () => {
  assert.equal(serverName('github'), 'github');
  for (const bad of ['Git', '../x', '', 'a'.repeat(41), 5, null]) assert.throws(() => serverName(bad), /not an MCP server name/);
  assert.equal(toolsHashArg('f'.repeat(64)), 'f'.repeat(64));
  for (const bad of ['F'.repeat(64), 'f'.repeat(63), {}, undefined]) assert.throws(() => toolsHashArg(bad), /not a tool list hash/);
});

test('secretRows shows names and dates only; backendRows says what is installed', () => {
  const day = (/** @type {string} */ iso) => iso.slice(0, 10);
  assert.deepEqual(secretRows([
    { name: 'gh', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z', last_used_at: null },
    { name: 'app', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', last_used_at: '2026-11-04T00:00:00Z' },
  ], day), [
    { name: 'gh', sub: 'set 2026-11-02 · never given to a server' },
    { name: 'app', sub: 'set 2026-11-03 · last given to a server 2026-11-04' },
  ]);
  const [b] = backendRows([{ name: 'codex', displayName: 'Codex', installed: false, signIn: 'Sign in once.', hosts: ['chatgpt.com:443'] }]);
  assert.deepEqual([b.name, b.installed, b.sub], ['Codex', false, 'not installed on this machine']);
  assert.match(b.title, /chatgpt\.com:443[\s\S]*First time: Sign in once\./);
});
