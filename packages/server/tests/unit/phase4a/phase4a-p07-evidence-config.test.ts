/**
 * P4A-P07 evidence script config-contract tests (plan §4 fail-closed config).
 *
 * The real-R2 evidence CLI (`scripts/phase4a-p07-evidence.ts`) builds its
 * runtime environment with `PRODUCT_ORIGIN=https://app.known.example`, an
 * isolated delivery origin and a FIXED retention contract (intent 24h /
 * stored 30d / retired 90d). The delivery origin is credential-free and must
 * never be same-site with the application origin (i05 contract,
 * `assertDeliveryOriginNotSameSite`); the retention contract must parse
 * through the REAL production loader (`loadConfig`) with retired >= stored,
 * so the evidence run's 91-day DATABASE-clock advance deterministically
 * crosses the retired retention window.
 *
 * These tests import the REAL script constants and the REAL runtime-env
 * builder, so a regression fails here even though the probe itself cannot run
 * inside a unit suite. Every env fixture goes through the REAL production
 * config loader, never a directly constructed typed object.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { parseProbeConfiguration } from '../../../scripts/evidence/phase4a-i01-capability-probe.js';
import {
  assertDeliveryOriginNotSameSite,
  registrableDomain,
} from '../../../src/modules/attachments/attachments-origin.js';
import {
  ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN,
  PRODUCT_ORIGIN,
  p07EvidenceRuntimeEnvironment,
} from '../../../scripts/phase4a-p07-evidence.js';

const DATABASE_URL = 'postgresql://known:known@127.0.0.1:5432/known';
const ACCOUNT_ID = 'f'.repeat(32);

/**
 * Synthetic probe env mirroring the contract `scripts/phase4a-r2-local-env.mjs`
 * writes for the evidence run (`parseProbeConfiguration` validates it).
 */
function syntheticProbeEnvironment(): Record<string, string> {
  return {
    P4A_PROBE_TARGET: 'cloudflare-r2-direct-object-api',
    P4A_R2_ENDPOINT: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    P4A_R2_ACCOUNT_ID: ACCOUNT_ID,
    P4A_R2_BUCKET: 'known-test',
    P4A_R2_PROBE_PREFIX: 'capability-probes/local-20260808123456-p07-0123456789abcdef/',
    P4A_R2_ACCESS_KEY_ID: 'c'.repeat(32),
    P4A_R2_SECRET_ACCESS_KEY: 'd'.repeat(64),
    P4A_R2_READ_ACCESS_KEY_ID: 'a'.repeat(32),
    P4A_R2_READ_SECRET_ACCESS_KEY: 'b'.repeat(64),
  };
}

/** The exact runtime env the evidence script would build for a real run. */
function p07Environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...p07EvidenceRuntimeEnvironment(
      DATABASE_URL,
      parseProbeConfiguration(syntheticProbeEnvironment()),
    ),
    ...overrides,
  };
}

test('p07 evidence app origin is an exact https origin', () => {
  const url = new URL(PRODUCT_ORIGIN);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, PRODUCT_ORIGIN);
});

test('p07 evidence delivery origin is an exact https origin with no path/query/userinfo (i05 contract)', () => {
  const url = new URL(ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.equal(url.pathname, '/');
  assert.equal(url.origin, ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
});

test('p07 evidence origins are different registrable domains (never same-site)', () => {
  const appRegistrable = registrableDomain(new URL(PRODUCT_ORIGIN).hostname);
  const deliveryRegistrable = registrableDomain(new URL(ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN).hostname);
  assert.notEqual(
    appRegistrable,
    deliveryRegistrable,
    `app ${PRODUCT_ORIGIN} and delivery ${ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN} `
      + `must not share registrable domain ${appRegistrable}`,
  );
  assert.doesNotThrow(() => {
    assertDeliveryOriginNotSameSite(
      PRODUCT_ORIGIN,
      ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN,
      'ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN',
    );
  });
});

test('a same-site delivery origin is rejected by the production loader (regression pin)', () => {
  assert.throws(
    () => loadConfig(p07Environment({
      ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.example',
    })),
    /ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must not be same-site with the Known application origin/u,
    'https://delivery.known.example shares the known.example registrable domain with the app origin',
  );
});

test('the p07 evidence runtime environment parses through the real production loader with the fixed retention contract', () => {
  const config = loadConfig(p07Environment());
  assert.ok(config.attachments, 'p07 evidence env must produce the attachments section');
  assert.equal(config.attachments.enabled, true);
  assert.equal(config.attachments.isolatedDeliveryOrigin, ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
  assert.equal(config.productOrigin, PRODUCT_ORIGIN);
  assert.deepEqual(config.allowedOrigins, [PRODUCT_ORIGIN]);
  // The cleanup window advance (91 days) must exceed the retired retention,
  // and the production loader contract requires retired >= stored.
  assert.equal(config.attachments.retention.retiredRetentionDays, 90);
  assert.equal(config.attachments.retention.storedRetentionDays, 30);
  assert.equal(config.attachments.retention.intentRetentionHours, 24);
  assert.ok(config.attachments.retention.retiredRetentionDays < 91, 'the evidence advance crosses the retired window');
});

test('the p07 evidence retention contract rejects an invalid retired < stored pairing', () => {
  assert.throws(
    () => loadConfig(p07Environment({
      ATTACHMENTS_RETIRED_RETENTION_DAYS: '15',
      ATTACHMENTS_STORED_RETENTION_DAYS: '30',
    })),
    /ATTACHMENTS_RETIRED_RETENTION_DAYS must be at least ATTACHMENTS_STORED_RETENTION_DAYS/u,
    'retired retention below stored retention must fail closed in the production loader',
  );
});
