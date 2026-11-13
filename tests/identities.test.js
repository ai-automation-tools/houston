import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../src/shared/docs.js';
import { IDENTITIES_URL, identitiesBody, identityAnchor, reviewState } from '../src/shared/identities.js';
import { agentRows } from '../src/shared/agents.js';
import { isAllowedNavigation } from '../src/shared/url.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const base = {
  kind: 'ai-agent', owner: 'local:operator', parent: null, purpose: null, backend: null, status: 'active', containment: 'container',
  createdAt: '2026-11-12T09:00:00Z', lastUsedAt: null, expiresAt: null, retiredAt: null, reviewedAt: null, reviewBy: null, tags: [], grants: [],
};

test('reviewState: never, due, overdue; nothing for the operator or a retired identity', () => {
  assert.equal(reviewState({ ...base }, NOW).state, 'never');
  assert.deepEqual(reviewState({ ...base, reviewBy: '2026-11-20T12:00:00Z' }, NOW), { state: 'due', text: 'due in 7 days' });
  assert.deepEqual(reviewState({ ...base, reviewBy: '2026-11-12T12:00:00Z' }, NOW), { state: 'overdue', text: 'overdue by 1 day' });
  assert.equal(reviewState({ ...base, reviewBy: '2026-11-13T18:00:00Z' }, NOW).text, 'due in 1 day');
  assert.equal(reviewState({ ...base, kind: 'operator' }, NOW).state, 'none');
  assert.equal(reviewState({ ...base, status: 'retired' }, NOW).state, 'none');
});

test('the Identity Center page lists every identity with its grants, reach and sessions, escaped', () => {
  const evil = { ...base, id: 'local:x', displayName: '<img src=x onerror=alert(1)>', purpose: 'a & b', reviewBy: '2026-11-01T00:00:00Z',
    grants: [{ id: 'g1', resource: 'file:D:/work/**', permission: 'write', effect: 'allow', grantedAt: '2026-11-12T09:00:00Z', grantedBy: 'local:operator', expiresAt: null, lastUsedAt: null }] };
  const op = { ...base, id: 'local:operator', kind: 'operator', displayName: 'Operator', owner: null, containment: 'unconfined' };
  const reach = {
    'local:x': {
      status: 'active', containment: 'container', enforced: true, expired: 2, alwaysDenied: ['file:a/**', 'file:b/**'], standing: [{ id: 'nightly', status: 'active', expiresAt: '2027-01-01T00:00:00Z' }],
      types: { file: { allow: [{ resource: 'D:/work/**', permission: 'write' }], ask: [], deny: [] }, net: { allow: [], ask: [{ resource: 'example.com:443', permission: 'connect' }], deny: [] } },
      notApplied: [{ resource: 'file:D:/docs/*.md', reason: 'only dir/** or an exact path compiles to a container' }],
      backend: { name: 'codex', displayName: 'Codex', hosts: ['chatgpt.com:443'], missingHosts: ['chatgpt.com:443'] },
    },
  };
  const html = identitiesBody({
    identities: [op, evil], reach, now: NOW,
    sessions: [{ id: 's1', identity: 'local:x', workspace: 'D:/work', startedAt: '2026-11-13T11:00:00Z' }],
    starts: [{ time: '2026-11-13T10:00:00Z', session_id: null, identity: { subject: 'local:x' }, decision: { result: 'deny', reasons: ['the identity is suspended'] } }],
  }, escapeHtml);
  assert.ok(!html.includes('<img'), 'names are escaped');
  assert.ok(html.indexOf('local:x') < html.indexOf('local:operator'), 'the operator sorts last');
  for (const s of ['1 overdue for review', `href="#${identityAnchor('local:x')}"`, `id="${identityAnchor('local:x')}"`, 'a &amp; b', 'overdue by 12 days',
    '<code>file:D:/work/**</code>', 'Network, asks first', 'Not applied inside a container', '2 expired grants left out', 'Codex needs chatgpt.com:443',
    'Standing grants: nightly', '2 folders no grant opens', 'Running since', 'refused: the identity is suspended', 'The operator is unconfined and takes no grants']) {
    assert.ok(html.includes(s), s);
  }
  assert.equal(identityAnchor('local:team/dev-codex'), 'id-team-dev-codex');
});

test('agent rows carry the review state; the Identity Center opens from the app only', () => {
  const rows = agentRows([{ ...base, id: 'local:a', displayName: 'A', reviewBy: '2026-11-01T00:00:00Z' }], [], [], NOW);
  assert.deepEqual([rows[0].review, rows[0].overdue], ['overdue by 12 days', true]);
  assert.equal(isAllowedNavigation(`${IDENTITIES_URL}#id-a`), true);
  assert.equal(isAllowedNavigation(IDENTITIES_URL, 'https://example.com/'), false);
});
