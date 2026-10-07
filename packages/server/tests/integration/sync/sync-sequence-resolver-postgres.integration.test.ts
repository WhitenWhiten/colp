import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork, DatabaseOperationError, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  claimSyncResolutionLaneSlot,
  createPostgresReplicaStore,
  createPostgresSyncSequencePort,
  createPostgresSyncSessionIssuer,
  SyncSequencePersistenceError,
  type PostgresSyncSequenceTransaction,
} from '../../../src/infrastructure/sync/index.js';
import type { VerifiedExtensionCredential } from '../../../src/modules/identity/index.js';
import {
  canonicalSyncSequenceDigest,
  canonicalSyncSequenceResultDigest,
  type SyncSequenceAdmissionInput,
} from '../../../src/modules/sync/index.js';
import { mintExtensionCredentialHttpFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  appliedSequenceResult,
  deferredSequenceResult,
  syncSequenceAdmission,
} from '../../fixtures/phase3/sync-sequence.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const COLLECTION = 'sequence-collection';
const ACCOUNT = 'sequence-account';
const SUBJECT = 'sequence-subject';
const execFileAsync = promisify(execFile);
type FixtureSequenceResult = ReturnType<typeof appliedSequenceResult>
  | ReturnType<typeof deferredSequenceResult>;

