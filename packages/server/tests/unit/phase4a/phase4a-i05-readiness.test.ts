/**
 * P4A-I05 readiness + secret hygiene tests.
 *
 * Proves the sanitized readiness payload and sanitized config view never emit
 * bucket, prefix, origin query, secret references, or key material, and that
 * the I05 attachments code path can never construct an S3 client or delivery
 * route (guarded at source level; modules cannot import fastify or any AWS
 * SDK surface).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  evaluateAttachmentsCapabilityReadiness,
  registrableDomain,
  sanitizeAttachmentsFeatureConfig,
} from '../../../src/modules/attachments/index.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PRODUCT_ORIGIN: 'https://app.known.example',
};

const SECRET_VALUE = 'super-secret-access-key-value-that-must-never-appear'; // secret-scan: allow 'super-secret-access-key-value-that-must-never-appear'

function enabledEnv(): Record<string, string> {
  return {
    ...baseEnv,
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: 'known-private-attachments',
    ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/',
    ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/',
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/r2/rw/primary',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/ro/primary',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.test',
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/delivery/hmac/primary',
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '60',
  };
}

test('attachments disabled reports a sanitized disabled capability', () => {
  const config = loadConfig(baseEnv);
  const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments);
  assert.deepEqual(readiness, { capability: 'attachments', status: 'disabled', reason: 'not_enabled' });
  assert.deepEqual(Object.keys(readiness).sort(), ['capability', 'reason', 'status']);
});

test('attachments enabled with a valid config reports ready (dependency probing is I06+)', () => {
  const config = loadConfig(enabledEnv());
  assert.ok(config.attachments);
  const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments);
  assert.deepEqual(readiness, { capability: 'attachments', status: 'ready', reason: 'none' });
});

test('readiness payload never contains bucket, prefix, origin query, refs, or key material', () => {
  const config = loadConfig({
    ...enabledEnv(),
    ATTACHMENTS_R2_BUCKET: 'secret-bucket-name',
    ATTACHMENTS_R2_LIVE_PREFIX: 'secret/live/',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://files.example.net',
  });
  assert.ok(config.attachments);
  const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments);
  const serialized = JSON.stringify(readiness);
  for (const needle of ['secret-bucket-name', 'secret/live/', 'files.example.net', 'r2.cloudflarestorage.com',
    'known/r2/rw/primary', 'known/r2/ro/primary', 'known/delivery/hmac/primary', SECRET_VALUE, 'accessKeyId', 'secretAccessKey', '?' ]) {
    assert.ok(!serialized.includes(needle), `readiness must not leak ${JSON.stringify(needle)}`);
  }
});

test('sanitized config view redacts endpoint, bucket, prefixes, and secret references', () => {
  const config = loadConfig(enabledEnv());
  assert.ok(config.attachments);
  const sanitized = sanitizeAttachmentsFeatureConfig(config.attachments);
  assert.equal(sanitized.enabled, true);
  assert.equal(sanitized.region, 'auto');
  assert.equal(sanitized.deliveryOriginHost, 'delivery.known.test');
  assert.equal(sanitized.grantTtlSeconds, 60);
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of ['r2.cloudflarestorage.com', 'known-private-attachments', 'attachments/live/',
    'attachments/probe/', 'known/r2/rw/primary', 'known/r2/ro/primary', 'rwSecretRef', 'roSecretRef',
    'bucket', 'livePrefix', 'probePrefix', 'endpoint']) {
    assert.ok(!serialized.includes(forbidden), `sanitized config must not contain ${JSON.stringify(forbidden)}`);
  }
});

test('the config object itself stores only references, never credential material', () => {
  // Inject a value that looks like an access key into the environment; the
  // loader must never copy it anywhere because only the reference is stored.
  const env = {
    ...enabledEnv(),
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/r2/rw/with-ak-value',
    KNOWN_FAKE_ACCESS_KEY: SECRET_VALUE,
  };
  const config = loadConfig(env);
  assert.ok(config.attachments);
  const serialized = JSON.stringify(config.attachments);
  assert.ok(!serialized.includes(SECRET_VALUE), 'access-key material must never be stored');
  assert.ok(!serialized.includes('AKIA'), 'no access-key-like material may be stored');
  assert.ok(!serialized.includes('secretAccessKey'), 'no secret key field may exist');
  assert.equal(config.attachments.r2.rwSecretRef, 'known/r2/rw/with-ak-value');
});

test('registrable-domain comparison detects same-site cookie risk', () => {
  assert.equal(registrableDomain('app.known.example'), 'known.example');
  assert.equal(registrableDomain('files.known.example'), 'known.example');
  assert.equal(registrableDomain('known.example'), 'known.example');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('cdn.example.com'), 'example.com');
  assert.equal(registrableDomain('files.example.net'), 'example.net');
  assert.notEqual(registrableDomain('app.known.example'), registrableDomain('files.example.net'));
  // Compound public suffixes use the eTLD+1 boundary.
  assert.equal(registrableDomain('a.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('b.example.org.uk'), 'example.org.uk');
  assert.notEqual(registrableDomain('a.example.co.uk'), registrableDomain('b.example.com'));
  // IPs and single-label hosts are treated as their own registrable domain.
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('I05 attachments source cannot construct an S3 client, network call, or delivery route', async () => {
  const moduleRoot = fileURLToPath(new URL('../../../src/modules/attachments/', import.meta.url));
  const entries = await readdir(moduleRoot, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith('.ts'));
  assert.ok(files.length >= 3, 'attachments module must contain its config/readiness sources');
  const forbidden = [
    '@aws-sdk',
    'S3Client',
    's3-request-presigner',
    'fetch(',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'fastify',
  ];
  for (const file of files) {
    const source = await readFile(join(moduleRoot, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!source.includes(pattern), `${file} must not reference ${pattern}`);
    }
  }
});



