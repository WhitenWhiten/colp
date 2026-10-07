/**
 * P4A-P03 evidence script origin-contract tests (plan §4 fail-closed config).
 *
 * The real-R2 evidence CLI (`scripts/phase4a-p03-evidence.ts`) builds its
 * runtime environment with `PRODUCT_ORIGIN=https://app.known.example` and an
 * isolated delivery origin. The delivery origin is credential-free and must
 * never be same-site with the application origin (i05 contract,
 * `assertDeliveryOriginNotSameSite` inside `loadConfig`); the pre-fix
 * hardcoded `https://delivery.known.example` shared the `known.example`
 * registrable domain and made the probe fail deterministically at
 * loadConfig time (`phase4a_p03_probe_failed:probe_failed`) before any
 * DB/R2 interaction.
 *
 * These tests import the REAL script constants and the REAL runtime-env
 * builder, so a regression back to a same-site delivery origin fails here
 * even though the probe itself cannot run inside a unit suite. Every env
 * fixture goes through the REAL production config loader (`loadConfig`),
 * never a directly constructed typed object (i05 config-contract pattern).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  parseProbeConfiguration,
} from '../../../scripts/evidence/phase4a-i01-capability-probe.js';
import {
  assertDeliveryOriginNotSameSite,
  registrableDomain,
} from '../../../src/modules/attachments/attachments-origin.js';
import {
  ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN,
  PRODUCT_ORIGIN,
  p03EvidenceRuntimeEnvironment,
} from '../../../scripts/phase4a-p03-evidence.js';

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
    P4A_R2_PROBE_PREFIX: 'capability-probes/local-20260808123456-p03-0123456789abcdef/',
    P4A_R2_ACCESS_KEY_ID: 'c'.repeat(32),
    P4A_R2_SECRET_ACCESS_KEY: 'd'.repeat(64),
    P4A_R2_READ_ACCESS_KEY_ID: 'a'.repeat(32),
    P4A_R2_READ_SECRET_ACCESS_KEY: 'b'.repeat(64),
  };
}

/** The exact runtime env the evidence script would build for a real run. */
function p03Environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...p03EvidenceRuntimeEnvironment(
      DATABASE_URL,
      parseProbeConfiguration(syntheticProbeEnvironment()),
    ),
    ...overrides,
  };
}

test('p03 evidence app origin is an exact https origin', () => {
  const url = new URL(PRODUCT_ORIGIN);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, PRODUCT_ORIGIN);
});

test('p03 evidence delivery origin is an exact https origin with no path/query/userinfo (i05 contract)', () => {
  const url = new URL(ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.equal(url.pathname, '/');
  assert.equal(url.origin, ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
});

test('p03 evidence origins are different registrable domains (never same-site)', () => {
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

test('the pre-fix same-site delivery origin is rejected by the production loader (regression pin)', () => {
  assert.throws(
    () => loadConfig(p03Environment({
      ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.example',
    })),
    /ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must not be same-site with the Known application origin/u,
    'https://delivery.known.example shares the known.example registrable domain with the app '
      + 'origin and must fail inside loadConfig (the deterministic P03 evidence defect)',
  );
});

test('the p03 evidence runtime environment parses through the real production loader', () => {
  const config = loadConfig(p03Environment());
  assert.ok(config.attachments, 'p03 evidence env must produce the attachments section');
  assert.equal(config.attachments.enabled, true);
  assert.equal(config.attachments.isolatedDeliveryOrigin, ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
  assert.equal(config.productOrigin, PRODUCT_ORIGIN);
  assert.deepEqual(config.allowedOrigins, [PRODUCT_ORIGIN]);
});
