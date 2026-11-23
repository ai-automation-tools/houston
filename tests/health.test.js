import test from 'node:test';
import assert from 'node:assert/strict';
import { LOG_TARGET_BYTES, bundleName, bytes, coreHealthRows, diagnosticsBundle, healthBody, scrub } from '../src/shared/health.js';
import { escapeHtml } from '../src/shared/docs.js';
import { isAllowedNavigation, toUrl } from '../src/shared/url.js';

const healthy = { audit: { events: 120, breaks: 0, firstBreak: null }, storage: { audit: 2048, transcripts: 3 * 1024 ** 2, backups: 0, total: 4 * 1024 ** 2 }, log: [] };

test('coreHealthRows: an intact chain and storage under the target are ok', () => {
  const [audit, storage] = coreHealthRows(healthy);
  assert.deepEqual(audit, { id: 'audit', name: 'Audit chain', state: 'ok', detail: '120 events, every hash checked' });
  assert.equal(storage.state, 'ok');
  assert.equal(storage.detail, '4.0 MB in all (audit 2 KB, transcripts 3.0 MB, backups 0 B); target 5.0 GB');
  assert.equal('fix' in storage, false);
});

test('coreHealthRows: a break fails the chain row and names the first; storage over the target is a warning', () => {
  const rows = coreHealthRows({ ...healthy, audit: { events: 9, breaks: 2, firstBreak: { segment: 'audit-000001.jsonl', line: 4, reason: 'the hash does not match' } }, storage: { audit: 1, total: LOG_TARGET_BYTES + 1 } });
  assert.equal(rows[0].state, 'bad');
  assert.match(rows[0].detail, /^2 breaks in 9 events; first: audit-000001\.jsonl line 4, the hash does not match$/);
  assert.ok(rows[0].fix);
  assert.equal(rows[1].state, 'warn');
  assert.ok(rows[1].fix);
});

test('coreHealthRows: no Core, an older Core, and an unreachable one', () => {
  assert.deepEqual(coreHealthRows(null), []);
  const old = coreHealthRows({ error: 'methods: core.status', code: 'unknown_method' });
  assert.equal(old[0].state, 'bad');
  assert.match(old[0].fix ?? '', /Houston Core task/);
  assert.deepEqual(coreHealthRows({ error: 'no control.json', code: 'ENOENT' }), [{ id: 'core-health', name: 'Core checks', state: 'off', detail: 'Not checked: no control.json' }]);
});

test('bytes rounds to a readable unit', () => {
  assert.deepEqual([0, 1023, 1024, 1536 * 1024, 5 * 1024 ** 3].map(bytes), ['0 B', '1023 B', '1 KB', '1.5 MB', '5.0 GB']);
});

test('healthBody escapes every value, marks each state and says what is failing', () => {
  const html = healthBody({
    app: { Houston: '0.1.0', 'Data folder': 'C:\\Users\\dev\\<x>' },
    rows: [{ id: 'hub', name: 'Project Hub', state: 'bad', detail: '<script>alert(1)</script>', fix: 'Start it' }, ...coreHealthRows(healthy)],
  }, escapeHtml);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /C:\\Users\\dev\\&lt;x&gt;/);
  assert.match(html, /1 failing/);
  assert.match(html, /<td>✗<\/td><td>Project Hub<\/td>/);
  assert.match(html, /<td>✓<\/td><td>Audit chain<\/td>/);
  assert.match(healthBody({ app: {}, rows: coreHealthRows(healthy) }, escapeHtml), /everything checked is working/);
});

test('scrub: the user folder in any slash, case or JSON escaping, and secret values', () => {
  const home = 'C:\\Users\\dev';
  assert.equal(scrub('C:\\Users\\dev\\AppData and c:/users/DEV/x', { home }), '%USERPROFILE%\\AppData and %USERPROFILE%/x');
  assert.equal(scrub('{"dir":"C:\\\\Users\\\\dev\\\\AppData"}', { home }), '{"dir":"%USERPROFILE%\\\\AppData"}');
  // A longer name that starts the same is someone else's folder.
  assert.equal(scrub('C:\\Users\\developer\\x', { home }), 'C:\\Users\\developer\\x');
  assert.equal(scrub('at C:\\Users\\dev', { home }), 'at %USERPROFILE%');
  assert.equal(scrub('key sk-made-up-1234 and short ab', { secrets: ['sk-made-up-1234', 'ab', ''] }), 'key [REDACTED] and short ab');
  // The longer of two overlapping values goes whole.
  assert.equal(scrub('xx-abcdefgh-12345', { secrets: ['abcdefgh', 'xx-abcdefgh-12345'] }), '[REDACTED]');
  assert.equal(scrub('nothing to do', {}), 'nothing to do');
  // A home with one part (a drive root) would match too much: left alone.
  assert.equal(scrub('C:\\x', { home: 'C:\\' }), 'C:\\x');
});

test('diagnosticsBundle: JSON with every string scrubbed, nested ones too', () => {
  const text = diagnosticsBundle({
    created: '2026-11-22T20:00:00.000Z', app: { 'Data folder': 'C:\\Users\\dev\\AppData\\Roaming\\ai-command-center' },
    rows: [{ id: 'chat', name: 'Chat model', state: 'ok', detail: 'model x · key sk-made-up-1234' }],
    core: { ...healthy, log: ['{"dir":"C:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\houston-core"}'] },
    appLog: ['2026-11-22 error at C:\\Users\\dev\\x.js'],
  }, { home: 'C:\\Users\\dev', secrets: ['sk-made-up-1234'] });
  const b = JSON.parse(text);
  assert.equal(b.bundle, 'houston.diagnostics/v1');
  assert.doesNotMatch(text, /Users\\\\dev|sk-made-up/i);
  assert.equal(b.app['Data folder'], '%USERPROFILE%\\AppData\\Roaming\\ai-command-center');
  assert.equal(b.core.log[0], '{"dir":"%USERPROFILE%\\\\AppData\\\\Local\\\\houston-core"}');
  assert.equal(b.core.audit.events, 120);
  assert.equal(bundleName(new Date('2026-11-22T20:00:00.000Z')), 'houston-diagnostics-2026-11-22T20-00-00-000Z.json');
});

test('acc://health/ opens from the app only', () => {
  assert.equal(isAllowedNavigation('acc://health/'), true);
  assert.equal(isAllowedNavigation('acc://health/', 'https://evil.example/'), false);
  assert.equal(toUrl('acc://health/'), 'acc://health/');
});
