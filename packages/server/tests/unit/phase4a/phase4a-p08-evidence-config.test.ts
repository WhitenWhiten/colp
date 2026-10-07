/**
 * P4A-P08 evidence script config-contract tests (plan §4 fail-closed config).
 *
 * The real-R2 evidence CLI (`scripts/phase4a-p08-evidence.ts`) builds its
 * runtime environment with `PRODUCT_ORIGIN=https://app.known.example`, a
 * credential-free isolated delivery origin on a DIFFERENT registrable domain,
 * and the fixed short delivery-capability window (60s) that the P08
 * expiry/replay contract is built on. The delivery origin must never be
 * same-site with the application origin (i05 contract), and the whole env
 * must parse through the REAL production loader (`loadConfig`).
 *
 * These tests import the REAL script constants and the REAL runtime-env
 * builder, so a regression fails here even though the probe itself cannot run
 * inside a unit suite. Every env fixture goes through the REAL production
 * config loader, never a directly constructed typed object.
 *
 * The suite ALSO pins the evidence-serialization low-sensitivity contract
 * (the real 5th run died at the `sanitizeEvidence` boundary): the
 * `production_route_download_admission` scenario record must never record the
 * raw delivery-origin URL — only the boolean
 * `deliveryOriginMatchesContract` fact — and no other scenario record may
 * embed a URL literal or a URL-shaped field (static source pin).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  parseProbeConfiguration,
  sanitizeEvidence,
} from '../../../scripts/evidence/phase4a-i01-capability-probe.js';
import {
  assertDeliveryOriginNotSameSite,
  registrableDomain,
} from '../../../src/modules/attachments/attachments-origin.js';
import {
  ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN,
  PRODUCT_ORIGIN,
  productionRouteDownloadAdmissionScenario,
  p08EvidenceRuntimeEnvironment,
} from '../../../scripts/phase4a-p08-evidence.js';

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
    P4A_R2_PROBE_PREFIX: 'capability-probes/local-20260808123456-p08-0123456789abcdef/',
    P4A_R2_ACCESS_KEY_ID: 'c'.repeat(32),
    P4A_R2_SECRET_ACCESS_KEY: 'd'.repeat(64),
    P4A_R2_READ_ACCESS_KEY_ID: 'a'.repeat(32),
    P4A_R2_READ_SECRET_ACCESS_KEY: 'b'.repeat(64),
  };
}

/** The exact runtime env the evidence script would build for a real run. */
function p08Environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...p08EvidenceRuntimeEnvironment(
      DATABASE_URL,
      parseProbeConfiguration(syntheticProbeEnvironment()),
    ),
    ...overrides,
  };
}

test('p08 evidence app origin is an exact https origin', () => {
  const url = new URL(PRODUCT_ORIGIN);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, PRODUCT_ORIGIN);
});

