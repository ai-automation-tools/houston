import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, loadEnv } from '../src/main/env.js';

test('loadEnv reads .env and lets the real environment win', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-env-')), '.env');
  fs.writeFileSync(file, '# comment\nACC_CHAT_MODEL=from-file\nACC_CHAT_API_KEY="k"\n');
  assert.deepEqual(loadEnv(file, { ACC_CHAT_MODEL: 'from-env' }), { ACC_CHAT_MODEL: 'from-env', ACC_CHAT_API_KEY: 'k' });
});

test('loadEnv without a .env is just the environment', () => {
  assert.deepEqual(loadEnv(path.join(os.tmpdir(), 'acc-env-missing', '.env'), { A: '1' }), { A: '1' });
});

test('childEnv drops the chat key under either name and any casing, and Hub\'s token, keeps the rest, and adds extra', () => {
  const base = { Path: 'C:/Windows', SystemRoot: 'C:/Windows', ACC_CHAT_API_KEY: 'sentinel-1', ANTHROPIC_API_KEY: 'sentinel-2', anthropic_api_key: 'sentinel-3', ACC_HUB_TOKEN: 'sentinel-4', ACC_CHAT_MODEL: 'm' };
  const out = childEnv(base, { ACC_MCP_TOKEN: 't' });
  assert.deepEqual(out, { Path: 'C:/Windows', SystemRoot: 'C:/Windows', ACC_CHAT_MODEL: 'm', ACC_MCP_TOKEN: 't' });
  assert.equal(JSON.stringify(out).includes('sentinel'), false);
  assert.equal('ACC_CHAT_API_KEY' in base, true, 'base untouched');
});
