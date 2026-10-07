/**
 * P4A-I15 secret marker scan over logs/metrics/reports.
 *
 * A single synthetic marker is placed into credential values, the control
 * token, provider error fixtures, and PITR key material. Every I15 ops output
 * (rotation result + log entries, drift report, readiness payload, metrics
 * snapshot, alert verdicts, PITR reconcile report) must serialize WITHOUT the
 * marker, and metric cardinality stays fixed (unknown labels throw).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'vitest';
import {
  DEFAULT_ATTACHMENT_ALERT_CONFIG,
  createAttachmentMetricsStore,
  detectAttachmentControlDrift,
  evaluateAttachmentAlerts,
  evaluateAttachmentsCapabilityReadiness,
  recordAttachmentMetric,
  reconcileGenerationLedger,
  rotateAttachmentCredentials,
  snapshotAttachmentMetrics,
  type AttachmentBacklogSample,
  type AttachmentMetricLabels,
  type AttachmentRotationTarget,
} from '../../../src/modules/attachments/index.js';
import {
  InMemoryPitrLedger,
  RecordingPitrStore,
  credentialValueKey,
  makeS3Credential,
  makeSecretResolver,
  pitrRowFor,
} from '../../support/phase4a-i15-test-helpers.js';
import { makeI14Config } from '../../support/phase4a-i14-test-helpers.js';

test('no I15 ops output may serialize the injected secret marker', async () => {
  const marker = `secret-marker-${randomUUID()}`;

  // 1. Rotation: the marker is the NEW credential value; the rotated world
  //    only accepts the new value. Result + log entries must not contain it.
  const target: AttachmentRotationTarget = {
    role: 'rw',
    currentSecretRef: 'known/r2/rw/primary',
    newSecretRef: 'known/r2/rw/next',
  };
  const newValue = makeS3Credential(`AK-${marker}`, marker);
  const oldValue = makeS3Credential('AK-old', 'old-secret');
  const resolver = makeSecretResolver({
    [target.newSecretRef]: newValue,
    [target.currentSecretRef]: oldValue,
  });
  const builder: import('../../../src/modules/attachments/index.js').AttachmentCredentialStoreBuilder = {
    build(_role: string, _credential: import('../../../src/modules/attachments/index.js').AttachmentCredentialValue) {
      return {
        async probe(_role: string, candidate: import('../../../src/modules/attachments/index.js').AttachmentCredentialValue) {
          return credentialValueKey(candidate) === credentialValueKey(newValue)
            ? { ok: true, detail: 'ok' }
            : { ok: false, detail: 'denied' };
        },
      };
    },
  };
  const logEntries: Array<{ class: string; role: string; detail: string }> = [];
  const rotation = await rotateAttachmentCredentials({
    target, resolver, storeBuilder: builder as never, log: (entry) => logEntries.push(entry as never),
  });
  assert.ok(!JSON.stringify(rotation).includes(marker), 'rotation result must not leak the credential marker');
  assert.ok(!JSON.stringify(logEntries).includes(marker), 'rotation logs must not leak the credential marker');

  // 2. Drift: the marker is the control token and appears in provider errors.
  const fixture = JSON.parse(await readFile(
    resolve('tests/fixtures/phase4a/r2-control-api.private.json'), 'utf8',
  ));
  fixture.bucket.errors = [{ code: 10000, message: `denied ${marker}` }];
  fixture.bucket.success = false;
  const driftFetch = (async () => new Response(JSON.stringify(fixture.bucket), {
    status: 429, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  const drift = await detectAttachmentControlDrift({
    expected: {
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'known-quarantine-production',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      livePrefix: 'attachments/live/', probePrefix: 'capability-probes/',
      quarantinePrefix: 'quarantine/v1/', probeObjectsMaximumAgeSeconds: 86_400,
    },
    token: marker,
    fetchImpl: driftFetch,
  });
  assert.ok(!JSON.stringify(drift).includes(marker), 'drift report must not leak the control token or raw errors');

  // 3. Readiness: extended payload never contains the marker.
  const readiness = evaluateAttachmentsCapabilityReadiness(makeI14Config(), {
    admission: { enabled: true },
    worker: { verificationBacklog: 1, cleanupBacklog: 0 },
    delivery: { hostAvailable: true },
  });
  assert.ok(!JSON.stringify(readiness).includes(marker));

  // 4. Metrics: snapshot + alert verdicts never contain the marker.
  const metrics = createAttachmentMetricsStore();
  recordAttachmentMetric(metrics, {
    operation: 'verify', state: 'ok', errorClass: 'none',
    sizeBucket: 'under_1mib', latencyBucket: 'under_1s', rateLimitDecision: 'none',
  } satisfies AttachmentMetricLabels);
  metrics.recordBacklogSample({
    atIso: '2026-08-08T00:00:00.000Z', verificationBacklog: 10, cleanupBacklog: 0,
    quarantineCount: 0, deadLetterCount: 0,
  } satisfies AttachmentBacklogSample);
  assert.ok(!JSON.stringify(snapshotAttachmentMetrics(metrics)).includes(marker));
  const alerts = evaluateAttachmentAlerts({
    samples: [{
      atIso: '2026-08-08T00:00:00.000Z', verificationBacklog: 10, cleanupBacklog: 0,
      quarantineCount: 0, deadLetterCount: 0,
    }],
    config: DEFAULT_ATTACHMENT_ALERT_CONFIG,
  });
  assert.ok(!JSON.stringify(alerts).includes(marker));

  // 5. PITR: the marker is embedded in physical key material; the report must
  //    never serialize it.
  const ledger = new InMemoryPitrLedger();
  ledger.setRows([pitrRowFor(20, { key: `attachments/live/${marker}` })]);
  const store = new RecordingPitrStore();
  store.seed(`attachments/live/${marker}`, '"etag-x"', 7);
  const pitr = await reconcileGenerationLedger({ ledger, objectStore: store });
  assert.ok(!JSON.stringify(pitr).includes(marker), 'reconcile report must never leak physical keys');

  // 6. Metric cardinality: a label outside the fixed allowlist throws, so the
  //    metric space can never grow with blob/principal/filename/digest/URL.
  const cardinalityStore = createAttachmentMetricsStore();
  assert.throws(
    () => recordAttachmentMetric(cardinalityStore, { operation: 'issue', state: 'ok', errorClass: 'none', sizeBucket: 'under_1mib', latencyBucket: 'under_1s', principalId: marker } as never),
    /not_a_fixed/,
  );
});