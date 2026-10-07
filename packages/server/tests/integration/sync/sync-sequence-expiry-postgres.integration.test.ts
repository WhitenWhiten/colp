import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  SyncSequencePersistenceError,
  createPostgresReplicaStore,
  createPostgresSyncSequencePort,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import type { VerifiedExtensionCredential } from '../../../src/modules/identity/index.js';
import { mintExtensionCredentialHttpFixture, verifyExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import {
  appliedSequenceResult,
  syncSequenceAdmission,
} from '../../fixtures/phase3/sync-sequence.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const COLLECTION = 'sequence-collection';
const ACCOUNT = 'sequence-account';
const SUBJECT = 'sequence-subject';

describeWithPostgres('Sequence authority expiry after blocking locks', () => {
  let isolated: IsolatedPostgresRuntime;
  let credential: VerifiedExtensionCredential;
  let minted: Awaited<ReturnType<typeof mintExtensionCredentialHttpFixture>>;
  let identity = 0;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sequence_expiry', { maxConnections: 12 });
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

  async function context(deadline: 'session' | 'lease' | 'evidence' = 'session') {
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
      leaseDurationSeconds: deadline === 'lease' ? 60 : 3_600,
    }, { actorAccountId: ACCOUNT });
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 31), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: deadline === 'session' ? 1 : 90, replicaLeaseExtensionSeconds: deadline === 'lease' ? 60 : 3_600,
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
    const requestCredential = deadline === 'evidence' ? await verifyExtensionCredentialFixture({
      authorization: minted.authorization, jwk: minted.jwk, issuer: ISSUER,
      audience: 'known-api', clientId: 'known-extension', evidenceTtlSeconds: 1,
    }) : credential;
    const request = syncSequenceAdmission(issued.session, replica.replicaId, {
      transactionalAuthority: { credential: requestCredential, origin: ORIGIN },
    });
    if (request.transactionalAuthority === undefined) throw new Error('Fixture requires transactional authority');
    return {
      replica,
      session: issued.session,
      request: { ...request, transactionalAuthority: request.transactionalAuthority },
    };
  }

  test('rejects a Session already expired before the write starts (control)', async () => {
    const fixture = await context();
    await isolated.runtime.pool.query('select pg_sleep(1.1)');
    let evaluated = false;
    await assert.rejects(createPostgresSyncSequencePort(isolated.runtime.db).coordinateAuthorized(fixture.request, async () => {
      evaluated = true;
      return { status: 'applied', result: appliedSequenceResult(fixture.request.operationId) };
    }));
    assert.equal(evaluated, false);
  });

  test.each([
    ['session', 'sync_sessions', 'session_expired'],
    ['session', 'collections', 'session_expired'],
    ['session', 'sync_sequence_lanes', 'session_expired'],
    ['evidence', 'sync_sequence_lanes', 'authorization_denied'],
    ['lease', 'sync_sequence_lanes', 'stale_replica'],
  ] as const)('rejects expired %s after waiting on %s (%s)', async (deadline, table, code) => {
    const fixture = await context(deadline);
    const blocker = await isolated.runtime.pool.connect();
    let pending: Promise<unknown> | undefined;
    let evaluated = false;
    try {
      const expiry = deadline === 'evidence' ? fixture.request.transactionalAuthority.credential.evidenceExpiresAt
        : deadline === 'session'
          ? (await blocker.query('select expires_at as expiry from sync_sessions where session_id=$1', [fixture.session.sessionId])).rows[0].expiry
          : (await blocker.query('select lease_expires_at as expiry from sync_replicas where replica_id=$1', [fixture.replica.replicaId])).rows[0].expiry;
      // Let the supported 60s lease age outside any transaction. Start contention
      // with 3s remaining, below the production 5s lock timeout; keep the real DB clock.
      if (deadline === 'lease') {
        for (;;) {
          const remaining = Number((await blocker.query(
            'select extract(epoch from ($1::timestamptz - clock_timestamp())) as seconds', [expiry],
          )).rows[0].seconds);
          if (remaining <= 3) break;
          await blocker.query('select pg_sleep($1)', [Math.min(10, remaining - 3)]);
        }
      }
      if (table === 'sync_sequence_lanes') {
        await blocker.query('insert into sync_sequence_lanes(replica_id,collection_id,sequence_scope) values($1,$2,$3)',
          [fixture.replica.replicaId, COLLECTION, fixture.request.sequenceScope]);
      }
      await blocker.query('begin');
      if (table === 'sync_sessions') {
        await blocker.query('select session_id from sync_sessions where session_id=$1 for update', [fixture.session.sessionId]);
      } else if (table === 'collections') {
        await blocker.query('select id from collections where id=$1 for update', [COLLECTION]);
      } else {
        await blocker.query('select replica_id from sync_sequence_lanes where replica_id=$1 for update', [fixture.replica.replicaId]);
      }
      const live = await blocker.query('select clock_timestamp() < $1::timestamptz as live', [expiry]);
      assert.equal(live.rows[0].live, true, 'authority must be live before starting the blocked request');
      pending = createPostgresSyncSequencePort(isolated.runtime.db).coordinateAuthorized(fixture.request, async () => {
        evaluated = true;
        return { status: 'applied', result: appliedSequenceResult(fixture.request.operationId) };
      }).then(result => ({ result }), error => ({ error }));
      await waitForCondition(async () => {
        const rows = await isolated.runtime.pool.query(
          "select count(*)::int as count from pg_stat_activity where wait_event_type='Lock' and query like $1", ['%' + table + '%']);
        return rows.rows[0].count > 0;
      }, { timeoutMs: 3000, pollIntervalMs: 10, description: 'Sequence transaction blocked on authority/lane row' });
      await blocker.query('select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))) + 0.05)', [expiry]);
      await blocker.query('commit');
      const outcome = await pending as { error?: unknown };
      assert.ok(outcome.error instanceof SyncSequencePersistenceError);
      assert.equal(outcome.error.code, code);
      assert.equal(evaluated, false, 'expired authority must not enter business evaluation');
      const persisted = (await isolated.runtime.pool.query(
        'select count(*)::int as receipts from sync_sequence_receipts where operation_id=$1', [fixture.request.operationId],
      )).rows[0];
      assert.equal(persisted.receipts, 0, 'expired requests must not persist receipts');
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await pending;
    }
  }, 75_000);
});
