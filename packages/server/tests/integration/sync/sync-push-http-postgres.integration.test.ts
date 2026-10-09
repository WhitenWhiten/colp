import assert from 'node:assert/strict';
import { observeSubtree } from '../../support/subtree-observation.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPushResult } from '@know-n/colp/types';
import { classifyDatabaseError, createDatabaseRuntime, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresReplicaRetirementApplication,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import type { SyncPushHttpApplication } from '../../../src/modules/sync/index.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { syncPushAdmissionRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
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
import { recordPhase3SyncPushScenario } from '../../support/phase3-sync-push-acceptance-recorder.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION_MARKER = 'postgres-PUSH-SECRET-TOKEN-MARKER';
const COLLECTION = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_COLLECTION = 'push-http-other-collection';
const ACCOUNT = 'BBBBBBBBBBBBBBBBBBBBBw';
const SUBJECT = 'push-http-subject';

function problem(body: Problem | SyncPushResult): Problem {
  assert.ok('code' in body, 'expected COLP Problem');
  return body;
}

describeWithPostgres('P3-11 real HTTP/PostgreSQL single-operation Push admission', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_push_http', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'Push admission owner')", [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('push-http-identity',$1,$2,'push-http-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('sync_push_http',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),('push-http-root','node'),('push-http-node','node'),
        ($2,'collection'),('push-http-other-root','node')`, [COLLECTION, OTHER_COLLECTION]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'Push admission','bookmarks','private','push-http-root','collection-r1','content-r1',
          'policy-r1',0,$3,$3,$4,$5,'backfilled')`,
      [COLLECTION, SUBJECT, new Date('2026-07-26T02:00:00.000Z'),
        (() => {
          const materialized = materializeCollectionPayload({
            id: COLLECTION, ownerSubjectId: SUBJECT, title: 'Push admission', summary: null,
            kind: 'bookmarks', visibility: 'private', allowSearchIndexing: false,
            rootNodeId: 'push-http-root', resourceRevision: 'collection-r1',
            contentRevision: 'content-r1', policyRevision: 'policy-r1', commitOrdinal: 0n,
            createdAt: new Date('2026-07-26T02:00:00.000Z'),
            updatedAt: new Date('2026-07-26T02:00:00.000Z'), deletedAt: null,
          });
          assert.equal(materialized.ok, true);
          return materialized.ok ? materialized.payload : {};
        })(),
        RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('push-http-root',$1,'folder',true,'Root','root-r1','children-r1')`, [COLLECTION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,position_token,resource_revision,children_revision,
         created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'push-http-root','folder',false,'Before','A','node-r1','node-children-r1',$3,$3,$4,$5,'backfilled')`,
      ['push-http-node', COLLECTION, new Date('2026-07-26T02:00:00.000Z'),
        (() => {
          const materialized = materializeNodePayload({
            id: 'push-http-node', collectionId: COLLECTION, parentId: 'push-http-root',
            kind: 'folder', isRoot: false, title: 'Before', url: null, description: null,
            tags: [], visibility: 'inherit', positionToken: 'A', resourceRevision: 'node-r1',
            childrenRevision: 'node-children-r1', createdAt: new Date('2026-07-26T02:00:00.000Z'),
            updatedAt: new Date('2026-07-26T02:00:00.000Z'), deletedAt: null, deletedCommitOrdinal: null,
          });
          assert.equal(materialized.ok, true);
          return { ...(materialized.ok ? materialized.payload : {}), extensions: {} };
        })(),
        RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'Other Push admission','bookmarks','push-http-other-root',
          'other-collection-r1','other-content-r1','other-policy-r1')`, [OTHER_COLLECTION, SUBJECT]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('push-http-other-root',$1,'folder',true,'Other Root','other-root-r1','other-children-r1')`,
      [OTHER_COLLECTION]);
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
      subject: 'push-http-oidc', credentialId: `push-http-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `push-http-device-${suffix}`,
      replicaId: () => `push-http-replica-${suffix}`,
      leaseId: () => `push-http-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Push device',
      replicaName: 'Push replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `push-http-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `push-http-generation-${suffix}` },
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
      credential: contextCredential, idempotencyKey: `push-session-${suffix}`,
      requestFingerprint: `push-fingerprint-${suffix}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push'], origin: ORIGIN,
    });
    return { replica, issuer, session: issued.session, credential: contextCredential };
  }

  async function start(value: Awaited<ReturnType<typeof context>>, options: {
    readonly responseGate?: Promise<void>;
    readonly onResponseGate?: () => void;
    readonly database?: DatabaseRuntime['db'];
    readonly application?: SyncPushHttpApplication;
  } = {}) {
    const app = Fastify({ logger: false });
    if (options.responseGate) {
      app.addHook('onSend', async (request, _reply, payload) => {
        if (request.url === '/private-entry/operation-ingress') {
          options.onResponseGate?.();
          await options.responseGate;
        }
        return payload;
      });
    }
    const credentialVerifier = { async verify({ authorization }: {
      readonly authorization: string | readonly string[] | undefined;
    }) {
      if (authorization !== `Bearer ${AUTHORIZATION_MARKER}`) throw new Error('invalid credential');
      return value.credential;
    } };
    registerSyncPushRoutes(app, {
      path: '/private-entry/operation-ingress', allowedOrigins: [ORIGIN], credentialVerifier,
      application: options.application
        ?? createPostgresSyncPushApplication(options.database ?? isolated.runtime.db, value.issuer),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, allowInsecureLoopback: true,
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

  function client(origin: string, fetchImplementation?: typeof fetch) {
    return createSyncSessionBlackBoxClient({
      manifestUrl: `${origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: `Bearer ${AUTHORIZATION_MARKER}`, origin: ORIGIN,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  async function rowCounts(replicaId: string) {
    const result = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_lanes where replica_id=$1) lanes,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts,
      (select count(*)::int from operations where collection_id=$2) operations,
      (select count(*)::int from audit_events where collection_id=$2) audits,
      (select count(*)::int from outbox_events where aggregate_id=$2) outbox,
      (select jsonb_agg(to_jsonb(node) order by node.id) from nodes node where collection_id=$2) canonical_nodes,
      (select count(*)::int from resource_id_ledger) ledger`, [replicaId, COLLECTION]);
    return result.rows[0];
  }

  async function seedBulkSubtree(count: number, extensionBytes: number) {
    const suffix = randomUUID();
    const now = new Date('2026-07-26T02:10:00.000Z');
    const rows: { id: string; parentId: string; kind: 'folder' | 'bookmark'; title: string;
      revision: string; positionToken: string; extension: Record<string, unknown> | undefined }[] = [{
      id: `fix9-root-${suffix}`, parentId: 'push-http-node', kind: 'folder',
      title: 'FIX-M-009 bulk root', revision: `fix9-root-rev-${randomUUID()}`,
      positionToken: `M0-${randomUUID()}`, extension: undefined,
    }];
    for (let index = 0; index < count; index += 1) {
      rows.push({ id: `fix9-child-${index}-${suffix}`, parentId: `fix9-root-${suffix}`, kind: 'bookmark',
        title: `FIX-M-009 bulk child ${index}`, revision: `fix9-child-rev-${index}-${randomUUID()}`,
        positionToken: `M${index + 1}-${randomUUID()}`,
        extension: { 'https://extensions.example/fix9': { index, blob: 'x'.repeat(extensionBytes) } } });
    }
    for (const row of rows) {
      const materialized = materializeNodePayload({
        id: row.id, collectionId: COLLECTION, parentId: row.parentId, kind: row.kind, isRoot: false,
        title: row.title, url: row.kind === 'bookmark' ? `https://example.test/${row.id}` : null,
        description: null, tags: [], visibility: 'inherit', positionToken: row.positionToken,
        resourceRevision: row.revision, childrenRevision: `fix9-children-${suffix}`,
        createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
      });
      assert.equal(materialized.ok, true);
      const payload = { ...(materialized.ok ? materialized.payload : {}),
        extensions: row.extension ?? {} };
      await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [row.id]);
      await isolated.runtime.pool.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,
         resource_revision,children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,$3,$4,false,$5,$6,null,null,'inherit',$7,$8,$9,$10,$10,$11,$12,'backfilled')`,
      [row.id, COLLECTION, row.parentId, row.kind, row.title,
        row.kind === 'bookmark' ? `https://example.test/${row.id}` : null, row.positionToken,
        row.revision, `fix9-children-${suffix}`, now, payload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await isolated.runtime.pool.query(`insert into sync_node_revision_history
        (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
        values ($1,$2,$3,$4,$5,0,null)`, [COLLECTION, row.id, row.revision, row.kind, payload]);
    }
    return { rootId: rows[0]!.id, rootRevision: rows[0]!.revision,
      memberIds: rows.map((row) => row.id) };
  }

  test('routes a schema-valid operation through Sequence then rolls back unsupported evaluator side effects', async () => {
    const value = await context();
    const server = await start(value);
    const before = await rowCounts(value.replica.replicaId);
    const request = syncPushAdmissionRequest({
      type: 'update_collection_metadata',
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, opId: `push-http-operation-${randomUUID()}`,
      batchId: `${value.session.sessionId}.attacker-chosen-batch-marker`,
    });
    const denied = await client(server.origin).push({ idempotencyKey: 'push-http-key', request });
    assert.equal(denied.status, 422);
    assert.equal(problem(denied.body).code, 'unsupported_operation');
    assert.deepEqual(await rowCounts(value.replica.replicaId), before);

    const changedClientBatch = await client(server.origin).push({
      idempotencyKey: 'push-http-key',
      request: { ...request, batchId: `${value.session.sessionId}.different-client-batch` },
    });
    assert.equal(problem(changedClientBatch.body).code, 'unsupported_operation');
    assert.deepEqual(await rowCounts(value.replica.replicaId), before);
  });

  test('restart, concurrency and lost-response retries remain explicit denials with zero durable mutation', async () => {
    const value = await context();
    const first = await start(value);
    const before = await rowCounts(value.replica.replicaId);
    const request = syncPushAdmissionRequest({
      type: 'update_collection_metadata',
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, opId: `push-http-operation-${randomUUID()}`,
    });
    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      client(first.origin).push({ idempotencyKey: 'push-concurrent-key', request })));
    assert.ok(responses.every((response) => problem(response.body).code === 'unsupported_operation'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let responseHeldResolve!: () => void;
    const responseHeld = new Promise<void>((resolve) => { responseHeldResolve = resolve; });
    await first.app.close();
    const lossy = await start(value, { responseGate: gate, onResponseGate: responseHeldResolve });
    const abort = new AbortController();
    const lossyFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: abort.signal });
    const pending = client(lossy.origin, lossyFetch).push({ idempotencyKey: 'push-concurrent-key', request });
    await responseHeld;
    abort.abort();
    release();
    await assert.rejects(pending, /abort/iu);
    await lossy.app.close();
    const restarted = await start(value);
    const replay = await client(restarted.origin).push({ idempotencyKey: 'push-concurrent-key', request });
    assert.equal(problem(replay.body).code, 'unsupported_operation');
    assert.deepEqual(await rowCounts(value.replica.replicaId), before);
  }, 20_000);

  type FailClosedScenario = {
    readonly create: () => Promise<Awaited<ReturnType<typeof context>>>;
    readonly preflight?: (value: Awaited<ReturnType<typeof context>>, origin: string) => Promise<void>;
    readonly mutate: (value: Awaited<ReturnType<typeof context>>) => Promise<void>;
  };

  test('transaction authority revocation, expiry, stale generation and policy changes fail closed', async () => {
    const scenarios: readonly FailClosedScenario[] = [
      { create: () => context(), mutate: async (value: Awaited<ReturnType<typeof context>>) => isolated.runtime.pool.query(
        'update sync_extension_credentials set revoked_at=current_timestamp where credential_id=$1',
        [value.credential.credentialId]) },
      // FIX-L-041 / SYNC-R25: expiry must be deterministic, not a 100ms wall-clock
      // race. The production verifier compares sync_sessions.expires_at against the
      // PostgreSQL current_timestamp (SYNC-V-011). The DB clock cannot be advanced
      // from the test: sync_sessions_terminal_immutable forbids rewriting an active
      // session's issued_at/expires_at, so the expiry boundary cannot be moved into
      // the past. Fallback per FIX-L-041: this single case pays the wall-clock cost
      // with a widened TTL (5s instead of 1s) and a widened wait (7s). The preflight
      // below proves the session is live inside the TTL window (success before the
      // boundary); `mutate` then waits 7s, so the denied push happens at
      // issuance + overhead + 7s > issuance + 5s, a deterministic >=2s past expiry.
      { create: () => context(5),
        preflight: async (value, origin) => {
          const seeded = await seedBulkSubtree(1, 0);
          const live = await client(origin).push({
            idempotencyKey: `expiry-live-${randomUUID()}`,
            request: syncNodeDeletePushRequest({
              sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
              collectionId: COLLECTION, targetId: seeded.rootId, baseRevision: seeded.rootRevision,
              opId: `expiry-live-${randomUUID()}`, subtree: true, source: await observeSubtree(isolated.runtime.db, seeded.rootId),
            }),
          });
          assert.equal(live.status, 200);
          assert.equal((live.body as SyncPushResult).results[0]!.status, 'applied');
        },
        mutate: async () => new Promise<void>((resolve) => setTimeout(resolve, 7_000)) },
      { create: () => context(), mutate: async () => isolated.runtime.pool.query(
        'update collections set policy_revision=$2 where id=$1', [COLLECTION, `changed-${randomUUID()}`]) },
      { create: () => context(), mutate: async (value: Awaited<ReturnType<typeof context>>) => isolated.runtime.pool.query(
        "update sync_replicas set status='recovery_required' where replica_id=$1", [value.replica.replicaId]) },
      { create: () => context(), mutate: async (value: Awaited<ReturnType<typeof context>>) => isolated.runtime.pool.query(
        "update sync_replicas set status='retired',retired_at=current_timestamp where replica_id=$1", [value.replica.replicaId]) },
    ];
    for (const scenario of scenarios) {
      const value = await scenario.create();
      const server = await start(value);
      await scenario.preflight?.(value, server.origin);
      const before = await rowCounts(value.replica.replicaId);
      await scenario.mutate(value);
      const response = await client(server.origin).push({ idempotencyKey: `denied-${randomUUID()}`, request: syncPushAdmissionRequest({
        type: 'delete_node',
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `denied-operation-${randomUUID()}`,
      }) });
      assert.notEqual(response.status, 200);
      assert.notEqual(problem(response.body).code, 'unsupported_operation');
      assert.deepEqual(await rowCounts(value.replica.replicaId), before);
      await server.app.close();
      await isolated.runtime.pool.query("update collections set policy_revision='policy-r1' where id=$1", [COLLECTION]);
    }
  }, 30_000);

  test('conceals cross-Collection and wrong-Replica bindings without lane, claim or receipt', async () => {
    const value = await context();
    const server = await start(value);
    const before = await rowCounts(value.replica.replicaId);
    for (const request of [
      syncPushAdmissionRequest({ sessionId: value.session.sessionId,
        type: 'delete_node',
        replicaId: value.replica.replicaId, collectionId: OTHER_COLLECTION,
        opId: `cross-collection-${randomUUID()}` }),
      syncPushAdmissionRequest({ sessionId: value.session.sessionId,
        type: 'delete_node',
        replicaId: 'other-account-replica', collectionId: COLLECTION,
        opId: `wrong-replica-${randomUUID()}` }),
    ]) {
      const response = await client(server.origin).push({
        idempotencyKey: `concealed-${randomUUID()}`, request,
      });
      assert.equal(problem(response.body).code, 'resource_not_found');
      assert.deepEqual(await rowCounts(value.replica.replicaId), before);
    }
  });

  test('retirement fences a concurrent real HTTP Push before Sequence admission', async () => {
    const value = await context();
    const server = await start(value);
    let entered!: () => void;
    let release!: () => void;
    const atReplicaWrite = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const retirement = createPostgresReplicaRetirementApplication(isolated.runtime.db, {
      faultInjector: { async afterPhase(phase) {
        if (phase === 'replica') { entered(); await blocked; }
      } },
    }).retireExtension({ origin: ORIGIN, credential: value.credential, sessionId: value.session.sessionId,
      idempotencyKey: `retire-push-${randomUUID()}`, requestFingerprint: 'retire-push-race' });
    await atReplicaWrite;
    const pending = client(server.origin).push({ idempotencyKey: `push-during-retire-${randomUUID()}`,
      request: syncPushAdmissionRequest({ type: 'update_collection_metadata',
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `push-during-retire-${randomUUID()}` }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await retirement;
    const response = await pending;
    assert.ok(response.status === 401 || response.status === 404 || response.status === 410);
    assert.notEqual(problem(response.body).code, 'unsupported_operation');
    const state = await rowCounts(value.replica.replicaId);
    assert.equal(state.lanes, 0);
    assert.equal(state.claims, 0);
    assert.equal(state.receipts, 0);
  });

  test('FIX-L-032 resumes the Replica after a live push: superseded Session denied with zero Sequence residue', async () => {
    const value = await context();
    const server = await start(value);
    const seeded = await seedBulkSubtree(1, 0);
    const live = await client(server.origin).push({ idempotencyKey: `resume-live-${randomUUID()}`,
      request: syncNodeDeletePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: seeded.rootId,
        baseRevision: seeded.rootRevision, opId: `resume-live-${randomUUID()}`, subtree: true, source: await observeSubtree(isolated.runtime.db, seeded.rootId) }) });
    assert.equal(live.status, 200);
    assert.equal((live.body as SyncPushResult).results[0]!.status, 'applied');
    const before = await rowCounts(value.replica.replicaId);
    // Concurrent resume (SYNC-R16): the Replica advances to generation 2 while
    // the client Session still holds generation-1 evidence.
    // FIX-L-032 resume simulation: advance the generation ledger (new lease ID)
    // and the Replica row together so the FK and wire facts stay consistent —
    // exactly what a real resume commits before the client's next Push.
    await isolated.runtime.pool.query(`with advanced as (
        insert into sync_replica_generations (replica_id, lease_generation, lease_id)
        values ($1, 2, $2)
        returning replica_id, lease_generation, lease_id
      )
      update sync_replicas replica set
        lease_generation = advanced.lease_generation,
        lease_id = advanced.lease_id,
        wire_json = jsonb_set(
          jsonb_set(replica.wire_json, '{leaseGeneration}', to_jsonb(advanced.lease_generation::text)),
          '{leaseId}', to_jsonb(advanced.lease_id)
        )
      from advanced
      where replica.replica_id = $1`,
    [value.replica.replicaId, `push-http-resumed-lease-${randomUUID()}`]);
    const denied = await client(server.origin).push({ idempotencyKey: `resume-denied-${randomUUID()}`,
      request: syncPushAdmissionRequest({ type: 'update_collection_metadata',
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `resume-denied-${randomUUID()}` }) });
    // Stable session-level denial — never a concealment resource_not_found —
    // and the Sequence lane/claim/receipt ledger gains nothing.
    assert.equal(denied.status, 401);
    assert.equal(problem(denied.body).code, 'authentication_required');
    assert.deepEqual(await rowCounts(value.replica.replicaId), before);
  });

  test('P3-16 maps an actual PostgreSQL lock timeout through the real HTTP route without durable progress', async () => {
    const value = await context();
    const short = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 2, lockTimeoutMs: 100, applicationName: 'p3-16-lock-timeout',
    });
    const blocker = await isolated.runtime.pool.connect();
    try {
      await isolated.runtime.pool.query(`insert into sync_sequence_lanes
        (replica_id,collection_id,sequence_scope) values ($1,$2,$3)`,
      [value.replica.replicaId, COLLECTION, `collection:${COLLECTION}`]);
      await blocker.query('begin');
      await blocker.query(`select replica_id from sync_sequence_lanes
        where replica_id=$1 and sequence_scope=$2 for update`,
      [value.replica.replicaId, `collection:${COLLECTION}`]);
      const server = await start(value, { database: short.db });
      const response = await client(server.origin).push({ idempotencyKey: 'p3-16-timeout-key',
        request: syncPushAdmissionRequest({ type: 'update_collection_metadata',
          sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
          collectionId: COLLECTION, opId: `p3-16-timeout-${randomUUID()}` }) });
      assert.equal(response.status, 503);
      assert.equal(problem(response.body).code, 'service_unavailable');
      assert.equal(JSON.stringify(response.body).includes(AUTHORIZATION_MARKER), false);
      const state = (await isolated.runtime.pool.query(`select
        (select count(*)::int from sync_sequence_lanes where replica_id=$1) lanes,
        (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
        (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
      [value.replica.replicaId])).rows[0];
      assert.deepEqual(state, { lanes: 1, claims: 0, receipts: 0 });
      recordPhase3SyncPushScenario('database_timeout');
    } finally {
      await blocker.query('rollback').catch(() => undefined);
      blocker.release();
      await short.close();
    }
  }, 15_000);

  test('P3-16 maps a PostgreSQL deadlock classification through the real HTTP Problem boundary', async () => {
    const left = await isolated.runtime.pool.connect();
    const right = await isolated.runtime.pool.connect();
    let databaseError: ReturnType<typeof classifyDatabaseError> | undefined;
    try {
      await left.query('begin');
      await right.query('begin');
      await left.query('select id from accounts where id=$1 for update', [ACCOUNT]);
      await right.query('select id from collections where id=$1 for update', [COLLECTION]);
      const leftWait = left.query('select id from collections where id=$1 for update', [COLLECTION])
        .then(() => ({ error: undefined }), (error: unknown) => ({ error }));
      await waitForCondition(async () => {
        const blocked = await isolated.runtime.pool.query<{ waiting: boolean }>(`
          select exists(select 1 from pg_stat_activity
            where application_name='known-test-p3_sync_push_http'
              and cardinality(pg_blocking_pids(pid)) > 0) waiting
        `);
        return blocked.rows[0]?.waiting === true;
      }, {
        timeoutMs: 2_000,
        pollIntervalMs: 5,
        description: 'the left deadlock participant to wait on the collection row lock',
      });
      try {
        await right.query('select id from accounts where id=$1 for update', [ACCOUNT]);
      } catch (error) {
        databaseError = classifyDatabaseError(error);
        await right.query('rollback').catch(() => undefined);
      }
      const leftOutcome = await leftWait;
      if (leftOutcome.error) {
        databaseError = classifyDatabaseError(leftOutcome.error);
        await left.query('rollback').catch(() => undefined);
      }
      assert.equal(databaseError?.kind, 'deadlock');
    } finally {
      await left.query('rollback').catch(() => undefined);
      await right.query('rollback').catch(() => undefined);
      left.release();
      right.release();
    }
    const value = await context();
    const application: SyncPushHttpApplication = Object.freeze({
      runtimeOwnership: Object.freeze({ operationIdReservationOwner: 'sequence' as const,
        usesPushCoordinator: false as const, maxBatchOperations: 1 as const,
        evaluator: 'canonical_node_create_update_move_delete' as const,
        trustedBaseOwner: 'sync_node_revision_history' as const,
        conflictBoundary: 'deferred_until_p3_17' as const }),
      async admit() { throw databaseError!; },
    });
    const server = await start(value, { application });
    const response = await client(server.origin).push({ idempotencyKey: 'p3-16-deadlock-key',
      request: syncPushAdmissionRequest({ type: 'update_collection_metadata',
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `p3-16-deadlock-${randomUUID()}` }) });
    assert.equal(response.status, 503);
    assert.equal(problem(response.body).code, 'service_unavailable');
    assert.equal(JSON.stringify(response.body).includes('deadlock'), false);
    recordPhase3SyncPushScenario('database_deadlock');
  }, 20_000);

  test('FIX-M-009 deletes a subtree whose aggregate extensions exceed the single-payload budget', async () => {
    const seeded = await seedBulkSubtree(60, 2_400);
    const value = await context();
    const server = await start(value);
    const request = syncNodeDeletePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: seeded.rootId, baseRevision: seeded.rootRevision,
      opId: `fix9-bulk-${randomUUID()}`, subtree: true, source: await observeSubtree(isolated.runtime.db, seeded.rootId),
    });
    const response = await client(server.origin).push({ idempotencyKey: 'fix9-bulk-key', request });
    assert.equal(response.status, 200);
    assert.equal((response.body as SyncPushResult).results[0]!.status, 'applied');
    const tombstones = (await isolated.runtime.pool.query(`select target_id,affected_count,scope,payload_json
      from sync_node_tombstones where operation_id=$1 order by target_id`, [request.operations[0]!.opId])).rows;
    assert.equal(tombstones.length, seeded.memberIds.length);
    assert.ok(tombstones.every((row) => row.scope === 'subtree'
      && row.affected_count === seeded.memberIds.length));
    const child = tombstones.find((row) => String(row.target_id).startsWith('fix9-child-'))!;
    const childExtension = (child.payload_json as { extensions: {
      'https://extensions.example/fix9': { index: number; blob: string };
    } }).extensions['https://extensions.example/fix9'];
    assert.equal(childExtension.blob, 'x'.repeat(2_400));
    assert.equal(typeof childExtension.index, 'number');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from nodes
      where id=any($1::text[]) and deleted_at is not null`, [seeded.memberIds])).rows[0].count,
    seeded.memberIds.length);
    const effect = (await isolated.runtime.pool.query(`select effect_json from sync_operation_effects
      where operation_id=$1`, [request.operations[0]!.opId])).rows[0]?.effect_json as {
      kind?: string; memberCount?: number; memberDigest?: string;
    };
    assert.equal(effect.kind, 'subtree_deleted');
    assert.equal(effect.memberCount, seeded.memberIds.length);
    assert.equal(typeof effect.memberDigest, 'string');
  }, 30_000);

  test('FIX-M-009 rolls back a tombstone-phase fault atomically and recovers on retry', async () => {
    const seeded = await seedBulkSubtree(8, 64);
    const value = await context();
    const faulting = createPostgresSyncPushApplication(isolated.runtime.db, value.issuer, {
      faultInjector: { async afterPhase(phase) {
        if (phase === 'tombstone') throw new Error('FIX-M-009 simulated tombstone fault');
      } },
    });
    const faultServer = await start(value, { application: faulting });
    const request = syncNodeDeletePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: seeded.rootId, baseRevision: seeded.rootRevision,
      opId: `fix9-fault-${randomUUID()}`, subtree: true, source: await observeSubtree(isolated.runtime.db, seeded.rootId),
    });
    const idempotencyKey = `fix9-fault-key-${randomUUID()}`;
    const denied = await client(faultServer.origin).push({ idempotencyKey, request });
    assert.equal(denied.status, 500);
    assert.equal(problem(denied.body).code, 'internal_error');
    assert.deepEqual((await isolated.runtime.pool.query(`select count(*)::int count from nodes
      where id=any($1::text[]) and deleted_at is null`, [seeded.memberIds])).rows[0],
    { count: seeded.memberIds.length });
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from sync_node_tombstones
      where operation_id=$1`, [request.operations[0]!.opId])).rows[0].count, 0);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from operations
      where operation_id=$1`, [request.operations[0]!.opId])).rows[0].count, 0);
    await faultServer.app.close();
    const recovered = await start(value);
    const retried = await client(recovered.origin).push({ idempotencyKey, request });
    assert.equal(retried.status, 200);
    assert.equal((retried.body as SyncPushResult).results[0]!.status, 'applied');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from sync_node_tombstones
      where operation_id=$1`, [request.operations[0]!.opId])).rows[0].count, seeded.memberIds.length);
  }, 30_000);
});

function testManifest(origin: string): Manifest {
  return {
    protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
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
