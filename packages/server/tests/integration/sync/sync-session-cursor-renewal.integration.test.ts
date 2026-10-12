import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { createPostgresSyncSessionIssuer, createPostgresReplicaRetentionWindowPort,
  createPostgresSyncAckApplication, createPostgresSyncPullReadPort,
  createSyncPullCursorKeyring } from '../../../src/infrastructure/sync/index.js';
import { createSyncPullFixture, COLLECTION, ORIGIN, ISSUER } from './sync-pull-fixture.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('Session checkpoint token renewal', () => {
  const fixture = createSyncPullFixture('session_cursor_renewal', false);
  test.each([false, true])('renews a retained checkpoint with expired lease=%s', async expiredLease => {
    const scope = await fixture.createProtocolScope('0.2');
    let cursorNow = Date.now();
    const keys = createSyncPullCursorKeyring({ active: { id: 'renewal',
      secret: Buffer.alloc(32, 71).toString('base64') }, retained: [], ttlMs: 60_000,
      now: () => cursorNow });
    try {
      const port = createPostgresSyncPullReadPort(fixture.isolated.runtime.db, keys,
        { cursorNow: () => cursorNow });
      const first = await port.read({ credential: scope.credential, sessionId: scope.session.sessionId,
        collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: null, limit: 100 });
      await createPostgresSyncAckApplication(fixture.isolated.runtime.db, {
        leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3600,
      }).acknowledge({ credential: scope.credential, origin: ORIGIN, mediaType: 'application/json',
        endpointIdentity: 'syncAck', idempotencyKey: randomUUID(), request: {
          sessionId: scope.session.sessionId, cursor: first.nextCursor, warnings: [],
        } });
      if (expiredLease) {
        // New server commits must not force Snapshot recovery while the entire
        // stream after the acknowledged position remains available.
        await fixture.isolated.runtime.pool.query(`update collections set commit_ordinal=commit_ordinal+1 where id=$1`, [COLLECTION]);
        await fixture.isolated.runtime.pool.query(`update sync_replicas set
          last_seen_at=current_timestamp - interval '2 seconds',
          lease_expires_at=current_timestamp - interval '1 second' where replica_id=$1`, [scope.replica.replicaId]);
      }
      cursorNow += 120_000;
      const facts = await fixture.isolated.runtime.db.selectFrom('sync_replicas')
        .select(['lease_generation', 'lifecycle_revision']).where('replica_id', '=', scope.replica.replicaId)
        .executeTakeFirstOrThrow();
      const issuer = createPostgresSyncSessionIssuer(fixture.isolated.runtime.db, {
        issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
        replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
        sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3600,
        tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
        endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
        pullCursorKeyring: keys, retentionWindow: createPostgresReplicaRetentionWindowPort('/snapshot'),
      });
      const result = await issuer.issue({ credential: scope.credential, idempotencyKey: randomUUID(),
        requestFingerprint: randomUUID(), collectionId: COLLECTION, replicaId: scope.replica.replicaId,
        expectedLeaseGeneration: String(facts.lease_generation), expectedLifecycleRevision: String(facts.lifecycle_revision),
        binding: scope.replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN, protocolVersion: '0.2' });
      assert.equal(result.envelope.snapshotRequired, false);
      assert.notEqual(result.envelope.collectionCursor, first.nextCursor);
      const pulled = await port.read({ credential: scope.credential, sessionId: result.session.sessionId,
        collectionId: COLLECTION, replicaId: scope.replica.replicaId,
        cursor: result.envelope.collectionCursor, limit: 100 });
      assert.equal(pulled.nextCursor, result.envelope.collectionCursor);
      assert.equal(pulled.events.length, 0);
    } finally { keys.destroy(); }
  });
});
