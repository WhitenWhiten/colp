import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, SyncAckResult, SyncSessionRequest } from '@know-n/colp/types';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { materializeCollectionPayload, materializeNodePayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION } from '../../../src/modules/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresReplicaStore, createPostgresSyncAckApplication,
  createPostgresSyncPullReadPort, createPostgresSyncPushApplication,
  createPostgresSyncSessionHttpApplication, createPostgresSyncSessionIssuer,
  createSyncPullCursorKeyring } from '../../../src/infrastructure/sync/index.js';
import { registerSyncAckRoutes } from '../../../src/transport/colp-sync/sync-ack-routes.js';
import { registerSyncPullRoutes } from '../../../src/transport/colp-sync/sync-pull-routes.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { registerSyncSessionRoutes } from '../../../src/transport/colp-sync/sync-session-routes.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { syncPushAdmissionRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-22-BLACK-BOX-SECRET';
const ACCOUNT = 'EhISEhISEhISEhISEhISEg';
const SUBJECT = 'ack-http-subject';
const COLLECTION = 'dHR0dHR0dHR0dHR0dHR0dA';

describeWithPostgres('P3-22 Manifest black-box Ack acceptance', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_ack_http', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date('2026-07-26T11:00:00.000Z');
    const collectionPayload = materializeCollectionPayload({ id: COLLECTION, ownerSubjectId: SUBJECT,
      title: 'Ack HTTP', summary: null, kind: 'bookmarks', visibility: 'private', rootNodeId: 'ack-http-root',
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null });
    const rootPayload = materializeNodePayload({ id: 'ack-http-root', collectionId: COLLECTION, parentId: null,
      kind: 'folder', isRoot: true, title: 'Root', url: null, description: null, tags: [], visibility: 'inherit',
      positionToken: null, resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now,
      updatedAt: now, deletedAt: null, deletedCommitOrdinal: null });
    const nodePayload = materializeNodePayload({ id: 'push-node-1', collectionId: COLLECTION,
      parentId: 'ack-http-root', kind: 'folder', isRoot: false, title: 'Before', url: null, description: null,
      tags: [], visibility: 'inherit', positionToken: 'A', resourceRevision: 'push-node-r1',
      childrenRevision: 'node-children-r1', createdAt: now, updatedAt: now, deletedAt: null,
      deletedCommitOrdinal: null });
    assert.equal(collectionPayload.ok && rootPayload.ok && nodePayload.ok, true);
    await isolated.runtime.db.transaction().execute(async (transaction) => {
    await transaction.insertInto('accounts').values({ id: ACCOUNT, subject_id: SUBJECT,
      status: 'active', security_epoch: 0n }).execute();
    await transaction.insertInto('profiles').values({ account_id: ACCOUNT,
      display_name: 'Ack HTTP owner' }).execute();
    await transaction.insertInto('account_identities').values({ id: 'ack-http-identity',
      account_id: ACCOUNT, issuer: ISSUER, subject: 'ack-http-oidc' }).execute();
    await transaction.insertInto('profile_handles').values({ handle: 'sync_ack_http',
      account_id: ACCOUNT }).execute();
    await transaction.insertInto('resource_id_ledger').values([
      { resource_id: COLLECTION, resource_type: 'collection' },
      { resource_id: 'ack-http-root', resource_type: 'node' },
      { resource_id: 'push-node-1', resource_type: 'node' },
    ]).execute();
    await transaction.insertInto('collections').values({ id: COLLECTION, owner_subject_id: SUBJECT,
      title: 'Ack HTTP', kind: 'bookmarks', root_node_id: 'ack-http-root', resource_revision: 'collection-r1',
      content_revision: 'content-r1', policy_revision: 'policy-r1', visibility: 'private', commit_ordinal: 0n,
      created_at: now, updated_at: now, deleted_at: null,
      payload_json: collectionPayload.ok ? collectionPayload.payload : {},
      payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }).execute();
    await transaction.insertInto('nodes').values([{ id: 'ack-http-root', collection_id: COLLECTION,
      parent_id: null, kind: 'folder', is_root: true, title: 'Root', url: null, position_token: null,
      resource_revision: 'root-r1', children_revision: 'children-r1', deleted_at: null, visibility: 'inherit',
      created_at: now, updated_at: now, payload_json: rootPayload.ok ? rootPayload.payload : {},
      payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' },
    { id: 'push-node-1', collection_id: COLLECTION, parent_id: 'ack-http-root', kind: 'folder', is_root: false,
      title: 'Before', url: null, position_token: 'A', resource_revision: 'push-node-r1',
      children_revision: 'node-children-r1', deleted_at: null, visibility: 'inherit', created_at: now,
      updated_at: now, payload_json: nodePayload.ok ? nodePayload.payload : {},
      payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }]).execute();
    await transaction.insertInto('sync_node_revision_history').values({ collection_id: COLLECTION,
      resource_id: 'push-node-1', revision: 'push-node-r1', kind: 'folder',
      payload_json: nodePayload.ok ? nodePayload.payload : {}, commit_ordinal: 0n, operation_id: null }).execute();
    });
  }, 20_000);
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => { try { await app.close(); } catch {} })));
  afterAll(async () => isolated?.close());

  test('discovers Push/Pull/Ack, pushes a real event, acks, replays after restart and validates schema', async () => {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({ issuer: ISSUER, audience: 'known-api',
      clientId: 'known-extension', subject: 'ack-http-oidc', credentialId: `ack-http-credential-${suffix}` });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `ack-http-device-${suffix}`, replicaId: () => `ack-http-replica-${suffix}`,
      leaseId: () => `ack-http-lease-${suffix}` } }).create({ accountId: ACCOUNT, collectionId: COLLECTION,
      deviceName: 'Ack HTTP device', replicaName: 'Ack HTTP replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities: { read: true, write: true,
        events: true, separator: true, alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `ack-http-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `ack-http-generation-${suffix}` }, leaseDurationSeconds: 3_600 },
    { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, { issuer: ISSUER, audience: 'known-api',
      clientId: 'known-extension', replayEncryptionKey: Buffer.alloc(32, 71), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600, tombstoneRetentionSeconds: 86_400,
      maxBatchOperations: 1, endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] });
    const keyring = createSyncPullCursorKeyring({ active: { id: 'ack-http-pull-key',
      secret: Buffer.alloc(32, 72).toString('base64') }, retained: [], ttlMs: 300_000 });
    const verifier = { async verify({ authorization }: { readonly authorization: string | readonly string[] | undefined }) {
      if (authorization !== AUTHORIZATION) throw new Error('denied'); return credential;
    } };
    const start = async () => {
      const app = Fastify({ logger: false });
      registerSyncSessionRoutes(app, { path: '/runtime/session', allowedOrigins: [ORIGIN], credentialVerifier: verifier,
        application: createPostgresSyncSessionHttpApplication(isolated.runtime.db, issuer),
        rateLimit: { maxRequests: 100, windowMs: 60_000 }, allowInsecureLoopback: true });
      registerSyncPushRoutes(app, { path: '/runtime/push', allowedOrigins: [ORIGIN], credentialVerifier: verifier,
        application: createPostgresSyncPushApplication(isolated.runtime.db, issuer),
        rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1, allowInsecureLoopback: true });
      registerSyncPullRoutes(app, { path: '/runtime/pull', allowedOrigins: [ORIGIN], credentialVerifier: verifier,
        reader: createPostgresSyncPullReadPort(isolated.runtime.db, keyring),
        rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 100, responseBudgetBytes: 131_072,
        requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 30, allowInsecureLoopback: true });
      registerSyncAckRoutes(app, { path: '/runtime/ack', allowedOrigins: [ORIGIN], credentialVerifier: verifier,
        application: createPostgresSyncAckApplication(isolated.runtime.db,
          { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 }),
        rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBodyBytes: 16_384, maxWarnings: 8,
        maxWarningBytes: 2_048, allowInsecureLoopback: true });
      app.get('/.well-known/collection-protocol', async () => manifest(app));
      await app.listen({ host: '127.0.0.1', port: 0 }); apps.push(app);
      const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
      return { app, origin: `http://127.0.0.1:${address.port}` };
    };
    const firstServer = await start();
    const client = createSyncSessionBlackBoxClient({ manifestUrl: `${firstServer.origin}/.well-known/collection-protocol`,
      mountId: 'root', authorization: AUTHORIZATION, origin: ORIGIN });
    const negotiated = await client.create({ idempotencyKey: `ack-http-session-${suffix}`,
      request: sessionRequest(replica) });
    const pushRequest = syncPushAdmissionRequest({ sessionId: negotiated.body.sessionId,
      replicaId: replica.replicaId, collectionId: COLLECTION, opId: `ack-http-op-${suffix}`,
      sequence: 1, batchId: `${negotiated.body.sessionId}.ack-batch-${suffix}` });
    assert.equal((await client.push({ idempotencyKey: `ack-http-push-${suffix}`, request: pushRequest })).status, 200);
    const initialCursor = keyring.sign({ replicaId: replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: negotiated.body.replicaLease.generation, sessionId: negotiated.body.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 100,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' } });
    const pulled = await client.pull({ sessionId: negotiated.body.sessionId, cursor: initialCursor, limit: 100 });
    assert.equal(pulled.events.some((event) => event.kind === 'operation'
      && event.operation?.opId === `ack-http-op-${suffix}`), true);
    const first = await client.ack({ idempotencyKey: `ack-http-ack-${suffix}`,
      request: { sessionId: negotiated.body.sessionId, cursor: pulled.nextCursor, warnings: [] } });
    assert.equal(first.status, 200); assert.equal(createValidatorRegistry().validate('syncAckResult', first.body).valid, true);
    await firstServer.app.close();
    const restarted = await start();
    const replayClient = createSyncSessionBlackBoxClient({ manifestUrl: `${restarted.origin}/.well-known/collection-protocol`,
      mountId: 'root', authorization: AUTHORIZATION, origin: ORIGIN });
    const replay = await replayClient.ack({ idempotencyKey: `ack-http-ack-${suffix}`,
      request: { sessionId: negotiated.body.sessionId, cursor: pulled.nextCursor, warnings: [] } });
    assert.deepEqual(replay.body, first.body);
    assert.equal((replay.body as SyncAckResult).ackedCursor, pulled.nextCursor);
  }, 20_000);

  // Concurrent Push advances Collection content_revision against the same
  // Pull cursor digest. Evidence reuse must 200/503, never integrity 500.
  test.each(Array.from({ length: 8 }, (_, index) => index))('overlapping Pull and Push never return HTTP 500 (%i)', async () => {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({ issuer: ISSUER, audience: 'known-api',
      clientId: 'known-extension', subject: 'ack-http-oidc', credentialId: `ack-http-race-${suffix}` });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `ack-http-race-device-${suffix}`, replicaId: () => `ack-http-race-replica-${suffix}`,
      leaseId: () => `ack-http-race-lease-${suffix}` } }).create({ accountId: ACCOUNT, collectionId: COLLECTION,
      deviceName: 'Ack HTTP race device', replicaName: 'Ack HTTP race replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities: { read: true, write: true,
        events: true, separator: true, alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `ack-http-race-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `ack-http-race-generation-${suffix}` }, leaseDurationSeconds: 3_600 },
    { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, { issuer: ISSUER, audience: 'known-api',
      clientId: 'known-extension', replayEncryptionKey: Buffer.alloc(32, 71), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600, tombstoneRetentionSeconds: 86_400,
      maxBatchOperations: 1, endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] });
    const keyring = createSyncPullCursorKeyring({ active: { id: 'ack-http-race-pull-key',
      secret: Buffer.alloc(32, 73).toString('base64') }, retained: [], ttlMs: 300_000 });
    const verifier = { async verify({ authorization }: { readonly authorization: string | readonly string[] | undefined }) {
      if (authorization !== AUTHORIZATION) throw new Error('denied'); return credential;
    } };
    const app = Fastify({ logger: false });
    registerSyncSessionRoutes(app, { path: '/runtime/session', allowedOrigins: [ORIGIN], credentialVerifier: verifier,
      application: createPostgresSyncSessionHttpApplication(isolated.runtime.db, issuer),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, allowInsecureLoopback: true });
    registerSyncPushRoutes(app, { path: '/runtime/push', allowedOrigins: [ORIGIN], credentialVerifier: verifier,
      application: createPostgresSyncPushApplication(isolated.runtime.db, issuer),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1, allowInsecureLoopback: true });
    const pullFailures: string[] = [];
    const reader = createPostgresSyncPullReadPort(isolated.runtime.db, keyring);
    registerSyncPullRoutes(app, { path: '/runtime/pull', allowedOrigins: [ORIGIN], credentialVerifier: verifier,
      reader: { ...reader, async read(input) {
        try { return await reader.read(input); }
        catch (error) { pullFailures.push(error instanceof Error ? `${error.name}: ${error.message} ${error.stack}` : String(error)); throw error; }
      } },
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 100, responseBudgetBytes: 131_072,
      requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 30, allowInsecureLoopback: true });
    app.get('/.well-known/collection-protocol', async () => manifest(app));
    await app.listen({ host: '127.0.0.1', port: 0 }); apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const origin = `http://127.0.0.1:${address.port}`;
    const client = createSyncSessionBlackBoxClient({
      manifestUrl: `${origin}/.well-known/collection-protocol`,
      mountId: 'root', authorization: AUTHORIZATION, origin: ORIGIN,
    });
    const negotiated = await client.create({ idempotencyKey: `ack-http-race-session-${suffix}`,
      request: sessionRequest(replica) });
    const requestCursor = keyring.sign({ replicaId: replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: negotiated.body.replicaLease.generation, sessionId: negotiated.body.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 100,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' } });
    const pullUrl = `${origin}/runtime/pull?sessionId=${encodeURIComponent(negotiated.body.sessionId)}`
      + `&cursor=${encodeURIComponent(requestCursor)}&limit=100`;
    const pullHeaders = { Accept: 'application/json', Authorization: AUTHORIZATION, Origin: ORIGIN };
    const pushRequest = syncPushAdmissionRequest({ sessionId: negotiated.body.sessionId,
      replicaId: replica.replicaId, collectionId: COLLECTION, opId: `ack-http-race-op-${suffix}`,
      sequence: 1, batchId: `${negotiated.body.sessionId}.ack-race-batch-${suffix}` });
    const [pushResponse, firstPull, secondPull] = await Promise.all([
      client.push({ idempotencyKey: `ack-http-race-push-${suffix}`, request: pushRequest }),
      fetch(pullUrl, { headers: pullHeaders }),
      fetch(pullUrl, { headers: pullHeaders }),
    ]);
    assert.equal(pushResponse.status, 200);
    assert.notEqual(firstPull.status, 500, `${await firstPull.clone().text()} ${pullFailures.join('\n')}`);
    assert.notEqual(secondPull.status, 500, `${await secondPull.clone().text()} ${pullFailures.join('\n')}`);
    assert.ok(firstPull.status === 200 || firstPull.status === 503);
    assert.ok(secondPull.status === 200 || secondPull.status === 503);
  }, 20_000);
});

