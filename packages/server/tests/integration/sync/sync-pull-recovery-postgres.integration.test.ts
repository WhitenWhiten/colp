import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { join, resolve } from 'node:path';

import { test } from 'vitest';



import { createPostgresSyncAckApplication, createPostgresSyncPullReadPort } from '../../../src/infrastructure/sync/index.js';

import { createSyncPullCursorKeyring, SyncPullReadError } from '../../../src/modules/sync/index.js';



import { describeWithPostgres } from '../../support/postgres-test-runtime.js';


import { createSyncPullFixture, ACCOUNT, COLLECTION, ORIGIN } from './sync-pull-fixture.js';

describeWithPostgres('P3-20 sync-pull-recovery-postgres.integration.test.ts', () => {
  const pullFixture = createSyncPullFixture('p3_pull_1', true);
  const { seedCollection, createProtocolScope, operation, insertOperation, insertConflict, reader, countPersistenceStatements, seedOperationBatch } = pullFixture;

  test('commits recovery-required state for an expired cursor with exact durable evidence', async () => {
    const expired = await createProtocolScope('0.1');
    let now = Date.now();
    const keys = createSyncPullCursorKeyring({
      active: { id: 'p3-20-expired', secret: Buffer.alloc(32, 41).toString('base64') },
      retained: [], ttlMs: 60_000, now: () => now,
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, { cursorNow: () => now });
    const input = { credential: expired.credential, sessionId: expired.session.sessionId,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId, limit: 2 } as const;
    const first = await port.read({ ...input, cursor: null });
    await createPostgresSyncAckApplication(pullFixture.isolated.runtime.db, {
      leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
    }).acknowledge({ credential: expired.credential, idempotencyKey: `p3-20-expired-checkpoint-${randomUUID()}`,
      origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: expired.session.sessionId, cursor: first.nextCursor, warnings: [] } });
    now += 120_000;
    await assert.rejects(port.read({ ...input, cursor: first.nextCursor }),
      (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    const replica = await pullFixture.isolated.runtime.pool.query<{ status: string; lifecycle_revision: string }>(
      'select status,lifecycle_revision::text from sync_replicas where replica_id=$1', [expired.replica.replicaId]);
    assert.deepEqual(replica.rows[0], { status: 'recovery_required', lifecycle_revision: '2' });
    const audit = await pullFixture.isolated.runtime.pool.query<{ details_json: { reason?: string } }>(`select payload.details_json
      from audit_events event join audit_event_payloads payload on payload.event_id=event.id
      where event.event_type='sync.replica.lifecycle.recovery_required'
        and payload.details_json->>'replicaId'=$1 order by event.created_at desc limit 1`, [expired.replica.replicaId]);
    assert.equal(audit.rows[0]?.details_json.reason, 'cursor_expired');
    keys.destroy();
  });

  test('commits recovery after a proven checkpoint cursor expires across an ordinary Session renewal', async () => {
    const expired = await createProtocolScope('0.1');
    let now = Date.now();
    const keys = createSyncPullCursorKeyring({
      active: { id: 'p3-38-expired-handoff', secret: Buffer.alloc(32, 43).toString('base64') },
      retained: [], ttlMs: 60_000, now: () => now,
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, {
      recoveryProofRetentionMs: 180_000, cursorNow: () => now,
    });
    const first = await port.read({ credential: expired.credential, sessionId: expired.session.sessionId,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId, cursor: null, limit: 2 });
    await createPostgresSyncAckApplication(pullFixture.isolated.runtime.db, {
      leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
    }).acknowledge({ credential: expired.credential, idempotencyKey: `p3-38-checkpoint-${randomUUID()}`,
      origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: expired.session.sessionId, cursor: first.nextCursor, warnings: [] } });
    const current = (await pullFixture.isolated.runtime.pool.query<{
      lease_generation: string; lifecycle_revision: string;
    }>(`select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1`,
    [expired.replica.replicaId])).rows[0]!;
    const renewed = await expired.issuer.issue({
      credential: expired.credential, idempotencyKey: `p3-38-expired-renew-${randomUUID()}`,
      requestFingerprint: `p3-38-expired-renew-fingerprint-${randomUUID()}`,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId,
      expectedLeaseGeneration: current.lease_generation,
      expectedLifecycleRevision: current.lifecycle_revision,
      binding: expired.replica.binding, requestedScopes: ['sync:pull'],
      origin: ORIGIN,
    });
    now += 120_000;
    await assert.rejects(port.read({ credential: expired.credential,
      sessionId: renewed.session.sessionId, collectionId: COLLECTION,
      replicaId: expired.replica.replicaId, cursor: first.nextCursor, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    const replica = await pullFixture.isolated.runtime.pool.query<{ status: string; lease_generation: string }>(
      'select status,lease_generation::text from sync_replicas where replica_id=$1', [expired.replica.replicaId]);
    assert.deepEqual(replica.rows[0], { status: 'recovery_required', lease_generation: current.lease_generation });
    const proof = await pullFixture.isolated.runtime.pool.query<{ cursor_digest: string;
      proof_expires_at: Date; authority_lifecycle_revision: string }>(`select cursor_digest,
        proof_expires_at,authority_lifecycle_revision::text from sync_pull_cursor_recovery_proofs
        where replica_id=$1`, [expired.replica.replicaId]);
    assert.equal(proof.rowCount! > 0, true);
    assert.ok(proof.rows.every((row) => row.proof_expires_at.getTime() > now));
    assert.equal(proof.rows[0]!.authority_lifecycle_revision, '1');
    keys.destroy();
  });

  test('serializes concurrent expired checkpoint Pulls into one recovery transition', async () => {
    const expired = await createProtocolScope('0.1'); let now = Date.now();
    const keys = createSyncPullCursorKeyring({ active: { id: 'p3-38-expired-concurrent',
      secret: Buffer.alloc(32, 46).toString('base64') }, retained: [], ttlMs: 60_000, now: () => now });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, {
      recoveryProofRetentionMs: 180_000, cursorNow: () => now,
    });
    const input = { credential: expired.credential, sessionId: expired.session.sessionId,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId, limit: 2 } as const;
    const first = await port.read({ ...input, cursor: null });
    await createPostgresSyncAckApplication(pullFixture.isolated.runtime.db, {
      leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
    }).acknowledge({ credential: expired.credential, idempotencyKey: `p3-38-concurrent-${randomUUID()}`,
      origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: expired.session.sessionId, cursor: first.nextCursor, warnings: [] } });
    now += 120_000;
    const outcomes = await Promise.allSettled([
      port.read({ ...input, cursor: first.nextCursor }),
      port.read({ ...input, cursor: first.nextCursor }),
    ]);
    assert.equal(outcomes.every((outcome) => outcome.status === 'rejected'
      && outcome.reason instanceof SyncPullReadError && outcome.reason.code === 'recovery_required'), true);
    const audit = await pullFixture.isolated.runtime.pool.query<{ count: string }>(`select count(*)::text as count
      from audit_events event join audit_event_payloads payload on payload.event_id=event.id
      where event.event_type='sync.replica.lifecycle.recovery_required'
        and payload.details_json->>'replicaId'=$1`, [expired.replica.replicaId]);
    assert.equal(audit.rows[0]?.count, '1');
    const proof = await pullFixture.isolated.runtime.pool.query<{ consumed_at: Date | null }>(`select consumed_at
      from sync_pull_cursor_recovery_proofs where replica_id=$1 and consumed_at is not null`,
    [expired.replica.replicaId]);
    assert.equal(proof.rowCount, 1);
    assert.equal(proof.rows[0]?.consumed_at instanceof Date, true);
    keys.destroy();
  });

  test('does not turn expired cross-Session replays outside durable authority lineage into recovery', async () => {
    const expired = await createProtocolScope('0.1');
    let now = Date.now();
    const keys = createSyncPullCursorKeyring({
      active: { id: 'p3-38-expired-negative', secret: Buffer.alloc(32, 44).toString('base64') },
      retained: [], ttlMs: 60_000, now: () => now,
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, {
      recoveryProofRetentionMs: 60_000, cursorNow: () => now,
    });
    const unissued = keys.sign({ replicaId: expired.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: expired.replica.leaseGeneration, sessionId: expired.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' } });
    const current = (await pullFixture.isolated.runtime.pool.query<{
      lease_generation: string; lifecycle_revision: string;
    }>(`select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1`,
    [expired.replica.replicaId])).rows[0]!;
    const renewed = await expired.issuer.issue({ credential: expired.credential,
      idempotencyKey: `p3-38-negative-renew-${randomUUID()}`,
      requestFingerprint: `p3-38-negative-renew-fingerprint-${randomUUID()}`,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId,
      expectedLeaseGeneration: current.lease_generation,
      expectedLifecycleRevision: current.lifecycle_revision, binding: expired.replica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN });
    now += 120_000;
    await assert.rejects(port.read({ credential: expired.credential,
      sessionId: renewed.session.sessionId, collectionId: COLLECTION,
      replicaId: expired.replica.replicaId, cursor: unissued, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'invalid_cursor_scope');
    const replica = await pullFixture.isolated.runtime.pool.query<{ status: string }>(
      'select status from sync_replicas where replica_id=$1', [expired.replica.replicaId]);
    assert.equal(replica.rows[0]?.status, 'active');
    keys.destroy();
  });

  test('does not mutate Replica state for an expired cursor without durable evidence', async () => {
    const expired = await createProtocolScope('0.1');
    let now = Date.now();
    const keys = createSyncPullCursorKeyring({
      active: { id: 'p3-20-unproven', secret: Buffer.alloc(32, 42).toString('base64') },
      retained: [], ttlMs: 60_000, now: () => now,
    });
    const context = { replicaId: expired.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: expired.replica.leaseGeneration, sessionId: expired.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' } };
    const unproven = keys.sign({ ...context, tuple: {
      commitOrdinal: '0', streamKind: 'operation', stableId: '',
    } });
    now += 120_000;
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys);
    await assert.rejects(port.read({ credential: expired.credential, sessionId: expired.session.sessionId,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId, cursor: unproven, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'sync_cursor_expired');
    const replica = await pullFixture.isolated.runtime.pool.query<{ status: string }>(
      'select status from sync_replicas where replica_id=$1', [expired.replica.replicaId]);
    assert.equal(replica.rows[0]?.status, 'active');
    keys.destroy();
  });

  test('answers sync_cursor_expired for a verified cursor whose anchor row is gone (F026)', async () => {
    const missing = await createProtocolScope('0.1');
    const runtime = reader();
    // A signature+scope-valid cursor whose anchor tuple resolves to no row: the
    // evidence horizon moved past it (or the store cannot prove the position).
    // The contract answer is 410 sync_cursor_expired, never invalid_cursor_scope.
    const unresolvable = runtime.keys.sign({
      replicaId: missing.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: missing.replica.leaseGeneration, sessionId: missing.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: '999999', streamKind: 'operation', stableId: 'anchor-row-gone' },
    });
    await assert.rejects(runtime.port.read({ credential: missing.credential,
      sessionId: missing.session.sessionId, collectionId: COLLECTION,
      replicaId: missing.replica.replicaId, cursor: unresolvable, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'sync_cursor_expired');
    // The Replica is not transitioned — an unresolvable anchor is a cursor
    // problem, and recovery stays a client-driven snapshot decision.
    const replica = await pullFixture.isolated.runtime.pool.query<{ status: string }>(
      'select status from sync_replicas where replica_id=$1', [missing.replica.replicaId]);
    assert.equal(replica.rows[0]?.status, 'active');
    // A scope-mismatched signature still answers invalid_cursor_scope (400).
    const other = await createProtocolScope('0.1');
    await assert.rejects(runtime.port.read({ credential: missing.credential,
      sessionId: missing.session.sessionId, collectionId: COLLECTION,
      replicaId: missing.replica.replicaId, cursor: runtime.keys.sign({
        replicaId: other.replica.replicaId, collectionId: COLLECTION,
        leaseGeneration: other.replica.leaseGeneration, sessionId: other.session.sessionId,
        principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
        purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
        tuple: { commitOrdinal: '999999', streamKind: 'operation', stableId: 'anchor-row-gone' },
      }), limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'invalid_cursor_scope');
    runtime.keys.destroy();
  });

  test('does not let a durable but unacknowledged issued cursor force checkpoint recovery', async () => {
    const expired = await createProtocolScope('0.1'); let now = Date.now();
    const keys = createSyncPullCursorKeyring({ active: { id: 'p3-38-unacked-proof',
      secret: Buffer.alloc(32, 45).toString('base64') }, retained: [], ttlMs: 60_000, now: () => now });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, {
      recoveryProofRetentionMs: 60_000, cursorNow: () => now,
    });
    const first = await port.read({ credential: expired.credential, sessionId: expired.session.sessionId,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId, cursor: null, limit: 2 });
    now += 120_000;
    await assert.rejects(port.read({ credential: expired.credential, sessionId: expired.session.sessionId,
      collectionId: COLLECTION, replicaId: expired.replica.replicaId, cursor: first.nextCursor, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'sync_cursor_expired');
    assert.equal((await pullFixture.isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', expired.replica.replicaId).executeTakeFirstOrThrow()).status, 'active');
    keys.destroy();
  });

  test('commits recovery-required state when a valid 0.2 cursor predates the effect cutover', async () => {
    const stale = await createProtocolScope('0.2');
    const fixture = await pullFixture.isolated.runtime.pool.connect();
    try {
      await fixture.query('begin');
      await fixture.query('alter table sync_collection_effect_cutovers disable trigger sync_collection_effect_cutovers_immutable');
      await fixture.query("select set_config('known.sync_authority','server',true)");
      await fixture.query('update sync_collection_effect_cutovers set effect_cutover_ordinal=10 where collection_id=$1',
        [COLLECTION]);
      await fixture.query('alter table sync_collection_effect_cutovers enable trigger sync_collection_effect_cutovers_immutable');
      await fixture.query('commit');
    } catch (error) {
      await fixture.query('rollback'); throw error;
    } finally { fixture.release(); }
    const runtime = reader();
    const cursor = runtime.keys.sign({
      replicaId: stale.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: stale.replica.leaseGeneration, sessionId: stale.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.2', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
    });
    await assert.rejects(runtime.port.read({ credential: stale.credential, sessionId: stale.session.sessionId,
      collectionId: COLLECTION, replicaId: stale.replica.replicaId, cursor, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    const replica = await pullFixture.isolated.runtime.pool.query<{ status: string; lifecycle_revision: string }>(
      'select status,lifecycle_revision::text from sync_replicas where replica_id=$1', [stale.replica.replicaId]);
    assert.deepEqual(replica.rows[0], { status: 'recovery_required', lifecycle_revision: '2' });
    const audit = await pullFixture.isolated.runtime.pool.query<{ details_json: { reason?: string } }>(`select payload.details_json
      from audit_events event join audit_event_payloads payload on payload.event_id=event.id
      where event.event_type='sync.replica.lifecycle.recovery_required'
        and payload.details_json->>'replicaId'=$1 order by event.created_at desc limit 1`, [stale.replica.replicaId]);
    assert.equal(audit.rows[0]?.details_json.reason, 'effect_cutover');
    runtime.keys.destroy();
  });

  test('continues from a cursor exactly at the inclusive purge watermark', async () => {
    const equal = await createProtocolScope('0.1'); const runtime = reader();
    const boundary = { commitOrdinal: 900_000n, streamKind: 0, stableId: 'purged-through' };
    try {
      await pullFixture.isolated.runtime.db.updateTable('sync_collection_purge_state').set({
        purged_through_commit_ordinal: boundary.commitOrdinal,
        purged_through_stream_kind: boundary.streamKind,
        purged_through_stable_id: boundary.stableId,
        state_revision: 1n,
      }).where('collection_id', '=', COLLECTION).execute();
      const first = await runtime.port.read({ credential: equal.credential, sessionId: equal.session.sessionId,
        collectionId: COLLECTION, replicaId: equal.replica.replicaId, cursor: null, limit: 2 });
      assert.deepEqual(first.nextTuple, { commitOrdinal: boundary.commitOrdinal.toString(),
        streamKind: 'operation', stableId: boundary.stableId });
      const resumed = await runtime.port.read({ credential: equal.credential, sessionId: equal.session.sessionId,
        collectionId: COLLECTION, replicaId: equal.replica.replicaId, cursor: first.nextCursor, limit: 2 });
      assert.deepEqual(resumed.events, []);
      assert.equal((await pullFixture.isolated.runtime.db.selectFrom('sync_replicas').select('status')
        .where('replica_id', '=', equal.replica.replicaId).executeTakeFirstOrThrow()).status, 'active');
    } finally {
      const cleanup = await pullFixture.isolated.runtime.pool.connect();
      try {
        await cleanup.query('begin');
        await cleanup.query('alter table sync_collection_purge_state disable trigger sync_collection_purge_state_revision_fence');
        await cleanup.query(`update sync_collection_purge_state set purged_through_commit_ordinal=0,
          purged_through_stream_kind=0,purged_through_stable_id='',state_revision=0 where collection_id=$1`, [COLLECTION]);
        await cleanup.query('alter table sync_collection_purge_state enable trigger sync_collection_purge_state_revision_fence');
        await cleanup.query('commit');
      } catch (error) { await cleanup.query('rollback'); throw error; } finally { cleanup.release(); }
      runtime.keys.destroy();
    }
  });

  test('fails closed on cursor scope replay and transactionally changed authority', async () => {
    const { keys, port } = reader();
    const first = await port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor: null, limit: 1 });
    await assert.rejects(port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor: first.nextCursor, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'invalid_cursor_scope');
    await pullFixture.isolated.runtime.pool.query(`update sync_extension_credentials set revoked_at=current_timestamp
      where credential_id=$1`, [pullFixture.scope.credential.credentialId]);
    await assert.rejects(port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor: first.nextCursor, limit: 1 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'not_found');
    keys.destroy();
  });

  test('cancels a blocked PostgreSQL read without advancing checkpoint', async () => {
    const before = (await pullFixture.isolated.runtime.pool.query(`select checkpoint_cursor,checkpoint_commit_ordinal
      from sync_replicas where replica_id=$1`, [pullFixture.scope.replica.replicaId])).rows[0];
    const blocker = await pullFixture.isolated.runtime.pool.connect();
    await blocker.query('begin');
    await blocker.query('select session_id from sync_sessions where session_id=$1 for update',
      [pullFixture.scope.session.sessionId]);
    const controller = new AbortController();
    const { keys, port } = reader();
    const pending = port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      cursor: null, limit: 1, signal: controller.signal, timeoutMs: 5_000 });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(new DOMException('client disconnected', 'AbortError'));
      await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    const after = (await pullFixture.isolated.runtime.pool.query(`select checkpoint_cursor,checkpoint_commit_ordinal
      from sync_replicas where replica_id=$1`, [pullFixture.scope.replica.replicaId])).rows[0];
    assert.deepEqual(after, before);
    keys.destroy();
  });


});
