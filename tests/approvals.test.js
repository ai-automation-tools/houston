import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWERS, describeAsk, isAnswer, secondsLeft } from '../src/shared/approvals.js';
import { ANSWERS as CORE_ANSWERS } from '../core/approvals.js';

test('describeAsk says exactly what was asked', () => {
  assert.equal(describeAsk({ action: 'net.connect', resource: { type: 'Host', id: 'example.com:443' } }), 'connect to example.com:443');
  assert.equal(describeAsk({ action: 'tool.call', resource: { type: 'Tool', id: 'github/create_issue' } }), 'call the tool github/create_issue');
  assert.equal(describeAsk({ action: 'tool.call', resource: { type: 'Tool', id: 'github/create_issue', args_preview: '{"title":"x"}' } }), 'call the tool github/create_issue with {"title":"x"}');
  assert.equal(describeAsk({ action: 'command.run', resource: { type: 'Command', id: 'git push' } }), 'run git push');
  assert.equal(describeAsk({ action: 'secret.use', resource: { type: 'Secret', id: 'gh' } }), 'secret.use on Secret gh');
});

test('secondsLeft counts down to zero and stays there', () => {
  const at = Date.parse('2026-11-12T00:00:00Z');
  assert.equal(secondsLeft('2026-11-12T00:02:00Z', at), 120);
  assert.equal(secondsLeft('2026-11-12T00:00:00.400Z', at), 1);
  assert.equal(secondsLeft('2026-11-11T23:59:00Z', at), 0);
});

test('the window offers the answers the Core takes, and nothing else', () => {
  assert.deepEqual(ANSWERS, CORE_ANSWERS);
  assert.ok(isAnswer('session'));
  for (const v of ['yes', 'constructor', 1, null]) assert.equal(isAnswer(v), false);
});

test('a sub-agent card says it starts one, with the task and grants asked for', () => {
  assert.equal(describeAsk({ action: 'session.spawn', resource: { type: 'Session', id: 'delegate', args_preview: '{"task":"dir"}' } }), 'start a sub-agent with {"task":"dir"}');
});
