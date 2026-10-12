import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  createPostgresReplicaRetentionWindowPort, createPostgresSyncAckApplication,
  createPostgresSyncPullReadPort, createPostgresSyncSessionIssuer, createSyncPullCursorKeyring,
} from '../../../src/infrastructure/sync/index.js';
import { SyncAckError, SyncPullReadError } from '../../../src/modules/sync/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { COLLECTION, createSyncPullFixture, ISSUER, ORIGIN } from './sync-pull-fixture.js';

describeWithPostgres('Idle Session renewal acknowledgements', () => {
  const fixture = createSyncPullFixture('idle_session_renewal', false);

  test('accepts current checkpoint Acks across idle renewals and expired-cursor refresh', async () => {
    const scope = await fixture.createProtocolScope('0.2');
    const db = fixture.isolated.runtime.db;
    let cursorNow = Date.now();
    const keys = createSyncPullCursorKeyring({ active: { id: 'idle-renewal',
      secret: Buffer.alloc(32, 71).toString('base64') }, retained: [], ttlMs: 60_000,
      now: () => cursorNow });
    try {
      const reader = createPostgresSyncPullReadPort(db, keys, { cursorNow: () => cursorNow });
      const ack = createPostgresSyncAckApplication(db, {
        leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3600,
      });
      const issuer = createPostgresSyncSessionIssuer(db, {
        issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
        replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
        sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3600,
        tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
        endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
        pullCursorKeyring: keys, retentionWindow: createPostgresReplicaRetentionWindowPort('/snapshot'),
      });
      const replica = async () => {
        const row = await db.selectFrom('sync_replicas').selectAll()
          .where('replica_id', '=', scope.replica.replicaId).executeTakeFirstOrThrow();
        assert.equal(row.status, 'active');
        assert.equal(String(row.lease_generation), scope.replica.leaseGeneration);
        return row;
      };
      const issue = async () => {
        const facts = await replica();
        cursorNow += 1_000;
        const issued = await issuer.issue({ credential: scope.credential,
          idempotencyKey: randomUUID(), requestFingerprint: randomUUID(),
          collectionId: COLLECTION, replicaId: scope.replica.replicaId,
          expectedLeaseGeneration: String(facts.lease_generation),
          expectedLifecycleRevision: String(facts.lifecycle_revision), binding: scope.replica.binding,
          requestedScopes: ['sync:pull'], origin: ORIGIN, protocolVersion: '0.2' });
        assert.equal(issued.envelope.snapshotRequired, false);
        assert.equal((await replica()).checkpoint_cursor, issued.envelope.collectionCursor);
        return { id: issued.session.sessionId, cursor: issued.envelope.collectionCursor };
      };
      const pull = async (sessionId: string, cursor: string | null) => {
        const page = await reader.read({ credential: scope.credential, sessionId,
          collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor, limit: 100 });
        assert.equal(page.events.length, 0);
        await replica();
        return page;
      };
      const acknowledge = async (sessionId: string, cursor: string) => {
        // Make lease extension observable even though Session issuance also renews it.
        await db.updateTable('sync_replicas').set({ lease_expires_at: new Date(Date.now() + 30_000) })
          .where('replica_id', '=', scope.replica.replicaId).execute();
        const before = await replica();
        const input = { credential: scope.credential, origin: ORIGIN, mediaType: 'application/json',
          endpointIdentity: 'syncAck', idempotencyKey: randomUUID(),
          request: { sessionId, cursor, warnings: [] } };
        const result = await ack.acknowledge(input);
        assert.equal(result.replicaId, scope.replica.replicaId);
        assert.equal(result.ackedCursor, cursor);
        assert.ok(result.ackedAt);
        const after = await replica();
        assert.equal(after.checkpoint_cursor, cursor);
        assert.ok(after.lease_expires_at > before.lease_expires_at);
        assert.deepEqual(await ack.acknowledge(input), result);
        assert.equal((await replica()).lease_expires_at.getTime(), after.lease_expires_at.getTime());
        assert.equal((await db.selectFrom('sync_ack_receipts').selectAll()
          .where('idempotency_key', '=', input.idempotencyKey).execute()).length, 1);
      };

      const initial = await pull(scope.session.sessionId, null);
      await acknowledge(scope.session.sessionId, initial.nextCursor);
      const s2 = await issue();
      assert.notEqual(s2.cursor, initial.nextCursor);
      assert.equal((await pull(s2.id, s2.cursor)).nextCursor, s2.cursor);
      const s3 = await issue();
      const handoff = await pull(s3.id, s2.cursor);
      assert.equal(handoff.nextCursor, s3.cursor);
      assert.equal(handoff.cursorReissued, true);
      // The current checkpoint must still be bound to the requesting Session.
      await assert.rejects(ack.acknowledge({ credential: scope.credential, origin: ORIGIN,
        mediaType: 'application/json', endpointIdentity: 'syncAck', idempotencyKey: randomUUID(),
        request: { sessionId: s2.id, cursor: s3.cursor, warnings: [] } }),
      (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica');
      await replica();
      await acknowledge(s3.id, handoff.nextCursor);
      const s4 = await issue();
      await acknowledge(s4.id, (await pull(s4.id, s4.cursor)).nextCursor);

      cursorNow += 120_000;
      const s5 = await issue();
      await assert.rejects(pull(s5.id, s4.cursor),
        (error: unknown) => error instanceof SyncPullReadError && error.code === 'sync_cursor_expired');
      await replica();
      const s6 = await issue();
      await acknowledge(s6.id, (await pull(s6.id, s6.cursor)).nextCursor);
      assert.equal((await replica()).checkpoint_cursor, s6.cursor);
      assert.equal((await db.selectFrom('audit_events').selectAll()
        .where('event_type', '=', 'sync.replica.acknowledged').execute()).length, 4);
    } finally { keys.destroy(); }
  });
});