describeWithPostgres('P3-10 durable PostgreSQL Sequence lanes and immutable receipts', () => {
  let isolated: IsolatedPostgresRuntime;
  let credential: VerifiedExtensionCredential;
  let minted: Awaited<ReturnType<typeof mintExtensionCredentialHttpFixture>>;
  let identity = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_sequence', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query(
        'insert into account_identities(id,account_id,issuer,subject) values ($1,$2,$3,$4)',
        ['sequence-identity', ACCOUNT, ISSUER, 'sequence-oidc'],
      );
      await client.query("insert into profile_handles(handle,account_id) values ('sync_sequence',$1)", [ACCOUNT]);
      await client.query(
        "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')",
        [COLLECTION, 'sequence-root'],
      );
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'Sequence','bookmarks',$3,'collection-r1','content-r1','policy-r1')`,
      [COLLECTION, SUBJECT, 'sequence-root']);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ($1,$2,'folder',true,'Root','root-r1','children-r1')`, ['sequence-root', COLLECTION]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 'sequence-oidc', credentialId: 'sequence-credential',
      evidenceTtlSeconds: 3_600,
    });
    credential = minted.credential;
  }, 20_000);

  afterAll(async () => isolated?.close());

  async function context() {
    const suffix = `${++identity}-${randomUUID()}`;
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `sequence-device-${suffix}`,
      replicaId: () => `sequence-replica-${suffix}`,
      leaseId: () => `sequence-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Sequence device',
      replicaName: 'Sequence replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `sequence-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `sequence-installation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 31), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    }).issue({
      credential, idempotencyKey: `sequence-session-${suffix}`,
      requestFingerprint: `sequence-fingerprint-${suffix}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push'],
      origin: ORIGIN,
    });
    return {
      replica,
      session: issued.session,
      request: syncSequenceAdmission(issued.session, replica.replicaId, {
        transactionalAuthority: { credential, origin: ORIGIN },
      }),
    };
  }

  const execute = async (
    request: SyncSequenceAdmissionInput,
    result: FixtureSequenceResult = appliedSequenceResult(request.operationId, request.sequence),
  ) => createPostgresSyncSequencePort(isolated.runtime.db).coordinate(request, async () => ({
    status: result.status,
    result,
  }));

  test('SYNC-R01 claims fresh resolver lane slots without reusing the source Sequence', async () => {
    const source = await context();
    await execute(source.request); // source replica owns Sequence 1 of its own lane

    const resolver = await context();
    // The production resolution transaction reserves the opId in the ledger before
    // claiming its lane slot; the claim asserts that reservation. Mirror that shape.
    const claim = (operationId: string, conflictId: string) =>
      createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
        await sql`insert into resource_id_ledger(resource_id, resource_type)
          values (${operationId}, 'operation')
          on conflict (resource_id) do nothing`.execute(transaction);
        return claimSyncResolutionLaneSlot(transaction, {
          replicaId: resolver.replica.replicaId,
          collectionId: COLLECTION,
          sessionId: resolver.session.sessionId,
          operationId,
          canonicalDigest: 'b'.repeat(64),
          result: { conflictId, resolution: 'incoming', operationId },
        });
      });
    // Unoccupied resolver lane: the first conflict resolution claim starts at Sequence 1.
    assert.equal(await claim('resolution-op-1', 'conflict-1'), 1);
    // A second resolution claims the next slot: unique and monotonic per lane.
    assert.equal(await claim('resolution-op-2', 'conflict-2'), 2);
    const resolverRows = await isolated.runtime.pool.query(`select
      (select next_sequence::text from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts,
      (select string_agg(status, ',' order by sequence_number) from sync_sequence_receipts
        where replica_id=$1) statuses,
      (select count(*)::int from sync_sequence_operation_claims
        where replica_id=$1 and canonical_digest=$2) digest_claims`,
    [resolver.replica.replicaId, 'b'.repeat(64)]);
    assert.deepEqual(resolverRows.rows[0], {
      next_sequence: '3', claims: 2, receipts: 2, statuses: 'applied,applied', digest_claims: 2,
    });
    // The resolver Sequence coordinator stays continuous across server-claimed slots.
    const next = await execute({ ...resolver.request, sequence: 3,
      operationId: 'resolver.operation.3', payload: { sequence: 3 } });
    assert.equal(next.result.kind, 'executed');

    // Occupied resolver lane: the claim must skip past the resolver's own Sequence.
    const occupied = await context();
    await execute(occupied.request); // occupies Sequence 1 of its own lane
    assert.equal(await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await sql`insert into resource_id_ledger(resource_id, resource_type)
        values ('occupied-resolution-op', 'operation')
        on conflict (resource_id) do nothing`.execute(transaction);
      return claimSyncResolutionLaneSlot(transaction, {
        replicaId: occupied.replica.replicaId,
        collectionId: COLLECTION,
        sessionId: occupied.session.sessionId,
        operationId: 'occupied-resolution-op',
        canonicalDigest: 'c'.repeat(64),
        result: { conflictId: 'conflict-3', resolution: 'server',
          operationId: 'occupied-resolution-op' },
      });
    }), 2);
    const resolverTuples = await isolated.runtime.pool.query(`select sequence_number::text
      from sync_sequence_operation_claims where replica_id=$1 order by sequence_number`,
    [resolver.replica.replicaId]);
    // Resolution claims occupy 1 and 2; the resolver's own pushed operation continues at 3
    // on the same lane (unique, monotonic, no reuse of any source Sequence).
    assert.deepEqual(resolverTuples.rows.map((row) => row.sequence_number), ['1', '2', '3']);
    const occupiedTuples = await isolated.runtime.pool.query(`select sequence_number::text
      from sync_sequence_operation_claims where replica_id=$1 order by sequence_number`,
    [occupied.replica.replicaId]);
    // The occupied replica pushed its own operation at 1, and the resolution claim
    // skips past it to 2 (the source Sequence 1 is never reused).
    assert.deepEqual(occupiedTuples.rows.map((row) => row.sequence_number), ['1', '2']);
    // The resolution claim skips past the occupied Sequence (1): the claimed slot for
    // the resolution operation itself is 2, never the source Sequence (1).
    const resolutionClaimed = await isolated.runtime.pool.query(`select sequence_number::text
      from sync_sequence_operation_claims
      where replica_id=$1 and operation_id='occupied-resolution-op'`,
    [occupied.replica.replicaId]);
    assert.deepEqual(resolutionClaimed.rows.map((row) => row.sequence_number), ['2']);
    // The source replica lane stays untouched: the source op remains a dependency only.
    const sourceRows = await isolated.runtime.pool.query(`select
      (select next_sequence::text from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [source.replica.replicaId]);
    assert.deepEqual(sourceRows.rows[0], { next_sequence: '2', claims: 1, receipts: 1 });

    // Exact replay never claims a second slot: re-claiming the same operation fails
    // atomically and leaves the resolver lane untouched.
    const beforeReplay = await isolated.runtime.pool.query(`select
      (select next_sequence::text from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [resolver.replica.replicaId]);
    await assert.rejects(claim('resolution-op-1', 'conflict-1'),
      (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'unique_violation');
    const afterReplay = await isolated.runtime.pool.query(`select
      (select next_sequence::text from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [resolver.replica.replicaId]);
    assert.deepEqual(afterReplay.rows[0], beforeReplay.rows[0]);
  });
});
