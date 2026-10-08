import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../../src/bootstrap/config.js';
import { applySelfHostedPreset } from '../../../src/bootstrap/self-hosted-preset.js';
import { selfHostedManifestFeatures } from '../../../src/modules/publication/index.js';

/**
 * D26: COLP endpoints are HTTPS and the protocol allows http only on loopback
 * (protocol/docs/02). A LAN without a domain uses the tls-internal profile.
 */
const SECRET = Buffer.alloc(32, 9).toString('base64');

afterEach(() => {
  delete process.env.COLP_INSECURE_HTTP;
});

function env(origin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    COLP_SERVER_ORIGIN: origin,
    COLP_SERVER_SECRET: SECRET,
    DATABASE_URL: 'postgres://x',
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

test('a LAN http origin is refused at the preset with the tls-internal hint', () => {
  for (const origin of ['http://192.168.1.20:8080', 'http://10.0.0.5', 'http://colp.lan']) {
    assert.throws(() => applySelfHostedPreset(env(origin, { COLP_INSECURE_HTTP: 'true' })),
      /tls-internal/u, origin);
  }
});

test('loadConfig refuses a LAN http publication origin even when the preset is bypassed', () => {
  const lan = env('https://colp.test', {
    PUBLICATION_ORIGIN: 'http://192.168.1.20:8080',
    PRODUCT_ORIGIN: 'http://192.168.1.20:8080',
    COLP_INSECURE_HTTP: 'true',
  });
  applySelfHostedPreset(lan);
  assert.throws(() => loadConfig(lan), /http is allowed only for loopback/u);
});

test('loopback http origins, including IPv6, pass the preset and production loadConfig', () => {
  for (const origin of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    const next = env(origin, { COLP_INSECURE_HTTP: 'true' });
    assert.doesNotThrow(() => applySelfHostedPreset(next), origin);
    assert.doesNotThrow(() => loadConfig(next), origin);
  }
});

test('the Manifest calls any http origin insecure, acknowledged or not', () => {
  const base = { KNOWN_EDITION: 'self-hosted' };
  assert.equal(selfHostedManifestFeatures({ ...base, COLP_SERVER_ORIGIN: 'https://colp.test' })?.transport, 'https');
  assert.equal(selfHostedManifestFeatures({ ...base, COLP_SERVER_ORIGIN: 'http://127.0.0.1:8080' })?.transport,
    'insecure-http');
  assert.equal(selfHostedManifestFeatures({
    ...base, COLP_SERVER_ORIGIN: 'http://127.0.0.1:8080', COLP_INSECURE_HTTP: 'true',
  })?.transport, 'insecure-http');
});
