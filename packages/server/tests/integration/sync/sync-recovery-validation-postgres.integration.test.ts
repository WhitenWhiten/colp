import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresSyncRecoveryApplication,
  createSyncPullCursorKeyring,
  createSyncRecoveryCapabilityKeyring,
  type PostgresSyncRecoveryOptions,
} from '../../../src/infrastructure/sync/index.js';
import { SyncAckError } from '../../../src/modules/sync/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';

describeWithPostgres('P3-24 recovery validation', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_recovery_validation', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 20_000);
  afterAll(async () => isolated?.close());

  test('rejects malformed or conflicting Snapshot page evidence without changing recovery authority', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'page-validation');
    const record = (overrides: Partial<{ sequence: number; startOffset: number; endOffset: number;
      complete: boolean; responseDigest: string }>) => fixture.application.recordSnapshotPage({
      credential: fixture.credential, sessionId: fixture.sessionId, snapshotId: fixture.snapshotId,
      sequence: 1, startOffset: 0, endOffset: 200, complete: false,
      responseDigest: 'page-validation-digest', ...overrides,
    });
    const rejectsWith = async (expectedCode: SyncAckError['code'], overrides: Parameters<typeof record>[0]) => {
      await assert.rejects(record(overrides),
        (error: unknown) => error instanceof SyncAckError && error.code === expectedCode);
    };

    await rejectsWith('stale_replica', {});
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    for (const malformed of [
      { sequence: 0 },
      { startOffset: -1 },
      { startOffset: 2, endOffset: 1 },
      { responseDigest: 'contains spaces' },
      { endOffset: 402 },
      { complete: true },
    ] as const) {
      await rejectsWith('invalid_document', malformed);
    }

    await record({});
    await rejectsWith('invalid_cursor_scope', { endOffset: 199, responseDigest: 'conflicting-page-digest' });
    const persisted = await isolated.runtime.db.selectFrom('sync_bootstrap_snapshot_pages')
      .select(['page_end_offset', 'response_digest']).where('snapshot_id', '=', fixture.snapshotId)
      .where('page_sequence', '=', 1).executeTakeFirstOrThrow();
    assert.deepEqual(persisted, { page_end_offset: 200, response_digest: 'page-validation-digest' });
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').select(['status', 'lease_generation'])
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
    assert.deepEqual({ status: replica.status, generation: replica.lease_generation.toString() },
      { status: 'recovery_required', generation: fixture.oldGeneration });
  });

  test('fails closed and rolls back when Ack authority drifts after capability issuance', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'ack-authority-drift');
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const capability = await fixture.application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    await isolated.runtime.db.updateTable('sync_collection_purge_state').set({
      purged_through_commit_ordinal: 43n, purged_through_stream_kind: 0,
      purged_through_stable_id: 'operation-43', state_revision: sql<bigint>`state_revision + 1`,
    }).where('collection_id', '=', fixture.collectionId).execute();

    await assert.rejects(fixture.application.bootstrapAcknowledge({ credential: fixture.credential,
      idempotencyKey: 'authority-drift-ack', sessionId: fixture.sessionId, capability,
      requestFingerprint: 'authority-drift-ack' }),
    (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica'
      && (error as { readonly authorityGuard?: string }).authorityGuard === 'recovery_ack_purge_boundary');
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').select(['status', 'lease_generation'])
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
    assert.deepEqual({ status: replica.status, generation: replica.lease_generation.toString() },
      { status: 'recovery_required', generation: fixture.oldGeneration });
    assert.equal(await isolated.runtime.db.selectFrom('sync_recovery_ack_receipts').select('idempotency_key')
      .where('replica_id', '=', fixture.replicaId).execute().then((rows) => rows.length), 0);
  });

  test('rejects capability issuance before recovery and after collection authority drifts', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'capability-authority-drift');
    const issue = () => fixture.application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    await assert.rejects(issue(),
      (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica');
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await isolated.runtime.db.updateTable('collections').set({ content_revision: 'content-r44' })
      .where('id', '=', fixture.collectionId).execute();
    await assert.rejects(issue(),
      (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica');
    assert.equal(await isolated.runtime.db.selectFrom('sync_recovery_capabilities').select('snapshot_id')
      .where('replica_id', '=', fixture.replicaId).execute().then((rows) => rows.length), 0);
  });

  test('validates recovery composition options before opening a transaction', () => {
    const capabilityKeys = createSyncRecoveryCapabilityKeyring({ active: {
      id: 'option-guard-key', secret: Buffer.alloc(32, 90).toString('base64'),
    }, retained: [], ttlMs: 300_000 });
    const pullCursorKeyring = createSyncPullCursorKeyring({ active: {
      id: 'option-guard-pull', secret: Buffer.alloc(32, 89).toString('base64'),
    }, retained: [], ttlMs: 300_000 });
    pullCursorKeyring.destroy();
    for (const options of [
      { capabilityKeys, leaseExtensionSeconds: 0, maxLeaseLifetimeSeconds: 3_600 },
      { capabilityKeys, leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 599 },
      { capabilityKeys, leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600, pullCursorKeyring,
        recoveryProofRetentionMs: 60_000 },
      { capabilityKeys, leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
        pullCursorKeyring: createSyncPullCursorKeyring({ active: {
          id: 'option-guard-retention', secret: Buffer.alloc(32, 88).toString('base64'),
        }, retained: [], ttlMs: 300_000 }), recoveryProofRetentionMs: 999 },
    ] satisfies readonly PostgresSyncRecoveryOptions[]) {
      assert.throws(() => createPostgresSyncRecoveryApplication(isolated.runtime.db, options),
        /Invalid recovery options/u);
    }
  });
});
