import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPES, SETTINGS_URL, controls, settingsBody } from '../src/shared/scopes.js';
import { escapeHtml } from '../src/shared/docs.js';
import { isAllowedNavigation, toUrl } from '../src/shared/url.js';

/** @returns {import('../src/shared/scopes.js').Snapshot} */
const snap = (over = {}) => ({
  hubUrl: 'http://127.0.0.1:4273', hubToken: 'sent', quickLinks: 2, newsSources: 1, bookmarkSource: '', adBlock: true, closeToTray: false,
  chat: { model: 'claude-x', missing: [] }, cronsole: { configured: false, ui: '' }, mcpUrl: 'http://127.0.0.1:1/mcp',
  workspaces: 3, workspace: { name: 'acme', folder: 'D:\\acme', tabs: 1, terminals: 2 },
  core: { dir: 'C:\\data', sessions: 1, identities: 2, grants: 5, askGrants: 1, approvals: 0, limits: { approvalSeconds: 120, transcriptBytes: 5 * 1024 ** 3, sessionTranscriptBytes: 100 * 1024 ** 2, transcriptDays: 90 }, mcp: { servers: 2, pinned: 1, review: 1 }, secrets: 3 },
  ...over,
});

const row = (rows, label) => rows.find((r) => r.label === label);

test('every control has a known scope, a value and where it is changed; each scope has at least one', () => {
  const rows = controls(snap());
  for (const r of rows) {
    assert.ok(Object.hasOwn(SCOPES, r.scope), r.label);
    assert.ok(r.value && r.where, r.label);
  }
  assert.deepEqual([...new Set(rows.map((r) => r.scope))].sort(), Object.keys(SCOPES).sort());
  // The scope table's placements (harness-requirements.md).
  assert.equal(row(rows, 'Stop All').scope, 'global');
  assert.equal(row(rows, 'Audit log').scope, 'global');
  assert.equal(row(rows, 'Hard denies').scope, 'global');
  assert.equal(row(rows, 'Agent identities and grants').scope, 'profile');
  assert.equal(row(rows, 'Tabs, terminals and conversations').scope, 'workspace');
  assert.equal(row(rows, 'Allow once, allow for this session').scope, 'session');
});

test('values come from the snapshot: the Core\'s own limits, counts, chat and workspace', () => {
  const rows = controls(snap());
  assert.equal(row(rows, 'Transcript limits').value, '100 MB a session, 5 GB in all, 90 days, oldest deleted first');
  // A Core from before retention sends no age.
  const noAge = snap();
  noAge.core = { ...noAge.core, limits: { ...noAge.core.limits, transcriptDays: undefined } };
  assert.equal(row(controls(noAge), 'Transcript limits').value, '100 MB a session, 5 GB in all, oldest deleted first');
  assert.equal(row(rows, 'Approval timeout').value, 'an unanswered card denies after 120 s');
  assert.equal(row(rows, 'Agent identities and grants').value, '2 identities, 5 grants (1 ask)');
  assert.equal(row(rows, 'Audit log').value, 'C:\\data\\audit');
  assert.equal(row(rows, 'MCP servers (gateway)').value, '2 servers registered, 1 pinned, 1 need review');
  assert.equal(row(rows, 'Secrets (vault)').value, '3 secrets stored; values are never shown');
  // A Core from before the gateway answers neither.
  const old = snap();
  old.core = { ...old.core, mcp: null, secrets: null };
  assert.equal(row(controls(old), 'Secrets (vault)').value, 'needs a newer Core');
  assert.equal(row(rows, 'Chat').value, 'on, model claude-x');
  assert.equal(row(rows, 'Project Hub').value, 'http://127.0.0.1:4273, with its access token');
  assert.equal(row(rows, 'Tabs, terminals and conversations').value, '1 tab, 2 terminals');
  assert.equal(row(controls(snap({ chat: { model: '', missing: ['ACC_CHAT_API_KEY'] } })), 'Chat').value, 'off: ACC_CHAT_API_KEY not set');
});

test('with no Core, its rows say why instead of a value', () => {
  const down = controls(snap({ core: { error: 'The Houston Core is not running.' } }));
  assert.equal(row(down, 'Running agent sessions').value, 'Core not reachable: The Houston Core is not running.');
  assert.match(row(controls(snap({ core: null })), 'Audit log').value, /Windows only/);
});

test('the page: a table per scope, the workspace named, everything escaped; only the app opens it', () => {
  const body = settingsBody(snap({ workspace: { name: '<b>x</b>', folder: 'D:\\x', tabs: 0, terminals: 0 } }), escapeHtml);
  assert.equal((body.match(/<table>/g) ?? []).length, Object.keys(SCOPES).length);
  assert.ok(body.includes('Workspace: &lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!body.includes('<b>x</b>'));
  assert.match(body, /global deny wins/);
  assert.equal(isAllowedNavigation(SETTINGS_URL), true);
  assert.equal(isAllowedNavigation(SETTINGS_URL, 'https://evil.example/'), false);
  assert.equal(toUrl(SETTINGS_URL), SETTINGS_URL);
});
