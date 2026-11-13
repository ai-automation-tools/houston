import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELLS, chatRow, coreRow, cronsoleRow, hubRow, mcpRow, shellRows } from '../src/shared/connections.js';

test('Hub: ready with its address, or failing with what to do', () => {
  assert.deepEqual(hubRow('http://127.0.0.1:4273', { ok: true, state: 'ready' }), { id: 'hub', name: 'Project Hub', state: 'ok', detail: 'http://127.0.0.1:4273 · ready' });
  const down = hubRow('http://127.0.0.1:4273', { ok: false, state: 'fetch failed' });
  assert.equal(down.state, 'bad');
  assert.equal(down.detail, 'http://127.0.0.1:4273 · fetch failed');
  assert.match(down.fix || '', /hubUrl in settings\.json/);
  assert.equal(hubRow('u', { ok: false, state: '' }).detail, 'u · not answering');
});

test('Cronsole: not set up, failing, or its task count', () => {
  const info = { configured: true, ui: 'http://localhost:7373' };
  const off = cronsoleRow({ configured: false, ui: info.ui }, null);
  assert.equal(off.state, 'off');
  assert.match(off.fix || '', /ACC_CRONSOLE_MCP/);
  assert.equal(cronsoleRow(info, null).state, 'off');
  const bad = cronsoleRow(info, { error: 'Timed out' });
  assert.deepEqual([bad.state, bad.detail], ['bad', 'Timed out']);
  assert.match(bad.fix || '', /CRONSOLE_TOKEN/);
  assert.deepEqual(cronsoleRow(info, { count: 1 }), { id: 'cronsole', name: 'Cronsole', state: 'ok', detail: '1 task · UI at http://localhost:7373' });
  assert.equal(cronsoleRow(info, { count: 452 }).detail, '452 tasks · UI at http://localhost:7373');
});

test('shells: every known shell gets a row, installed or with how to get it', () => {
  const rows = shellRows([{ id: 'powershell' }, { id: 'cmd' }]);
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [['shell:pwsh', 'off'], ['shell:powershell', 'ok'], ['shell:cmd', 'ok'], ['shell:git-bash', 'off']]);
  assert.match(rows[0].fix || '', /winget install Microsoft\.PowerShell/);
  assert.equal(rows[1].fix, undefined);
  assert.equal(shellRows([]).length, SHELLS.length);
});

test('chat: never claims the key works, and names what to set', () => {
  const off = chatRow({ model: '', missing: ['ANTHROPIC_API_KEY (or ACC_CHAT_API_KEY)', 'ACC_CHAT_MODEL (or ANTHROPIC_MODEL)'] });
  assert.equal(off.state, 'off');
  assert.equal(off.fix, 'Set ANTHROPIC_API_KEY (or ACC_CHAT_API_KEY) and ACC_CHAT_MODEL (or ANTHROPIC_MODEL) in .env, then restart the app.');
  const ok = chatRow({ model: 'claude-x', missing: [] });
  assert.equal(ok.state, 'ok');
  assert.match(ok.detail, /^claude-x · key set \(not tried/);
  assert.doesNotMatch(JSON.stringify(ok), /sk-|apiKey/);
});

test('MCP server: its address, or that it never started', () => {
  assert.deepEqual(mcpRow({ url: 'http://127.0.0.1:5000/mcp' }), { id: 'mcp', name: 'MCP server', state: 'ok', detail: 'http://127.0.0.1:5000/mcp · token in mcp.json' });
  const bad = mcpRow(null);
  assert.equal(bad.state, 'bad');
  assert.match(bad.fix || '', /app\.log/);
});

test('Houston Core: running with its containment rung and sessions, not running with how to start it, or failing', () => {
  assert.deepEqual(coreRow({ pid: 41, containment: 'container', sessions: 1 }), { id: 'core', name: 'Houston Core', state: 'ok', detail: 'Running · containment: container · 1 session · pid 41' });
  assert.match(coreRow({ pid: 41, containment: 'container', sessions: 0 }).detail, /0 sessions/);
  for (const code of ['ENOENT', 'ECONNREFUSED']) {
    const off = coreRow({ error: 'gone', code });
    assert.equal(off.state, 'off');
    assert.equal(off.detail, 'Not running');
    assert.match(off.fix || '', /Register-HoustonCore\.ps1 -StartNow/);
  }
  const bad = coreRow({ error: 'bad or missing token', code: 'unauthorized' });
  assert.deepEqual([bad.state, bad.detail], ['bad', 'unauthorized: bad or missing token']);
  assert.match(bad.fix || '', /core\.log/);
  assert.deepEqual(((r) => [r.state, r.detail])(coreRow({ error: 'methods: ...', code: 'unknown_method' })), ['bad', 'Running older code than the app']);
  assert.equal(coreRow({ error: 'core.status: no answer in 3000 ms' }).detail, 'core.status: no answer in 3000 ms');
  assert.match(coreRow(null).detail, /^Windows only/);
});
test('hubRow: the access token in the detail, and a 401 says to set ACC_HUB_TOKEN', () => {
  assert.match(hubRow('http://127.0.0.1:4273', { ok: true, state: 'ready' }, 'sent').detail, /access token sent/);
  const asked = hubRow('http://127.0.0.1:4273', { ok: false, state: 'Project Hub /api/health returned 401: token' }, 'none');
  assert.equal(asked.state, 'bad');
  assert.match(asked.detail, /wants an access token/);
  assert.match(asked.fix ?? '', /ACC_HUB_TOKEN/);
  assert.match(hubRow('http://127.0.0.1:4273', { ok: false, state: 'Project Hub /api/health returned 401' }, 'sent').fix ?? '', /refused the token/);
  assert.match(hubRow('http://hub.example.com', { ok: true, state: 'ready' }, 'withheld').detail, /withheld/);
});
