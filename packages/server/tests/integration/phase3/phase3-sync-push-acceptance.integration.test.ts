import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createPhase3SyncPushAcceptanceProbe } from '../../../scripts/phase3-sync-push-acceptance-adapter.js';
import { runPhase3SyncPushAcceptance } from '../../../scripts/acceptance/phase3-sync-push-acceptance.js';

describe('P3-16 real HTTP and PostgreSQL Sync Push acceptance', () => {
  let deployment: Awaited<ReturnType<typeof createPhase3SyncPushAcceptanceProbe>>;

  beforeAll(async () => {
    deployment = await createPhase3SyncPushAcceptanceProbe({ env: process.env });
  }, 30_000);
  afterAll(async () => deployment?.close());

  test('accepts P3-10 through P3-15 only after all durable scenarios pass', async () => {
    const evidence = await runPhase3SyncPushAcceptance(deployment.probe);
    assert.equal(evidence.accepted, true);
    assert.equal(evidence.profileClaimed, false);
    assert.equal(evidence.deploymentProven, false);
    assert.equal(evidence.sequenceOwner, 'sequence');
    assert.equal(evidence.maxBatchOperations, 1);
    assert.ok(Object.values(evidence.scenarios).every((passed) => passed === true));
  }, 300_000);

  test('negative controls fail closed for PostgreSQL, route, migration, and scenario omission', async () => {
    assert.deepEqual(await deployment.verifyNegativeControls(), [
      'postgres-connectivity', 'production-migration', 'runtime-route', 'scenario-omission',
    ]);
  }, 30_000);
});