test('p08 evidence delivery origin is an exact https origin with no path/query/userinfo (i05 contract)', () => {
  const url = new URL(ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.equal(url.pathname, '/');
  assert.equal(url.origin, ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
});

test('p08 evidence origins are different registrable domains (never same-site)', () => {
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
    () => loadConfig(p08Environment({
      ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.example',
    })),
    /ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN must not be same-site with the Known application origin/u,
    'https://delivery.known.example shares the known.example registrable domain with the app origin',
  );
});

test('the p08 evidence runtime environment parses through the real production loader with the fixed short delivery window', () => {
  const config = loadConfig(p08Environment());
  assert.ok(config.attachments, 'p08 evidence env must produce the attachments section');
  assert.equal(config.attachments.enabled, true);
  assert.equal(config.attachments.isolatedDeliveryOrigin, ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN);
  assert.equal(config.productOrigin, PRODUCT_ORIGIN);
  assert.deepEqual(config.allowedOrigins, [PRODUCT_ORIGIN]);
  // The fixed short capability window the P08 expiry/replay contract builds on.
  assert.equal(config.attachments.deliveryCapabilityTtlSeconds, 60);
  // The evidence replacement proof needs the old generation retired within
  // the run: retired retention must be >= stored retention (loader contract).
  assert.equal(config.attachments.retention.retiredRetentionDays, 90);
  assert.equal(config.attachments.retention.storedRetentionDays, 30);
  assert.equal(config.attachments.retention.intentRetentionHours, 24);
});

test('the p08 evidence delivery window is bounded by the compile-time maximum (1..120s)', () => {
  assert.throws(
    () => loadConfig(p08Environment({ ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '121' })),
    /ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS must be <= 120/u,
    'a capability window above the fixed maximum must fail closed',
  );
  assert.throws(
    () => loadConfig(p08Environment({ ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '0' })),
    /ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS must be a safe integer >= 1/u,
    'a zero/negative capability window must fail closed',
  );
});

test('the p08 evidence retention contract rejects an invalid retired < stored pairing', () => {
  assert.throws(
    () => loadConfig(p08Environment({
      ATTACHMENTS_RETIRED_RETENTION_DAYS: '15',
      ATTACHMENTS_STORED_RETENTION_DAYS: '30',
    })),
    /ATTACHMENTS_RETIRED_RETENTION_DAYS must be at least ATTACHMENTS_STORED_RETENTION_DAYS/u,
    'retired retention below stored retention must fail closed in the production loader',
  );
});

test('the production_route_download_admission scenario record has no URL-shaped field and sanitizes cleanly', () => {
  // The 5th real-R2 run died at the evidence serialization boundary: the
  // scenario recorded the raw admission DTO origin
  // (ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN, an https URL), and the shared
  // sanitizer rejects ANY string shaped like https?:// with
  // sensitive_evidence_value. The record must pin ONLY the boolean fact that
  // the admitted origin equals the configured contract — the URL itself must
  // never be recorded.
  const record = productionRouteDownloadAdmissionScenario({
    status: 200,
    generationId: 'generation-3f2f0a8e-7c6d-4b1a-9e0d-2c4b8a1f6e3d',
    deliveryOrigin: ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN,
    windowMs: 60_000,
  });
  assert.deepEqual(record, {
    scenario: 'production_route_download_admission',
    status: 200,
    generationId: 'generation-3f2f0a8e-7c6d-4b1a-9e0d-2c4b8a1f6e3d',
    deliveryOriginMatchesContract: true,
    windowMs: 60_000,
  }, 'the scenario record must be exactly the low-sensitivity shape — any re-added '
    + 'deliveryOrigin/downloadUrl field (or any other URL-shaped value) fails this pin');
  assert.equal('deliveryOrigin' in record, false, 'the raw delivery-origin URL field must never be recorded');
  assert.equal('downloadUrl' in record, false, 'the one-time capability URL must never be recorded');
  assert.equal(JSON.stringify(record).match(/https?:\/\//u), null,
    'no URL-shaped value may appear anywhere in the record');
  assert.doesNotThrow(() => sanitizeEvidence(record),
    'the constructed scenario record must pass the shared evidence sanitizer');
});

test('deliveryOriginMatchesContract is true exactly when the DTO origin equals the isolated delivery origin contract', () => {
  const matching = productionRouteDownloadAdmissionScenario({
    status: 200, generationId: 'generation-1', deliveryOrigin: ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN, windowMs: 60_000,
  });
  assert.equal(matching.deliveryOriginMatchesContract, true);
  const foreign = productionRouteDownloadAdmissionScenario({
    status: 200, generationId: 'generation-1', deliveryOrigin: 'https://delivery.foreign.invalid', windowMs: 60_000,
  });
  assert.equal(foreign.deliveryOriginMatchesContract, false);
  assert.equal('deliveryOrigin' in foreign, false,
    'even a diverged origin must never be recorded into the scenario record');
  assert.doesNotThrow(() => sanitizeEvidence(foreign),
    'the sanitizer must accept the record even when the observed origin diverged (fail-closed shape)');
});

test('the full p08 evidence artifact serializes through the shared sanitizer without sensitive_evidence_value', () => {
  // The exact serialization boundary that killed the real 5th run:
  // process.stdout.write(JSON.stringify(sanitizeEvidence(evidence, ...))).
  const evidence = {
    schemaVersion: 1, task: 'phase4a-p08', target: 'cloudflare-r2-direct-object-api',
    providerMode: 'presigned-single-put-create-only-ledger-first',
    exposureMode: 'owner-private-unscanned-isolated-delivery',
    capabilities: [], scenarios: [
      productionRouteDownloadAdmissionScenario({
        status: 200, generationId: 'generation-1', deliveryOrigin: ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN, windowMs: 60_000,
      }),
    ], nonce: 'nonce-1',
  };
  assert.doesNotThrow(() => sanitizeEvidence(evidence),
    'the artifact containing the admission scenario must serialize without sensitive_evidence_value');
});

test('no inline p08 scenario record embeds a URL literal or a URL-shaped field name (static source pin)', () => {
  const source = readFileSync('scripts/phase4a-p08-evidence.ts', 'utf8');
  const pushes = [...source.matchAll(/scenarios\.push\(([\s\S]*?)\);/gu)].map((match) => match[1]!);
  assert.ok(pushes.length >= 9, 'the evidence script must keep pushing per-scenario evidence records');
  for (const block of pushes) {
    // The admission record goes through the exported low-sensitivity builder,
    // whose OUTPUT shape is pinned by the deepEqual/sanitizer tests above;
    // its INPUT deliberately carries the raw DTO origin, so it is exempt here.
    if (block.startsWith('productionRouteDownloadAdmissionScenario(')) continue;
    assert.doesNotMatch(block, /https?:\/\//u,
      `an inline scenario record must not embed a URL literal: ${block.trim()}`);
    assert.doesNotMatch(block, /\b(?:deliveryOrigin|downloadUrl|boundOrigin|appOrigin|endpoint)\s*:/u,
      `an inline scenario record must not reference a URL-shaped field: ${block.trim()}`);
  }
});
