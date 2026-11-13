import test from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_COMMAND, agentRows } from '../src/shared/agents.js';
import { toolchainPath } from '../src/shared/toolchain.js';

test('toolchainPath keeps absolute program folders outside the users and Windows folders', () => {
  const PATH = [
    'C:\\Windows\\system32', 'C:\\Windows', 'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\nodejs\\',
    'C:\\Users\\op\\AppData\\Roaming\\npm', 'c:\\users\\OTHER\\bin', 'relative\\bin', '\\\\server\\share\\bin',
    '%SystemRoot%\\foo', 'D:\\tools', 'd:\\TOOLS\\', '', ' C:\\Python312 ',
  ].join(';');
  assert.deepEqual(toolchainPath(PATH, { home: 'C:\\Users\\op', systemRoot: 'C:\\Windows' }),
    ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\nodejs', 'D:\\tools', 'C:\\Python312']);
  // A folder that only starts with the users folder's name is not inside it.
  assert.deepEqual(toolchainPath('C:\\UsersTools', { home: 'C:\\Users\\op', systemRoot: 'C:\\Windows' }), ['C:\\UsersTools']);
});

test('agentRows: no operator or retired identities, active first, and why a row cannot start', () => {
  const id = (over) => ({ id: 'local:x', kind: 'ai-agent', displayName: 'X', backend: null, status: 'active', containment: 'container', ...over });
  const rows = agentRows([
    id({ id: 'local:operator', kind: 'operator', displayName: 'Operator', containment: 'unconfined' }),
    id({ id: 'local:old', displayName: 'Old', status: 'retired' }),
    id({ id: 'local:draft', displayName: 'A draft', status: 'draft', backend: 'codex' }),
    id({ id: 'local:claude', displayName: 'Claude', backend: 'claude-code' }),
    id({ id: 'local:codex', displayName: 'Codex box', backend: 'codex' }),
    id({ id: 'local:shell', displayName: 'Shell' }),
    id({ id: 'local:wide', displayName: 'Wide', containment: 'unconfined' }),
    id({ id: 'local:odd', displayName: 'Odd', backend: 'gemini' }),
  ], [{ id: 's1', identity: 'local:claude', workspace: 'D:\\w', startedAt: 't' }], [
    { name: 'claude-code', displayName: 'Claude Code', installed: true, signIn: 'Run /login' },
    { name: 'codex', displayName: 'Codex', installed: false, signIn: 'device code' },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.canStart, r.why]), [
    ['local:claude', true, ''],
    ['local:codex', false, 'Codex is not installed'],
    ['local:odd', false, 'unknown backend gemini'],
    ['local:shell', true, ''],
    ['local:wide', true, ''],
    ['local:draft', false, 'draft: activate it to start a session'],
  ]);
  assert.deepEqual(rows[0].sessions.map((s) => s.id), ['s1']);
  assert.equal(rows[0].what, 'Claude Code');
  assert.equal(rows[0].signIn, 'Run /login');
  assert.equal(rows[3].what, 'contained shell');
  assert.deepEqual([rows[4].what, rows[4].broad, rows[3].broad], ['⚠ broad access, unconfined · shell', true, false], 'a broad-access identity starts, and says so');
});

test('the shell an identity with no backend runs is fixed', () => {
  assert.equal(SHELL_COMMAND, 'cmd.exe /d /q /k');
});
