import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { applySelfHostedPreset } from '../../../src/bootstrap/self-hosted-preset.ts';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COLP_SERVER_ORIGIN: 'https://colp.test',
    COLP_SERVER_SECRET: randomBytes(32).toString('base64'),
    ...overrides,
  };
}

test('self-hosted preset derives the required production contract', () => {
  const env = environment();
  applySelfHostedPreset(env);
  assert.equal(env.PUBLICATION_ORIGIN, 'https://colp.test');
  assert.equal(env.PRODUCT_ORIGIN, 'https://colp.test');
  assert.match(env.PUBLICATION_SERVER_UUID ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(env.KNOWN_EDITION, 'self-hosted');
  assert.equal(env.KNOWN_FEATURE_MCP_READ, 'true');
  assert.equal(env.KNOWN_FEATURE_COMMUNITY, 'false');
  assert.equal(env.MCP_OAUTH_AUDIENCE, 'https://colp.test/collections/-/mcp');
  assert.equal(new Set([
    env.AUTH_HMAC_KEY,
    env.SESSION_HMAC_KEY,
    env.MCP_HMAC_KEY,
    env.SYNC_HMAC_KEY,
  ]).size, 4);
});

test('self-hosted preset preserves explicit values and rejects unsafe setup', () => {
  const env = environment({ PRODUCT_ORIGIN: 'https://internal.example', KNOWN_FEATURE_FEED: 'true' });
  applySelfHostedPreset(env);
  assert.equal(env.PRODUCT_ORIGIN, 'https://internal.example');
  assert.equal(env.KNOWN_FEATURE_FEED, 'true');

  assert.throws(() => applySelfHostedPreset(environment({ COLP_SERVER_ORIGIN: 'http://192.0.2.10' })), /COLP_INSECURE_HTTP/);
  assert.doesNotThrow(() => applySelfHostedPreset(environment({ COLP_SERVER_ORIGIN: 'http://127.0.0.1:3000' })));
  assert.doesNotThrow(() => applySelfHostedPreset(environment({ COLP_SERVER_ORIGIN: 'http://192.0.2.10', COLP_INSECURE_HTTP: 'true' })));
});