function manifest(app: FastifyInstance): Manifest {
  const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
  const origin = `http://127.0.0.1:${address.port}`;
  return { protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f9d33-2211-7111-8111-222222222222', title: 'Known',
    mounts: [{ id: 'root', baseUrl: `${origin}/`, profiles: ['core'],
      endpoints: { directory: `${origin}/directory`, collection: `${origin}/collections/{collectionId}`,
        snapshot: `${origin}/collections/{collectionId}/snapshot`, syncPush: `${origin}/runtime/push`,
        syncPull: `${origin}/runtime/pull`, syncAck: `${origin}/runtime/ack`,
        syncSessions: `${origin}/runtime/session` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }] } as Manifest;
}

function sessionRequest(replica: { readonly replicaId: string; readonly binding: {
  readonly browserProfileId: string; readonly browserGeneration: string } }): SyncSessionRequest {
  return { protocolVersion: '0.1', scope: 'collection', clientTime: '2026-07-26T12:00:00.000Z',
    replica: { replicaId: replica.replicaId, name: 'Ack Chrome', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities: { read: true, write: true,
        events: true, separator: true, alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: replica.binding.browserProfileId, mountMode: 'whole-profile',
        mountNativeId: 'ack-http-native-root', generation: replica.binding.browserGeneration }, extensions: {} },
    collection: { collectionId: COLLECTION, lastCursor: null, lastRevision: null, bootstrapMode: 'download' } };
}
