import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  PHASE3_SYNC_ENDPOINT_KEYS,
  createPhase3SyncHttpHarness,
  type StartedPhase3SyncHttpHarness,
} from '../../../scripts/evidence/phase3-sync-http-composition.js';
import {
  createPhase3SyncDeploymentProbe,
  runPhase3SyncHttpAcceptance,
  type Phase3SyncHttpAcceptanceEvidence,
} from '../../../scripts/acceptance/phase3-sync-http-acceptance.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { reserveTcpPort } from '../../support/runtime-process.js';
import { createCredentialFixture } from '../../../scripts/phase3-sync-http-acceptance-adapter.js';

describeWithPostgres('P3-04 private Sync HTTP composition black box', () => {
  let isolated: IsolatedPostgresRuntime;
  let deployment: StartedPhase3SyncHttpHarness;
  let evidence: Phase3SyncHttpAcceptanceEvidence;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase3_sync_http', {
      maxConnections: 10, applicationName: 'known-p3-04-sync-http',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const port = await reserveTcpPort();
    const manifest = JSON.parse(await readFile(
      resolve('tests/fixtures/phase3/sync-http-manifest.json'), 'utf8',
    ));
    const transport = JSON.parse(await readFile(
      resolve('tests/fixtures/phase3/sync-http-proxy.json'), 'utf8',
    ));
    const credential = await createCredentialFixture();
    deployment = await createPhase3SyncHttpHarness({
      database: isolated.runtime,
      manifest,
      transport,
      listen: { host: '127.0.0.1', port },
      credential,
    });
    const probe = createPhase3SyncDeploymentProbe({
      runtimeOrigin: deployment.origin,
      directRuntimeOrigin: deployment.directOrigin,
      manifestUrl: `${deployment.origin}/.well-known/collection-protocol`,
      fetch: deployment.fetch,
      postgres: deployment.postgresProbe,
      credentialAdapter: deployment.credentialProbe,
      allowedEndpointOrigins: ['https://sync-edge.example.test'],
      timeoutCancellation: deployment.timeoutCancellationProbe,
    });
    evidence = await runPhase3SyncHttpAcceptance(probe);
  }, 180_000);

  afterAll(async () => {
    await deployment?.close();
    await isolated?.close();
  });

  test('discovers all routes from the unclaimed Manifest and probes the actual port', () => {
    assert.equal(evidence.accepted, true);
    assert.equal(evidence.profileClaimed, false);
    assert.equal(evidence.runtimePort, Number(new URL(deployment.origin).port));
    assert.equal(evidence.mountedEndpoints.length, 6);
    assert.equal(evidence.deploymentProven, false);
  });

  test('runs credential -> verified Session -> exclusive Sequence -> Canonical Mutation for one push', () => {
    assert.equal(evidence.push.maxBatchOperations, 1);
    assert.equal(evidence.push.operationIdReservationOwner, 'sequence');
    assert.equal(evidence.push.usesPushCoordinator, false);
    assert.equal(evidence.push.canonicalMutationObserved, true);
    assert.equal(evidence.push.credentialKind, 'verified_extension_credential');
  });

  test.each(['session', 'idempotency'] as const)('binds %s input before Sequence admission', async (kind) => {
    const push = JSON.parse(await readFile(resolve('tests/fixtures/phase3/sync-http-push.json'), 'utf8'));
    if (kind === 'session') push.sessionId = 'other-session';
    const response = await deployment.fetch(new URL('/private-entry/operation-ingress', deployment.origin), {
      method: 'POST',
      headers: {
        authorization: deployment.credentialProbe.authorization,
        'idempotency-key': kind === 'idempotency' ? 'other-batch' : push.batchId,
        'content-type': 'application/vnd.collection-protocol.sync-push+json',
      },
      body: JSON.stringify(push),
    });
    assert.equal(response.status, 422);
  });

  test('covers raw headers, I-JSON budgets, timeout cancellation, ingress trust and rate classes', () => {
    assert.deepEqual(evidence.transport, {
      duplicateAuthorizationRejected: true,
      duplicateIdempotencyKeyRejected: true,
      duplicateIfMatchRejected: true,
      unsupportedMediaTypeRejected: true,
      duplicateJsonMemberRejected: true,
      unsafeIntegerRejected: true,
      depthBudgetRejected: true,
      memberBudgetRejected: true,
      byteBudgetRejected: true,
      timeoutCancelled: true,
      trustedIngressAccepted: true,
      spoofedForwardedHeadersRejected: true,
      rateLimitClasses: [
        'sync-session', 'sync-snapshot', 'sync-push', 'sync-pull', 'sync-ack', 'sync-conflict',
      ],
    });
  });

  test.each(PHASE3_SYNC_ENDPOINT_KEYS)('fails closed against a real runtime missing %s', async (key) => {
    const port = await reserveTcpPort();
    const manifest = JSON.parse(await readFile(
      resolve('tests/fixtures/phase3/sync-http-manifest.json'), 'utf8',
    ));
    const transport = JSON.parse(await readFile(
      resolve('tests/fixtures/phase3/sync-http-proxy.json'), 'utf8',
    ));
    const broken = await createPhase3SyncHttpHarness({
      database: isolated.runtime, manifest, transport,
      listen: { host: '127.0.0.1', port },
      credential: await createCredentialFixture(), omittedEndpoint: key,
    });
    try {
      const probe = createPhase3SyncDeploymentProbe({
        runtimeOrigin: broken.origin, directRuntimeOrigin: broken.directOrigin,
        manifestUrl: `${broken.origin}/.well-known/collection-protocol`, fetch: broken.fetch,
        postgres: broken.postgresProbe, credentialAdapter: broken.credentialProbe,
        timeoutCancellation: broken.timeoutCancellationProbe,
      });
      await assert.rejects(
        runPhase3SyncHttpAcceptance(probe),
        new RegExp(`${key}|404|rate-limit|timeout probe was not cancelled`, 'u'),
      );
    } finally {
      await broken.close();
    }
  }, 180_000);
});
