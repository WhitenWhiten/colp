import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPushResult } from '@know-n/colp/types';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncPushApplication,
  createPostgresSyncSequencePort,
  createPostgresSyncSessionIssuer,
  SyncSequencePersistenceError,
} from '../../../src/infrastructure/sync/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import {
  canonicalSyncSequenceAttemptDigest,
  canonicalSyncSequenceDigest,
  canonicalSyncSequenceResultDigest,
  SYNC_SEQUENCE_DIGEST_ATTEMPT_V1,
} from '../../../src/modules/sync/index.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncSequenceAdmission } from '../../fixtures/phase3/sync-sequence.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { parseSyncPushResult } from '../../../../Known-Extension/src/sync-push-wire.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION_MARKER = 'postgres-T07-PUSH-SECRET-TOKEN-MARKER';
const COLLECTION = 'AAAAAAAAAAAAAAAAAAAAAA';
const ACCOUNT = 'BBBBBBBBBBBBBBBBBBBBBw';
const SUBJECT = 'push-t07-subject';

function problem(body: Problem | SyncPushResult): Problem {
  assert.ok('code' in body, 'expected COLP Problem');
  return body;
}

describeWithPostgres('T-07 cross-Session Sequence receipt (SRG-11)', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t07_sync_sequence_replay', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    const now = new Date('2026-07-26T02:00:00.000Z');
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'T-07 owner')", [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('t07-identity',$1,$2,'t07-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('t07_push',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),('t07-root','node'),('t07-node','node')`, [COLLECTION]);
      const collectionPayload = materializeCollectionPayload({
        id: COLLECTION, ownerSubjectId: SUBJECT, title: 'T-07', summary: null,
        kind: 'bookmarks', visibility: 'private', allowSearchIndexing: false,
        rootNodeId: 't07-root', resourceRevision: 'collection-r1',
        contentRevision: 'content-r1', policyRevision: 'policy-r1', commitOrdinal: 0n,
        createdAt: now, updatedAt: now, deletedAt: null,
      });
      assert.equal(collectionPayload.ok, true);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'T-07','bookmarks','private','t07-root','collection-r1','content-r1',
          'policy-r1',0,$3,$3,$4,$5,'backfilled')`,
      [COLLECTION, SUBJECT, now, collectionPayload.ok ? collectionPayload.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('t07-root',$1,'folder',true,'Root','root-r1','children-r1')`, [COLLECTION]);
      const nodePayload = materializeNodePayload({
        id: 't07-node', collectionId: COLLECTION, parentId: 't07-root',
        kind: 'folder', isRoot: false, title: 'Before', url: null, description: null,
        tags: [], visibility: 'inherit', positionToken: 'A', resourceRevision: 'node-r1',
        childrenRevision: 'node-children-r1', createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
      });
      assert.equal(nodePayload.ok, true);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,position_token,resource_revision,children_revision,
         created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ('t07-node',$1,'t07-root','folder',false,'Before','A','node-r1','node-children-r1',$2,$2,$3,$4,'backfilled')`,
      [COLLECTION, now, { ...(nodePayload.ok ? nodePayload.payload : {}), extensions: {} },
        RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }, 20_000);

  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => {
    try { await app.close(); } catch { /* restart evidence may already close it */ }
  })));
  afterAll(async () => isolated?.close());

  async function context(sessionDurationSeconds = 900) {
    const suffix = randomUUID();
    const contextCredential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 't07-oidc', credentialId: `t07-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `t07-device-${suffix}`,
      replicaId: () => `t07-replica-${suffix}`,
      leaseId: () => `t07-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'T-07 device',
      replicaName: 'T-07 replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `t07-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `t07-generation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 41), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential: contextCredential, idempotencyKey: `t07-session-${suffix}`,
      requestFingerprint: `t07-fingerprint-${suffix}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push'], origin: ORIGIN,
    });
    return { replica, issuer, session: issued.session, credential: contextCredential };
  }

  async function start(value: Awaited<ReturnType<typeof context>>) {
    const app = Fastify({ logger: false });
    const credentialVerifier = { async verify({ authorization }: {
      readonly authorization: string | readonly string[] | undefined;
    }) {
      if (authorization !== `Bearer ${AUTHORIZATION_MARKER}`) throw new Error('invalid credential');
      return value.credential;
    } };
    registerSyncPushRoutes(app, {
      path: '/private-entry/operation-ingress', allowedOrigins: [ORIGIN], credentialVerifier,
      application: createPostgresSyncPushApplication(isolated.runtime.db, value.issuer),
      rateLimit: { maxRequests: 400, windowMs: 60_000 }, allowInsecureLoopback: true,
      maxBatchOperations: 1,
    });
    app.get('/.well-known/collection-protocol', async () => {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('not listening');
      return testManifest(`http://127.0.0.1:${address.port}`);
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    return { app, origin: `http://127.0.0.1:${address.port}` };
  }

  function client(origin: string) {
    return createSyncSessionBlackBoxClient({
      manifestUrl: `${origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: `Bearer ${AUTHORIZATION_MARKER}`, origin: ORIGIN,
    });
  }

  async function seedFolder() {
    const suffix = randomUUID();
    const now = new Date('2026-07-26T02:10:00.000Z');
    const id = `t07-folder-${suffix}`;
    const revision = `t07-folder-rev-${suffix}`;
    const materialized = materializeNodePayload({
      id, collectionId: COLLECTION, parentId: 't07-node', kind: 'folder', isRoot: false,
      title: 'T-07 folder', url: null, description: null, tags: [], visibility: 'inherit',
      positionToken: `T-${suffix}`, resourceRevision: revision, childrenRevision: `t07-children-${suffix}`,
      createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(materialized.ok, true);
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [id]);
    await isolated.runtime.pool.query(`insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,position_token,resource_revision,children_revision,
       created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,'t07-node','folder',false,'T-07 folder',$3,$4,$5,$6,$6,$7,$8,'backfilled')`,
    [id, COLLECTION, `T-${suffix}`, revision, `t07-children-${suffix}`, now,
      { ...(materialized.ok ? materialized.payload : {}), extensions: {} }, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'folder',$4,0,null)`, [COLLECTION, id, revision,
      { ...(materialized.ok ? materialized.payload : {}), extensions: {} }]);
    return { id, revision };
  }

  async function issueSecond(first: Awaited<ReturnType<typeof context>>) {
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', first.replica.replicaId).executeTakeFirstOrThrow();
    return first.issuer.issue({
      credential: first.credential, idempotencyKey: `t07-new-session-${randomUUID()}`,
      requestFingerprint: `t07-new-session-fp-${randomUUID()}`, collectionId: COLLECTION,
      replicaId: first.replica.replicaId, expectedLeaseGeneration: String(replica.lease_generation),
      expectedLifecycleRevision: String(replica.lifecycle_revision), binding: first.replica.binding,
      requestedScopes: ['sync:push'], origin: ORIGIN,
    });
  }

  test('Q-02: same logical replay 100 times across Sessions applies once', async () => {
    const folder = await seedFolder();
    const first = await context();
    const server = await start(first);
    const key = `t07-q02-${randomUUID()}`;
    const opId = `t07-q02-op-${randomUUID()}`;
    const request = syncNodeDeletePushRequest({
      sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
      collectionId: COLLECTION, targetId: folder.id, baseRevision: folder.revision, opId, subtree: true,
    });
    const initial = await client(server.origin).push({ idempotencyKey: key, request });
    assert.equal(initial.status, 200);
    for (let index = 0; index < 99; index += 1) {
      const replay = await client(server.origin).push({
        idempotencyKey: `${key}-same-${index}`,
        request: { ...request, batchId: `${first.session.sessionId}.q02-${index}` },
      });
      assert.equal(replay.status, 200);
      assert.equal((replay.body as SyncPushResult).results[0]!.status, 'applied');
    }
    const second = await issueSecond(first);
    assert.notEqual(second.session.sessionId, first.session.sessionId);
    const crossed = await client(server.origin).push({
      idempotencyKey: `${key}-cross`,
      request: { ...request, sessionId: second.session.sessionId, batchId: `${second.session.sessionId}.q02-cross` },
    });
    assert.equal(crossed.status, 200);
    assert.equal((crossed.body as SyncPushResult).results[0]!.status, 'applied');
    const count = (await isolated.runtime.pool.query(
      'select count(*)::int count from sync_node_tombstones where operation_id=$1', [opId])).rows[0].count;
    assert.equal(count, 1);
    const receipts = (await isolated.runtime.pool.query(
      'select count(*)::int count from sync_sequence_receipts where operation_id=$1', [opId])).rows[0].count;
    assert.equal(receipts, 1);
  }, 60_000);

  test('Q-03: different payload, Collection, and retired Replica fail closed', async () => {
    const folder = await seedFolder();
    const first = await context();
    const server = await start(first);
    const opId = `t07-q03-op-${randomUUID()}`;
    const request = syncNodeDeletePushRequest({
      sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
      collectionId: COLLECTION, targetId: folder.id, baseRevision: folder.revision, opId, subtree: true,
    });
    const initial = await client(server.origin).push({ idempotencyKey: `t07-q03-${randomUUID()}`, request });
    assert.equal(initial.status, 200);
    const changed = await client(server.origin).push({
      idempotencyKey: `t07-q03-changed-${randomUUID()}`,
      request: syncNodeDeletePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId: COLLECTION, targetId: folder.id, baseRevision: 'other-revision', opId, subtree: true,
      }),
    });
    assert.equal(changed.status, 409);
    assert.equal(problem(changed.body).code, 'sequence_reuse');
    const other = await context();
    const otherServer = await start(other);
    const stolen = await client(otherServer.origin).push({
      idempotencyKey: `t07-q03-other-${randomUUID()}`,
      request: syncNodeDeletePushRequest({
        sessionId: other.session.sessionId, replicaId: other.replica.replicaId,
        collectionId: COLLECTION, targetId: folder.id, baseRevision: folder.revision, opId, subtree: true,
      }),
    });
    assert.notEqual(stolen.status, 200);
    await isolated.runtime.pool.query(
      `update sync_replicas set status='retired', retired_at=current_timestamp,
        wire_json=jsonb_set(wire_json,'{status}','"retired"') where replica_id=$1`,
      [first.replica.replicaId]);
    const retired = await client(server.origin).push({
      idempotencyKey: `t07-q03-retired-${randomUUID()}`, request,
    });
    assert.notEqual(retired.status, 200);
    assert.ok(['replica_retired', 'authentication_required', 'resource_not_found'].includes(problem(retired.body).code));
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from sync_node_tombstones where operation_id=$1', [opId])).rows[0].count, 1);
  }, 30_000);

  test('Q-04: v1 digest upgrade, cross-generation lineage, and expired Session', async () => {
    const first = await context();
    const admission = syncSequenceAdmission(first.session, first.replica.replicaId, {
      transactionalAuthority: { credential: first.credential, origin: ORIGIN },
    });
    const v1Digest = canonicalSyncSequenceAttemptDigest(admission);
    const result = { status: 'applied' as const, opId: admission.operationId, sequence: 1, cursor: 'c1', warnings: [] };
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [admission.operationId]);
    await isolated.runtime.pool.query(
      `insert into sync_sequence_lanes (replica_id,collection_id,sequence_scope) values ($1,$2,$3)`,
      [first.replica.replicaId, COLLECTION, admission.sequenceScope]);
    await isolated.runtime.pool.query(
      `insert into sync_sequence_operation_claims
        (operation_id,replica_id,collection_id,sequence_scope,sequence_number,canonical_digest,digest_algorithm)
        values ($1,$2,$3,$4,1,$5,$6)`,
      [admission.operationId, first.replica.replicaId, COLLECTION, admission.sequenceScope, v1Digest,
        SYNC_SEQUENCE_DIGEST_ATTEMPT_V1]);
    await isolated.runtime.pool.query(
      `insert into sync_sequence_receipts
        (replica_id,collection_id,sequence_scope,sequence_number,operation_id,canonical_digest,digest_algorithm,
         session_id,lease_generation,server_batch_id,media_type,endpoint_identity,status,
         result_json,result_digest,finalized_at)
        values ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,'applied',$12,$13,current_timestamp)`,
      [first.replica.replicaId, COLLECTION, admission.sequenceScope, admission.operationId, v1Digest,
        SYNC_SEQUENCE_DIGEST_ATTEMPT_V1, first.session.sessionId, admission.leaseGeneration, admission.serverBatchId,
        admission.mediaType, admission.endpointIdentity, result, canonicalSyncSequenceResultDigest(result)]);
    await isolated.runtime.pool.query(
      'update sync_sequence_lanes set next_sequence=2 where replica_id=$1', [first.replica.replicaId]);
    const sameSession = await createPostgresSyncSequencePort(isolated.runtime.db).coordinateAuthorized({
      ...admission,
      transactionalAuthority: { credential: first.credential, origin: ORIGIN },
    }, async () => assert.fail('v1 same-session reached evaluator'));
    assert.equal(sameSession.result.kind, 'replayed');
    await assert.rejects(
      createPostgresSyncSequencePort(isolated.runtime.db).coordinateAuthorized({
        ...admission, payload: { changed: true },
        transactionalAuthority: { credential: first.credential, origin: ORIGIN },
      }, async () => assert.fail('v1 key-reuse reached evaluator')),
      (error: unknown) => error instanceof SyncSequencePersistenceError && error.code === 'idempotency_key_reused',
    );
    const second = await issueSecond(first);
    const upgraded = await createPostgresSyncSequencePort(isolated.runtime.db).coordinateAuthorized({
      ...admission,
      session: second.session,
      serverBatchId: `${second.session.sessionId}.v2-upgrade`,
      transactionalAuthority: { credential: first.credential, origin: ORIGIN },
    }, async () => assert.fail('v1 upgrade reached evaluator'));
    assert.equal(upgraded.result.kind, 'replayed');
    const replayed = upgraded.result.kind === 'replayed' ? upgraded.result.receipt.result as typeof result : null;
    assert.equal(replayed?.status, 'applied');
    assert.equal(replayed?.opId, result.opId);
    assert.equal(replayed?.cursor, result.cursor);
    assert.equal(canonicalSyncSequenceDigest({
      ...admission, session: second.session, serverBatchId: `${second.session.sessionId}.v2-upgrade`,
    }), canonicalSyncSequenceDigest(admission));

    const expired = await context(1);
    const expiredServer = await start(expired);
    await new Promise((resolve) => { setTimeout(resolve, 1_200); });
    const expiredPush = await client(expiredServer.origin).push({
      idempotencyKey: `t07-expired-${randomUUID()}`,
      request: syncNodeCreatePushRequest({
        sessionId: expired.session.sessionId, replicaId: expired.replica.replicaId,
        collectionId: COLLECTION, parentId: 't07-root', opId: `t07-expired-${randomUUID()}`,
      }),
    });
    assert.notEqual(expiredPush.status, 200);
    assert.ok(['authentication_required', 'session_expired'].includes(problem(expiredPush.body).code));

    await assert.rejects(
      createPostgresSyncSequencePort(isolated.runtime.db).coordinate({
        ...admission, leaseGeneration: '9',
        transactionalAuthority: { credential: first.credential, origin: ORIGIN },
      }, async () => assert.fail('cross-generation reached evaluator')),
      (error: unknown) => error instanceof SyncSequencePersistenceError && error.code === 'stale_replica',
    );
  }, 30_000);

  test('Q-06: AUD-09 real HTTP witness applies once and locally settles', async () => {
    const folder = await seedFolder();
    const first = await context();
    const server = await start(first);
    const key = `t07-q06-${randomUUID()}`;
    const opId = `t07-q06-op-${randomUUID()}`;
    const request = syncNodeDeletePushRequest({
      sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
      collectionId: COLLECTION, targetId: folder.id, baseRevision: folder.revision, opId, subtree: true,
    });
    const initial = await client(server.origin).push({ idempotencyKey: key, request });
    assert.equal(initial.status, 200);
    assert.equal((initial.body as SyncPushResult).results[0]!.status, 'applied');
    const same = await client(server.origin).push({ idempotencyKey: key, request });
    assert.equal(same.status, 200);
    const second = await issueSecond(first);
    assert.notEqual(second.session.sessionId, first.session.sessionId);
    const retried = await client(server.origin).push({
      idempotencyKey: key,
      request: { ...request, sessionId: second.session.sessionId, batchId: `${second.session.sessionId}.audit-client` },
    });
    assert.equal(retried.status, 200);
    const body = retried.body as SyncPushResult;
    assert.equal(body.results[0]!.status, 'applied');
    assert.notEqual(body.batchId, (initial.body as SyncPushResult).batchId);
    const parsed = parseSyncPushResult(body, { opId, sequence: 1 });
    assert.equal(parsed.terminal, true);
    assert.equal(parsed.result.status, 'applied');
    assert.equal(typeof parsed.result.targetId, 'string');
    const count = (await isolated.runtime.pool.query(
      'select count(*)::int count from sync_node_tombstones where operation_id=$1', [opId])).rows[0].count;
    assert.equal(count, 1);
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from sync_sequence_receipts where operation_id=$1', [opId])).rows[0].count, 1);
  }, 30_000);
});

function testManifest(origin: string): Manifest {
  return {
    protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111117', title: 'Known',
    mounts: [{
      id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncPush: `${origin}/private-entry/operation-ingress` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 },
    }],
  } as Manifest;
}
