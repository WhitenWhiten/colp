import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';



import { test } from 'vitest';
import type { Operation } from '@know-n/colp/types';


import { createPostgresSyncAckApplication, createPostgresSyncPullReadPort, createPostgresSyncSessionIssuer } from '../../../src/infrastructure/sync/index.js';

import { createSyncPullCursorKeyring, SyncPullReadError } from '../../../src/modules/sync/index.js';



import { describeWithPostgres } from '../../support/postgres-test-runtime.js';


import { createSyncPullFixture, ISSUER, ACCOUNT, COLLECTION, OTHER_COLLECTION, ORIGIN, FOREIGN_ORIGIN } from './sync-pull-fixture.js';

describeWithPostgres('P3-20 sync-pull-postgres.integration.test.ts', () => {
  const pullFixture = createSyncPullFixture('p3_pull_0', false);
  const { seedCollection, createProtocolScope, operation, insertOperation, insertConflict, reader, countPersistenceStatements, seedOperationBatch } = pullFixture;

  test('empty stream returns a stable initial exclusive cursor', async () => {
    const keys = createSyncPullCursorKeyring({
      active: { id: 'p3-20-concurrent-initial', secret: Buffer.alloc(32, 37).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    let signCalls = 0;
    const countingKeys = Object.freeze({
      get activeKeyId() { return keys.activeKeyId; }, get destroyed() { return keys.destroyed; },
      sign(scopeValue: Parameters<typeof keys.sign>[0], expiresAt?: number) {
        signCalls += 1; return keys.sign(scopeValue, expiresAt);
      },
      verify: keys.verify.bind(keys), destroy: keys.destroy.bind(keys),
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, countingKeys);
    const input = { credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor: null, limit: 2 } as const;
    const [page, concurrent] = await Promise.all([port.read(input), port.read(input)]);
    assert.deepEqual(page.events, []);
    assert.equal(page.hasMore, false);
    assert.equal(typeof page.nextCursor, 'string');
    assert.equal(concurrent.nextCursor, page.nextCursor);
    assert.equal(signCalls, 1);
    const replay = await port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor: null, limit: 2 });
    assert.equal(replay.nextCursor, page.nextCursor);
    const auditBeforeEmpty = await pullFixture.isolated.runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from audit_events');
    const signCallsBeforeEmpty = signCalls;
    const [emptyA, emptyB] = await Promise.all([port.read({ ...input, cursor: page.nextCursor }),
      port.read({ ...input, cursor: page.nextCursor })]);
    assert.equal(emptyA.nextCursor, page.nextCursor);
    assert.equal(emptyB.nextCursor, page.nextCursor);
    assert.equal(signCalls, signCallsBeforeEmpty);
    const evidence = await pullFixture.isolated.runtime.pool.query<{ count: string }>(`select count(*)::text as count
      from sync_pull_cursor_evidence where replica_id=$1 and cursor=$2`,
    [pullFixture.scope.replica.replicaId, page.nextCursor]);
    assert.equal(evidence.rows[0]?.count, '1');
    const auditAfterEmpty = await pullFixture.isolated.runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from audit_events');
    assert.equal(auditAfterEmpty.rows[0]?.count, auditBeforeEmpty.rows[0]?.count);
    keys.destroy();
  });

  test('rejects a Pull request whose Origin does not match the durable Session binding', async () => {
    const { port } = reader();
    await assert.rejects(port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, origin: FOREIGN_ORIGIN,
      cursor: null, limit: 2 }), (error: unknown) => error instanceof SyncPullReadError
        && error.code === 'not_found');
  });

  test('traverses operation/conflict tuples without omissions and sees concurrent appends after the cursor', async () => {
    const suffix = randomUUID();
    await insertOperation(`other-op-${suffix}`, 9, 1, OTHER_COLLECTION);
    const ids = [`op-a-${suffix}`, `op-b-${suffix}`, `op-c-${suffix}`];
    await insertOperation(ids[0]!, 10, 1);
    await insertOperation(ids[1]!, 11, 2);
    await insertOperation(ids[2]!, 12, 3);
    const conflicts = [`conflict-a-${suffix}`, `conflict-b-${suffix}`];
    await insertConflict(conflicts[0]!, ids[1]!, 11);
    await insertConflict(conflicts[1]!, ids[2]!, 11);
    const { keys, port } = reader();
    let cursor: string | null = null;
    const observed: string[] = [];
    const hasMore: boolean[] = [];
    let pages = 0;
    do {
      const page = await port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
        collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor, limit: 2 });
      pages += 1;
      hasMore.push(page.hasMore);
      for (const event of page.events) if (event.kind === 'conflict') {
        assert.equal(Object.hasOwn(event.conflict!, 'base'), false);
        assert.equal(Object.hasOwn(event.conflict!, 'server'), false);
        assert.equal(Object.hasOwn(event.conflict!, 'incoming'), false);
      }
      observed.push(...page.events.map((event) => event.kind === 'operation'
        ? `operation:${event.operation!.opId}` : `conflict:${event.conflict!.id}`));
      cursor = page.nextCursor;
      if (pages === 1) await insertOperation(`op-appended-${suffix}`, 13, 4);
      if (!page.hasMore) break;
    } while (pages < 10);
    assert.deepEqual(observed, [
      `operation:${ids[0]}`,
      `conflict:${conflicts[0]}`, `conflict:${conflicts[1]}`,
      `operation:op-appended-${suffix}`,
    ]);
    assert.deepEqual(hasMore, [true, false]);
    assert.equal(pages, 2);
    const finalCursor = cursor!;
    const finalTuple = keys.verify(finalCursor, {
      replicaId: pullFixture.scope.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: pullFixture.scope.replica.leaseGeneration, sessionId: pullFixture.scope.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
    });
    assert.equal(finalTuple.valid, true);
    const afterFinal = await port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor, limit: 2 });
    assert.deepEqual(afterFinal.events, []);
    assert.equal(afterFinal.hasMore, false);
    assert.equal(afterFinal.nextCursor, finalCursor);
    assert.deepEqual(afterFinal.nextTuple, { commitOrdinal: '13', streamKind: 'operation',
      stableId: `op-appended-${suffix}` });
    keys.destroy();
  });

  test('returns the same complete stream as one final page without leaking another Collection', async () => {
    const { keys, port } = reader();
    const page = await port.read({ credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId,
      collectionId: COLLECTION, replicaId: pullFixture.scope.replica.replicaId, cursor: null, limit: 100 });
    assert.equal(page.hasMore, false);
    assert.equal(page.events.length, 4);
    assert.equal(page.events.some((event) => event.kind === 'operation'
      && event.operation!.collectionId === OTHER_COLLECTION), false);
    keys.destroy();
  });

  test('all protocol versions emit only the privacy-minimal Conflict for a conflicted Operation', async () => {
    const suffix = randomUUID();
    const anchorId = `v02-anchor-${suffix}`;
    const conflictedId = `v02-conflicted-${suffix}`;
    const conflictId = `v02-conflict-${suffix}`;
    const appliedWithoutEffectId = `v02-applied-without-effect-${suffix}`;
    await insertOperation(anchorId, 50_000, 50_000);
    const secretMarker = `v01-v02-conflict-secret-${suffix}`;
    await insertOperation(conflictedId, 50_001, 50_001, COLLECTION, secretMarker);
    await insertConflict(conflictId, conflictedId, 50_001);
    await insertOperation(appliedWithoutEffectId, 50_002, 50_002);

    const v02 = await createProtocolScope('0.2');
    const v02Reader = reader();
    const v02Context = {
      replicaId: v02.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: v02.replica.leaseGeneration, sessionId: v02.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.2' as const, policyRevision: 'policy-r1', limit: 1,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
    };
    const afterAnchor = v02Reader.keys.sign({ ...v02Context, tuple: {
      commitOrdinal: '50000', streamKind: 'operation', stableId: anchorId,
    } });
    const conflictPage = await v02Reader.port.read({
      credential: v02.credential, sessionId: v02.session.sessionId, collectionId: COLLECTION,
      replicaId: v02.replica.replicaId, cursor: afterAnchor, limit: 1,
    });
    assert.equal(conflictPage.events.length, 1);
    assert.equal(conflictPage.events[0]?.kind, 'conflict');
    assert.equal(conflictPage.events[0]?.conflict?.id, conflictId);
    assert.equal(JSON.stringify(conflictPage.events).includes(secretMarker), false);
    await assert.rejects(v02Reader.port.read({
      credential: v02.credential, sessionId: v02.session.sessionId, collectionId: COLLECTION,
      replicaId: v02.replica.replicaId, cursor: conflictPage.nextCursor, limit: 1,
    }), (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
    v02Reader.keys.destroy();

    const v01Reader = reader();
    const afterAnchorV01 = v01Reader.keys.sign({
      replicaId: pullFixture.scope.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: pullFixture.scope.replica.leaseGeneration, sessionId: pullFixture.scope.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 1,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: '50000', streamKind: 'operation', stableId: anchorId },
    });
    const v01Page = await v01Reader.port.read({
      credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId, collectionId: COLLECTION,
      replicaId: pullFixture.scope.replica.replicaId, cursor: afterAnchorV01, limit: 1,
    });
    assert.equal(v01Page.events[0]?.conflict?.id, conflictId);
    assert.equal(JSON.stringify(v01Page.events).includes(secretMarker), false);
    const v01Replay = await v01Reader.port.read({
      credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId, collectionId: COLLECTION,
      replicaId: pullFixture.scope.replica.replicaId, cursor: afterAnchorV01, limit: 1,
    });
    assert.deepEqual(v01Replay.events, v01Page.events);
    const v01Tail = await v01Reader.port.read({
      credential: pullFixture.scope.credential, sessionId: pullFixture.scope.session.sessionId, collectionId: COLLECTION,
      replicaId: pullFixture.scope.replica.replicaId, cursor: v01Page.nextCursor, limit: 1,
    });
    assert.equal(v01Tail.events[0]?.kind, 'operation');
    assert.equal(v01Tail.events[0]?.operation?.opId, appliedWithoutEffectId);
    v01Reader.keys.destroy();
  });

  test('resumes a page cursor after reader and keyring restart', async () => {
    const firstRuntime = reader();
    const first = await firstRuntime.port.read({ credential: pullFixture.scope.credential,
      sessionId: pullFixture.scope.session.sessionId, collectionId: COLLECTION,
      replicaId: pullFixture.scope.replica.replicaId, cursor: null, limit: 2 });
    firstRuntime.keys.destroy();
    const restarted = reader();
    const middle = await restarted.port.read({ credential: pullFixture.scope.credential,
      sessionId: pullFixture.scope.session.sessionId, collectionId: COLLECTION,
      replicaId: pullFixture.scope.replica.replicaId, cursor: first.nextCursor, limit: 2 });
    assert.equal(middle.events.length, 2);
    assert.equal(middle.hasMore, true);
    restarted.keys.destroy();
  });

  test('hands an unexpired durable cursor to a renewed Session without widening its scope', async () => {
    const transfer = await createProtocolScope('0.1');
    const firstRuntime = reader();
    const first = await firstRuntime.port.read({ credential: transfer.credential,
      sessionId: transfer.session.sessionId, collectionId: COLLECTION,
      replicaId: transfer.replica.replicaId, cursor: null, limit: 2 });
    const current = (await pullFixture.isolated.runtime.pool.query<{
      lease_generation: string; lifecycle_revision: string;
    }>(`select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1`,
    [transfer.replica.replicaId])).rows[0]!;
    const renewed = await transfer.issuer.issue({
      credential: transfer.credential, idempotencyKey: `p3-20-renew-${randomUUID()}`,
      requestFingerprint: `p3-20-renew-fingerprint-${randomUUID()}`,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId,
      expectedLeaseGeneration: current.lease_generation,
      expectedLifecycleRevision: current.lifecycle_revision,
      binding: transfer.replica.binding, requestedScopes: ['sync:pull'],
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    });
    const page = await firstRuntime.port.read({ credential: transfer.credential,
      sessionId: renewed.session.sessionId, collectionId: COLLECTION,
      replicaId: transfer.replica.replicaId, cursor: first.nextCursor, limit: 2 });
    assert.notEqual(page.nextCursor, first.nextCursor);
    assert.ok(page.events.length > 0);
    const rebound = firstRuntime.keys.verify(page.nextCursor, {
      replicaId: transfer.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: current.lease_generation, sessionId: renewed.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
    });
    assert.equal(rebound.valid, true);
    await assert.rejects(firstRuntime.port.read({ credential: transfer.credential,
      sessionId: renewed.session.sessionId, collectionId: COLLECTION,
      replicaId: transfer.replica.replicaId, cursor: first.nextCursor, limit: 1 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'invalid_cursor_scope');
    firstRuntime.keys.destroy();
  });

  test('does not transition the Replica when a purged old-Session cursor is handed to a renewed Session', async () => {
    const transfer = await createProtocolScope('0.1');
    const runtime = reader();
    try {
      const first = await runtime.port.read({ credential: transfer.credential,
        sessionId: transfer.session.sessionId, collectionId: COLLECTION,
        replicaId: transfer.replica.replicaId, cursor: null, limit: 2 });
      const current = (await pullFixture.isolated.runtime.pool.query<{
        lease_generation: string; lifecycle_revision: string;
      }>(`select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1`,
      [transfer.replica.replicaId])).rows[0]!;
      const renewed = await transfer.issuer.issue({
        credential: transfer.credential, idempotencyKey: `p3-20-purged-handoff-${randomUUID()}`,
        requestFingerprint: `p3-20-purged-handoff-fingerprint-${randomUUID()}`,
        collectionId: COLLECTION, replicaId: transfer.replica.replicaId,
        expectedLeaseGeneration: current.lease_generation,
        expectedLifecycleRevision: current.lifecycle_revision,
        binding: transfer.replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN,
      });
      await pullFixture.isolated.runtime.db.updateTable('sync_collection_purge_state').set({
        purged_through_commit_ordinal: BigInt(first.nextTuple.commitOrdinal) + 1n,
        purged_through_stream_kind: 0,
        purged_through_stable_id: 'purged-old-session-cursor', state_revision: 1n,
      }).where('collection_id', '=', COLLECTION).execute();

      await assert.rejects(runtime.port.read({ credential: transfer.credential,
        sessionId: renewed.session.sessionId, collectionId: COLLECTION,
        replicaId: transfer.replica.replicaId, cursor: first.nextCursor, limit: 2 }),
      (error: unknown) => error instanceof SyncPullReadError && error.code === 'sync_cursor_expired');
      assert.equal((await pullFixture.isolated.runtime.db.selectFrom('sync_replicas').select('status')
        .where('replica_id', '=', transfer.replica.replicaId).executeTakeFirstOrThrow()).status, 'active');
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

  test('reissues a same-Session cursor when the purge watermark advances to its tuple', async () => {
    const transfer = await createProtocolScope('0.1');
    const runtime = reader();
    const first = await runtime.port.read({ credential: transfer.credential,
      sessionId: transfer.session.sessionId, collectionId: COLLECTION,
      replicaId: transfer.replica.replicaId, cursor: null, limit: 100 });
    assert.equal(first.hasMore, false);
    assert.notEqual(first.nextTuple.commitOrdinal, '0');
    const streamKind = first.nextTuple.streamKind === 'operation' ? 0 : 1;
    try {
      await pullFixture.isolated.runtime.db.updateTable('sync_collection_purge_state').set({
        purged_through_commit_ordinal: BigInt(first.nextTuple.commitOrdinal),
        purged_through_stream_kind: streamKind,
        purged_through_stable_id: first.nextTuple.stableId,
        state_revision: 1n,
      }).where('collection_id', '=', COLLECTION).execute();
      const resumed = await runtime.port.read({ credential: transfer.credential,
        sessionId: transfer.session.sessionId, collectionId: COLLECTION,
        replicaId: transfer.replica.replicaId, cursor: first.nextCursor, limit: 100 });
      assert.deepEqual(resumed.events, []);
      assert.equal(resumed.cursorReissued, true);
      assert.notEqual(resumed.nextCursor, first.nextCursor);
      assert.equal(runtime.keys.verify(resumed.nextCursor, {
        replicaId: transfer.replica.replicaId, collectionId: COLLECTION,
        leaseGeneration: transfer.replica.leaseGeneration, sessionId: transfer.session.sessionId,
        principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 100,
        purgeBoundary: first.nextTuple,
      }).valid, true);
      const ack = await createPostgresSyncAckApplication(pullFixture.isolated.runtime.db, {
        leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
      }).acknowledge({ credential: transfer.credential,
        idempotencyKey: `p3-38-purge-rebind-ack-${randomUUID()}`,
        origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncAck',
        request: { sessionId: transfer.session.sessionId, cursor: resumed.nextCursor, warnings: [] } });
      assert.equal(ack.ackedCursor, resumed.nextCursor);
      const replayed = await runtime.port.read({ credential: transfer.credential,
        sessionId: transfer.session.sessionId, collectionId: COLLECTION,
        replicaId: transfer.replica.replicaId, cursor: first.nextCursor, limit: 100 });
      assert.deepEqual(replayed.events, []);
      assert.equal(replayed.cursorReissued, true);
      assert.equal(replayed.nextCursor, resumed.nextCursor);

      const current = (await pullFixture.isolated.runtime.pool.query<{
        lease_generation: string; lifecycle_revision: string;
      }>(`select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1`,
      [transfer.replica.replicaId])).rows[0]!;
      const renewed = await transfer.issuer.issue({ credential: transfer.credential,
        idempotencyKey: `p3-38-purge-backup-renew-${randomUUID()}`,
        requestFingerprint: `p3-38-purge-backup-fingerprint-${randomUUID()}`,
        collectionId: COLLECTION, replicaId: transfer.replica.replicaId,
        expectedLeaseGeneration: current.lease_generation,
        expectedLifecycleRevision: current.lifecycle_revision, binding: transfer.replica.binding,
        requestedScopes: ['sync:pull'], origin: ORIGIN });
      const restored = await runtime.port.read({ credential: transfer.credential,
        sessionId: renewed.session.sessionId, collectionId: COLLECTION,
        replicaId: transfer.replica.replicaId, cursor: first.nextCursor, limit: 100 });
      assert.deepEqual(restored.events, []);
      assert.equal(restored.cursorReissued, true);
      assert.notEqual(restored.nextCursor, first.nextCursor);
      assert.equal(runtime.keys.verify(restored.nextCursor, {
        replicaId: transfer.replica.replicaId, collectionId: COLLECTION,
        leaseGeneration: transfer.replica.leaseGeneration, sessionId: renewed.session.sessionId,
        principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 100,
        purgeBoundary: first.nextTuple,
      }).valid, true);
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

  test('reissues an acknowledged checkpoint cursor when expired-to-active increments the lease generation', async () => {
    const transfer = await createProtocolScope('0.1');
    const keys = createSyncPullCursorKeyring({ active: { id: 'p3-38-generation-rollover',
      secret: Buffer.alloc(32, 47).toString('base64') }, retained: [], ttlMs: 600_000 });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, { recoveryProofRetentionMs: 3_600_000 });
    const first = await port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: null, limit: 100 });
    await createPostgresSyncAckApplication(pullFixture.isolated.runtime.db, {
      leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
    }).acknowledge({ credential: transfer.credential, idempotencyKey: `p3-38-rollover-ack-${randomUUID()}`,
      origin: ORIGIN, mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: transfer.session.sessionId, cursor: first.nextCursor, warnings: [] } });
    await pullFixture.isolated.runtime.pool.query(`update sync_replicas set status='expired',
      last_seen_at=current_timestamp - interval '2 seconds',
      lease_expires_at=current_timestamp - interval '1 second',
      wire_json=jsonb_set(wire_json,'{status}','"expired"',true) where replica_id=$1`,
    [transfer.replica.replicaId]);
    const current = (await pullFixture.isolated.runtime.pool.query<{ lease_generation: string; lifecycle_revision: string }>(
      `select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1`,
      [transfer.replica.replicaId])).rows[0]!;
    const resumedIssuer = createPostgresSyncSessionIssuer(pullFixture.isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
      pullCursorKeyring: keys, recoveryProofRetentionMs: 3_600_000,
      retentionWindow: { async load(_transaction: unknown, collectionId: string) {
        const tuple = { commitOrdinal: '0', streamKind: 0 as const, stableId: '' };
        return { collectionId, earliestPull: { cursor: null, commitOrdinal: '0' },
          purgedThrough: { cursor: null, commitOrdinal: '0' }, earliestPullTuple: tuple,
          purgedThroughTuple: tuple, snapshotUrl: '/sync/snapshots/current' };
      } },
    });
    const renewed = await resumedIssuer.issue({ credential: transfer.credential,
      idempotencyKey: `p3-38-rollover-session-${randomUUID()}`,
      requestFingerprint: `p3-38-rollover-fingerprint-${randomUUID()}`, collectionId: COLLECTION,
      replicaId: transfer.replica.replicaId, expectedLeaseGeneration: current.lease_generation,
      expectedLifecycleRevision: current.lifecycle_revision, binding: transfer.replica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN, protocolVersion: '0.1' });

    assert.equal(renewed.envelope.replicaLease.generation, '2');
    assert.notEqual(renewed.envelope.collectionCursor, first.nextCursor);
    assert.match(renewed.envelope.collectionCursor, /^spc2\./u);
    const empty = await port.read({ credential: transfer.credential, sessionId: renewed.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId,
      cursor: renewed.envelope.collectionCursor, limit: 100 });
    assert.deepEqual(empty.events, []);
    assert.equal(empty.nextCursor, renewed.envelope.collectionCursor);
    keys.destroy();
  });

  test('reissues a verified cross-Session handoff cursor when no event advances its tuple', async () => {
    const transfer = await createProtocolScope('0.1');
    const runtime = reader();
    const drained = await runtime.port.read({ credential: transfer.credential,
      sessionId: transfer.session.sessionId, collectionId: COLLECTION,
      replicaId: transfer.replica.replicaId, cursor: null, limit: 100 });
    assert.equal(drained.hasMore, false);
    const current = (await pullFixture.isolated.runtime.pool.query<{
      lease_generation: string; lifecycle_revision: string;
    }>(`select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1`,
    [transfer.replica.replicaId])).rows[0]!;
    const renewed = await transfer.issuer.issue({ credential: transfer.credential,
      idempotencyKey: `p3-38-empty-renew-${randomUUID()}`,
      requestFingerprint: `p3-38-empty-renew-fingerprint-${randomUUID()}`,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId,
      expectedLeaseGeneration: current.lease_generation,
      expectedLifecycleRevision: current.lifecycle_revision, binding: transfer.replica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN });
    const empty = await runtime.port.read({ credential: transfer.credential,
      sessionId: renewed.session.sessionId, collectionId: COLLECTION,
      replicaId: transfer.replica.replicaId, cursor: drained.nextCursor, limit: 100 });
    assert.deepEqual(empty.events, []);
    assert.equal(empty.cursorReissued, true);
    assert.notEqual(empty.nextCursor, drained.nextCursor);
    runtime.keys.destroy();
  });


});
