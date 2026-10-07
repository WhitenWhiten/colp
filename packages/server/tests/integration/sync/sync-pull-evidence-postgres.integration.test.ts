import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';



import { test } from 'vitest';



import { createPostgresSyncPullReadPort } from '../../../src/infrastructure/sync/index.js';
import type { SyncPullEvidencePersistencePhase } from '../../../src/infrastructure/sync/postgres/sync-pull-postgres.js';
import { createSyncPullCursorKeyring, SyncPullReadError } from '../../../src/modules/sync/index.js';



import { describeWithPostgres } from '../../support/postgres-test-runtime.js';


import { createSyncPullFixture, ACCOUNT, COLLECTION } from './sync-pull-fixture.js';

describeWithPostgres('P3-20 sync-pull-evidence-postgres.integration.test.ts', () => {
  const pullFixture = createSyncPullFixture('p3_pull_3', true);
  const { seedCollection, createProtocolScope, operation, insertOperation, insertConflict, reader, countPersistenceStatements, seedOperationBatch } = pullFixture;

  test('batch evidence/proof persistence keeps statement growth constant as page size increases', async () => {
    const suffix = randomUUID();
    const batchScope = await createProtocolScope('0.1');
    const keys = createSyncPullCursorKeyring({
      active: { id: `p3-20-batch-${suffix}`, secret: Buffer.alloc(32, 37).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys);
    const baseContext = {
      replicaId: batchScope.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: batchScope.replica.leaseGeneration, sessionId: batchScope.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1' as const, policyRevision: 'policy-r1',
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
    };
    const anchorId = `batch-anchor-${suffix}`;
    await insertOperation(anchorId, 200_000, 200_000);
    const anchorCursor = keys.sign({ ...baseContext, limit: 1, tuple: {
      commitOrdinal: '200000', streamKind: 'operation', stableId: anchorId,
    } });
    await seedOperationBatch(`one-${suffix}`, 200_001, 1, batchScope.replica.replicaId);
    const one = await countPersistenceStatements(() => port.read({
      credential: batchScope.credential, sessionId: batchScope.session.sessionId,
      collectionId: COLLECTION, replicaId: batchScope.replica.replicaId, cursor: anchorCursor, limit: 1,
    }));
    assert.equal(one.result.events.length, 1);
    await seedOperationBatch(`hundred-${suffix}`, 200_002, 100, batchScope.replica.replicaId);
    const hundredCursor = keys.sign({ ...baseContext, limit: 100, tuple: {
      commitOrdinal: '200001', streamKind: 'operation', stableId: `batch-one-${suffix}-00000`,
    } });
    const hundred = await countPersistenceStatements(() => port.read({
      credential: batchScope.credential, sessionId: batchScope.session.sessionId,
      collectionId: COLLECTION, replicaId: batchScope.replica.replicaId, cursor: hundredCursor, limit: 100,
    }));
    assert.equal(hundred.result.events.length, 100);
    await seedOperationBatch(`thousand-${suffix}`, 200_200, 1000, batchScope.replica.replicaId);
    const thousandCursor = keys.sign({ ...baseContext, limit: 1000, tuple: {
      commitOrdinal: '200101', streamKind: 'operation', stableId: `batch-hundred-${suffix}-00099`,
    } });
    const thousand = await countPersistenceStatements(() => port.read({
      credential: batchScope.credential, sessionId: batchScope.session.sessionId,
      collectionId: COLLECTION, replicaId: batchScope.replica.replicaId, cursor: thousandCursor, limit: 1000,
    }));
    assert.equal(thousand.result.events.length, 1000);
    assert.ok(Math.abs(hundred.count - one.count) <= 1,
      `N=1 (${one.count}) vs N=100 (${hundred.count}) persistence statements diverged`);
    assert.ok(Math.abs(thousand.count - one.count) <= 1,
      `N=1 (${one.count}) vs N=1000 (${thousand.count}) persistence statements diverged`);
    keys.destroy();
  }, 30_000);

  test('fails closed when durable evidence already exists for the same digest with different facts', async () => {
    const transfer = await createProtocolScope('0.1');
    const suffix = randomUUID();
    const anchorId = `collision-anchor-${suffix}`;
    const opId = `collision-op-${suffix}`;
    const ordinal = 600_000;
    await insertOperation(anchorId, ordinal - 1, ordinal - 1, COLLECTION);
    await insertOperation(opId, ordinal, ordinal, COLLECTION);
    const keys = createSyncPullCursorKeyring({
      active: { id: `p3-20-collision-${suffix}`, secret: Buffer.alloc(32, 59).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys);
    const pullContext = {
      replicaId: transfer.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: transfer.replica.leaseGeneration, sessionId: transfer.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1' as const, policyRevision: 'policy-r1', limit: 1,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
    };
    const anchorTuple = { commitOrdinal: String(ordinal - 1), streamKind: 'operation' as const, stableId: anchorId };
    const anchorCursor = keys.sign({ ...pullContext, tuple: anchorTuple });
    const verified = keys.verify(anchorCursor, pullContext);
    assert.equal(verified.valid, true);
    const tuple = { commitOrdinal: String(ordinal), streamKind: 'operation' as const, stableId: opId };
    const expectedCursor = keys.sign({ ...pullContext, tuple }, verified.expiresAt);
    const digest = createHash('sha256').update(expectedCursor, 'utf8').digest('hex');
    await pullFixture.isolated.runtime.db.insertInto('sync_pull_cursor_evidence').values({
      cursor: `${expectedCursor}-tampered`,
      cursor_digest: digest,
      session_id: transfer.session.sessionId,
      account_id: ACCOUNT,
      collection_id: COLLECTION,
      replica_id: transfer.replica.replicaId,
      lease_generation: BigInt(transfer.replica.leaseGeneration),
      policy_revision: 'policy-r1',
      protocol_version: '0.1',
      tuple_commit_ordinal: BigInt(ordinal),
      tuple_stream_kind: 0,
      tuple_stable_id: opId,
      cursor_expires_at: new Date(Date.now() + 60_000),
      upper_commit_ordinal: BigInt(ordinal),
      upper_stream_kind: 0,
      upper_stable_id: opId,
      collection_revision: 'content-r1',
      page_limit: 1,
      purge_commit_ordinal: 0n,
      purge_stream_kind: 0,
      purge_stable_id: '',
    }).execute();
    await assert.rejects(port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: anchorCursor, limit: 1 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
    keys.destroy();
  });

  test('rejects same-digest evidence when any page upper fact differs', async () => {
    const variants = [
      'upper_commit_ordinal', 'upper_stream_kind', 'upper_stable_id',
    ] as const;
    for (const [index, field] of variants.entries()) {
      const transfer = await createProtocolScope('0.1');
      const suffix = `${field}-${randomUUID()}`;
      const ordinal = 800_000 + index * 10;
      const anchorId = `collision-anchor-${suffix}`;
      const opId = `collision-op-${suffix}`;
      await insertOperation(anchorId, ordinal - 1, ordinal - 1, COLLECTION);
      await insertOperation(opId, ordinal, ordinal, COLLECTION);
      const keys = createSyncPullCursorKeyring({
        active: { id: `collision-${index}-${randomUUID()}`, secret: Buffer.alloc(32, 60 + index).toString('base64') },
        retained: [], ttlMs: 60_000,
      });
      const context = {
        replicaId: transfer.replica.replicaId, collectionId: COLLECTION,
        leaseGeneration: transfer.replica.leaseGeneration, sessionId: transfer.session.sessionId,
        principalId: ACCOUNT, protocolVersion: '0.1' as const, policyRevision: 'policy-r1', limit: 1,
        purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
      };
      const anchorCursor = keys.sign({ ...context, tuple: {
        commitOrdinal: String(ordinal - 1), streamKind: 'operation', stableId: anchorId,
      } });
      const anchorVerified = keys.verify(anchorCursor, context);
      assert.equal(anchorVerified.valid, true);
      if (!anchorVerified.valid) throw new Error('expected valid collision anchor cursor');
      const expectedCursor = keys.sign({ ...context, tuple: {
        commitOrdinal: String(ordinal), streamKind: 'operation', stableId: opId,
      } }, anchorVerified.expiresAt);
      const digest = createHash('sha256').update(expectedCursor, 'utf8').digest('hex');
      const facts = {
        cursor: expectedCursor, cursor_digest: digest, session_id: transfer.session.sessionId,
        account_id: ACCOUNT, collection_id: COLLECTION, replica_id: transfer.replica.replicaId,
        lease_generation: BigInt(transfer.replica.leaseGeneration), policy_revision: 'policy-r1',
        protocol_version: '0.1' as const, tuple_commit_ordinal: BigInt(ordinal), tuple_stream_kind: 0,
        tuple_stable_id: opId, cursor_expires_at: new Date(anchorVerified.expiresAt),
        upper_commit_ordinal: BigInt(ordinal), upper_stream_kind: 0, upper_stable_id: opId,
        collection_revision: 'content-r1', page_limit: 1, purge_commit_ordinal: 0n,
        purge_stream_kind: 0, purge_stable_id: '',
      };
      const mismatched = {
        ...facts,
        ...(field === 'upper_commit_ordinal' ? { upper_commit_ordinal: BigInt(ordinal + 1) } : {}),
        ...(field === 'upper_stream_kind' ? { upper_stream_kind: 1 } : {}),
        ...(field === 'upper_stable_id' ? { upper_stable_id: `${opId}-other` } : {}),
      };
      await pullFixture.isolated.runtime.db.insertInto('sync_pull_cursor_evidence').values(mismatched).execute();
      const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys);
      await assert.rejects(port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
        collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: anchorCursor, limit: 1 }),
      (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure', field);
      keys.destroy();
    }
  });

  test('reuses same-digest evidence when only collection_revision drifted', async () => {
    const transfer = await createProtocolScope('0.1');
    const suffix = randomUUID();
    const ordinal = 830_000;
    const anchorId = `revision-drift-anchor-${suffix}`;
    const opId = `revision-drift-op-${suffix}`;
    await insertOperation(anchorId, ordinal - 1, ordinal - 1, COLLECTION);
    await insertOperation(opId, ordinal, ordinal, COLLECTION);
    const keys = createSyncPullCursorKeyring({
      active: { id: `revision-drift-${randomUUID()}`, secret: Buffer.alloc(32, 71).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const context = {
      replicaId: transfer.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: transfer.replica.leaseGeneration, sessionId: transfer.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1' as const, policyRevision: 'policy-r1', limit: 1,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
    };
    const anchorCursor = keys.sign({ ...context, tuple: {
      commitOrdinal: String(ordinal - 1), streamKind: 'operation', stableId: anchorId,
    } });
    const anchorVerified = keys.verify(anchorCursor, context);
    assert.equal(anchorVerified.valid, true);
    if (!anchorVerified.valid) throw new Error('expected valid revision-drift anchor cursor');
    const expectedCursor = keys.sign({ ...context, tuple: {
      commitOrdinal: String(ordinal), streamKind: 'operation', stableId: opId,
    } }, anchorVerified.expiresAt);
    const digest = createHash('sha256').update(expectedCursor, 'utf8').digest('hex');
    await pullFixture.isolated.runtime.db.insertInto('sync_pull_cursor_evidence').values({
      cursor: expectedCursor, cursor_digest: digest, session_id: transfer.session.sessionId,
      account_id: ACCOUNT, collection_id: COLLECTION, replica_id: transfer.replica.replicaId,
      lease_generation: BigInt(transfer.replica.leaseGeneration), policy_revision: 'policy-r1',
      protocol_version: '0.1', tuple_commit_ordinal: BigInt(ordinal), tuple_stream_kind: 0,
      tuple_stable_id: opId, cursor_expires_at: new Date(anchorVerified.expiresAt),
      upper_commit_ordinal: BigInt(ordinal), upper_stream_kind: 0, upper_stable_id: opId,
      collection_revision: 'content-other', page_limit: 1, purge_commit_ordinal: 0n,
      purge_stream_kind: 0, purge_stable_id: '',
    }).execute();
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys);
    const page = await port.read({
      credential: transfer.credential, sessionId: transfer.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: anchorCursor, limit: 1,
    });
    assert.equal(page.events.length, 1);
    const stored = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_evidence')
      .select('collection_revision').where('replica_id', '=', transfer.replica.replicaId)
      .where('cursor_digest', '=', digest).executeTakeFirstOrThrow();
    assert.equal(stored.collection_revision, 'content-other');
    keys.destroy();
  });

  test('rolls back all batched evidence and proof writes when faulted after each persistence phase', async () => {
    const phases: SyncPullEvidencePersistencePhase[] = [
      'evidence_insert', 'evidence_readback', 'proof_insert', 'proof_readback',
    ];
    for (const phase of phases) {
      const transfer = await createProtocolScope('0.1');
      const { keys, port } = reader({
        evidenceFaultInjector: { afterPhase(faultPhase) {
          if (faultPhase === phase) throw new Error(`fault:${phase}`);
        } },
      });
      await assert.rejects(port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
        collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: null, limit: 2 }),
      (error: unknown) => error instanceof Error && error.message === `fault:${phase}`);
      const evidence = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').selectAll()
        .where('replica_id', '=', transfer.replica.replicaId).execute();
      const proofs = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
        .where('replica_id', '=', transfer.replica.replicaId).execute();
      assert.equal(evidence.length, 0, `expected zero evidence after fault:${phase}`);
      assert.equal(proofs.length, 0, `expected zero proofs after fault:${phase}`);
      keys.destroy();
    }
  });

  test('fails closed when persisted evidence disappears between insert and readback, leaving zero durable writes', async () => {
    const transfer = await createProtocolScope('0.1');
    const { keys, port } = reader({
      evidenceFaultInjector: {
        async afterPhase(phase, transaction) {
          if (phase === 'evidence_insert') {
            // The evidence retention trigger permits a DELETE only when the
            // replica is in recovery_required/retired (or the cursor has
            // expired). Transition the replica so the delete is trigger-legal,
            // then remove the just-inserted rows to force the readback guard.
            await transaction.updateTable('sync_replicas').set({ status: 'recovery_required' })
              .where('replica_id', '=', transfer.replica.replicaId).execute();
            await transaction.deleteFrom('sync_pull_cursor_evidence')
              .where('replica_id', '=', transfer.replica.replicaId)
              .execute();
          }
        },
      },
    });
    await assert.rejects(port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: null, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
    const evidence = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').select('evidence_id')
      .where('replica_id', '=', transfer.replica.replicaId).execute();
    const proofs = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').select('proof_id')
      .where('replica_id', '=', transfer.replica.replicaId).execute();
    const replica = await pullFixture.isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', transfer.replica.replicaId).executeTakeFirstOrThrow();
    assert.deepEqual({ evidence: evidence.length, proofs: proofs.length }, { evidence: 0, proofs: 0 },
      'the denied read must leave zero durable evidence and proofs behind');
    assert.equal(replica.status, 'active',
      'the fault-injected replica transition must roll back with the denied read');
    keys.destroy();
  });

  test('derives proof expiry from persisted evidence issued_at rather than page authority clock alone', async () => {
    const transfer = await createProtocolScope('0.1');
    const retentionMs = 120_000;
    const { keys, port } = reader({ recoveryProofRetentionMs: retentionMs });
    const page = await port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: null, limit: 2 });
    const digest = createHash('sha256').update(page.nextCursor, 'utf8').digest('hex');
    const evidence = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').selectAll()
      .where('replica_id', '=', transfer.replica.replicaId).where('cursor_digest', '=', digest).executeTakeFirstOrThrow();
    const proof = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
      .where('replica_id', '=', transfer.replica.replicaId).where('cursor_digest', '=', digest).executeTakeFirstOrThrow();
    assert.equal(proof.proof_expires_at.getTime(),
      Math.max(evidence.issued_at.getTime() + retentionMs, evidence.cursor_expires_at.getTime() + 1));
    keys.destroy();
  });

  test('fails closed instead of backdating issued_at when the database clock has passed cursor expiry', async () => {
    const transfer = await createProtocolScope('0.1');
    const cursorNow = Date.now() - 120_000;
    const keys = createSyncPullCursorKeyring({
      active: { id: `expired-issuance-${randomUUID()}`, secret: Buffer.alloc(32, 69).toString('base64') },
      retained: [], ttlMs: 60_000, now: () => cursorNow,
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, { cursorNow: () => cursorNow });
    await assert.rejects(port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: null, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
    const evidence = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').select('evidence_id')
      .where('replica_id', '=', transfer.replica.replicaId).execute();
    const proofs = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').select('proof_id')
      .where('replica_id', '=', transfer.replica.replicaId).execute();
    assert.deepEqual({ evidence: evidence.length, proofs: proofs.length }, { evidence: 0, proofs: 0 });
    keys.destroy();
  });

  test('byte-budget truncation persists evidence only for the returned events plus page upper cursor', async () => {
    const transfer = await createProtocolScope('0.1');
    const suffix = randomUUID();
    const anchorId = `budget-anchor-${suffix}`;
    const ids = [`budget-a-${suffix}`, `budget-b-${suffix}`];
    const ordinal = 700_000;
    await insertOperation(anchorId, ordinal - 1, ordinal - 1, COLLECTION);
    const heavy = 'x'.repeat(32_000);
    await insertOperation(ids[0]!, ordinal, ordinal, COLLECTION, heavy);
    await insertOperation(ids[1]!, ordinal + 1, ordinal + 1, COLLECTION, heavy);
    const keys = createSyncPullCursorKeyring({
      active: { id: `p3-20-budget-${suffix}`, secret: Buffer.alloc(32, 37).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const port = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, keys, { responseBudgetBytes: 40_000 });
    const anchorCursor = keys.sign({
      replicaId: transfer.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: transfer.replica.leaseGeneration, sessionId: transfer.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: String(ordinal - 1), streamKind: 'operation', stableId: anchorId },
    });
    const page = await port.read({ credential: transfer.credential, sessionId: transfer.session.sessionId,
      collectionId: COLLECTION, replicaId: transfer.replica.replicaId, cursor: anchorCursor, limit: 2 });
    assert.equal(page.events.length, 1);
    const evidence = await pullFixture.isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').selectAll()
      .where('replica_id', '=', transfer.replica.replicaId).execute();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.cursor, page.events[0]?.cursor);
    keys.destroy();
  });
});
