import { truncateFixtureTables } from '../../support/postgres-test-runtime.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPushResult } from '@know-n/colp/types';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { createUnitOfWork, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresProductSyncCenterUnitOfWork,
  createPostgresReplicaLifecycleService,
  createPostgresReplicaStore,
  createPostgresSyncConflictKeyringReadiness,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
  reencryptOpenSyncConflicts,
  type SyncConflictPayloadKeyring,
} from '../../../src/infrastructure/sync/index.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PRODUCT_ORIGIN = 'https://app.example.test';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ISSUER = 'https://issuer.example/realms/known';
const AUTHORIZATION = 'Bearer P3-36-EXTENSION-AUTHORIZATION-MARKER';
const CONFLICT_KEY = Buffer.alloc(32, 71);
const CONFLICT_KEY_V1 = Buffer.alloc(32, 11);
const CONFLICT_KEY_V2 = Buffer.alloc(32, 22);
const ACTIVE_V7_KEYRING: SyncConflictPayloadKeyring = Object.freeze({
  active: { key: CONFLICT_KEY, keyVersion: 7 },
  retained: [],
});

interface ProductClient { readonly cookie: string; readonly csrf: string; readonly accountId: string;
  readonly subjectId: string; readonly identitySubject: string }

describeWithPostgres('P3-36 real Product Sync Center HTTP/PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  const syncApps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_product_sync_center', { maxConnections: 16 });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN, ALLOWED_ORIGINS: PRODUCT_ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${PRODUCT_ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'p3-36-editor-cursor-secret', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(syncApps.map((app) => app.close()));
    await isolated?.close();
  });

  function productApp(keyring: SyncConflictPayloadKeyring = ACTIVE_V7_KEYRING) {
    const identity = createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    return buildApiApp({
      config, identityUnitOfWork: identity,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      productSyncCenterUnitOfWork: createPostgresProductSyncCenterUnitOfWork(runtime.db, {
        cursorSecret: 'p3-36-product-sync-conflict-cursor-secret',
        conflictPayloadKeyring: keyring,
      }),
      browserSessionAuthority: factory.authority,
    });
  }

  async function login(subject: string): Promise<ProductClient> {
    const client = await issueTestSession({
      factory,
      subject: subject,
      displayName: subject,
      handle: `sync_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    // Sync credential identity: the extension Sync flow resolves the account
    // through account_identities(issuer, subject) — the legacy OIDC login
    // established this row; the E1-migrated factory mints the session without
    // it, so the fixture restores the Sync credential mapping explicitly.
    await runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
      [`p3-36-identity-${randomUUID()}`, client.accountId, EXTENSION_ISSUER, subject],
    );
    return { cookie: client.cookie, csrf: client.csrfToken,
      accountId: client.accountId, subjectId: client.subjectId, identitySubject: subject };
  }

  function mutation(client: ProductClient, commandId: string, contentType?: string) {
    return { cookie: client.cookie, origin: PRODUCT_ORIGIN, 'x-csrf-token': client.csrf,
      'known-command-id': commandId, ...(contentType ? { 'content-type': contentType } : {}) };
  }

  async function createCollectionAndNode(api: ReturnType<typeof productApp>, owner: ProductClient, label: string) {
    const collectionResponse = await api.inject({ method: 'POST', url: '/api/v1/collections',
      headers: mutation(owner, randomUUID(), 'application/json'),
      payload: { kind: 'knowledge_collection', title: label, summary: null } });
    assert.equal(collectionResponse.statusCode, 201, collectionResponse.body);
    const collection = collectionResponse.json() as { collection: { id: string }; root: { id: string } };
    const node = await createNode(api, owner, collection.collection.id, collection.root.id, label);
    return { collectionId: collection.collection.id, rootId: collection.root.id, node };
  }

  async function createNode(api: ReturnType<typeof productApp>, owner: ProductClient,
    collectionId: string, rootId: string, label: string) {
    const nodeResponse = await api.inject({ method: 'POST', url: `/api/v1/collections/${collectionId}/nodes`,
      headers: mutation(owner, randomUUID(), 'application/json'),
      payload: { parentId: rootId, afterId: null, beforeId: null,
        node: { kind: 'bookmark', title: `${label} base`, url: 'https://example.test/redacted-marker',
          description: null, tags: [], visibility: 'inherit' } } });
    assert.equal(nodeResponse.statusCode, 201, nodeResponse.body);
    return (nodeResponse.json() as { node: { id: string; revision: string; etag: string } }).node;
  }

  async function syncContext(owner: ProductClient, collectionId: string, label: string) {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension', subject: owner.identitySubject,
      credentialId: `p3-36-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(runtime.db, { ids: {
      deviceId: () => `p3-36-device-${suffix}`, replicaId: () => `p3-36-replica-${suffix}`,
      leaseId: () => `p3-36-lease-${suffix}`,
    } }).create({
      accountId: owner.accountId, collectionId, deviceName: `${label} device`, replicaName: `${label} replica`,
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `p3-36-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `p3-36-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: owner.accountId });
    const issuer = createPostgresSyncSessionIssuer(runtime.db, {
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 36), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `p3-36-session-${suffix}`, requestFingerprint: `p3-36-fingerprint-${suffix}`,
      collectionId, replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push', 'sync:pull'], origin: EXTENSION_ORIGIN,
    });
    const currentFence = await runtime.pool.query<{ lease_generation: string; lifecycle_revision: string }>(
      'select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1',
      [replica.replicaId],
    );
    return { credential, replica: { ...replica,
      leaseGeneration: currentFence.rows[0]!.lease_generation,
      lifecycleRevision: currentFence.rows[0]!.lifecycle_revision,
    }, issuer, session: issued.session, collectionId };
  }

  async function startPush(value: Awaited<ReturnType<typeof syncContext>>,
    conflictPayloadEncryption: { readonly key: Buffer; readonly keyVersion: number } = { key: CONFLICT_KEY, keyVersion: 7 }) {
    const app = Fastify({ logger: false });
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-update', allowedOrigins: [EXTENSION_ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(runtime.db, value.issuer, {
        conflictPayloadEncryption,
      }),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1,
      allowInsecureLoopback: true,
    });
    app.get('/.well-known/collection-protocol', async () => manifest(app));
    await app.listen({ host: '127.0.0.1', port: 0 });
    syncApps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Sync test server did not listen');
    return createSyncSessionBlackBoxClient({
      manifestUrl: `http://127.0.0.1:${address.port}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: AUTHORIZATION, origin: EXTENSION_ORIGIN,
    });
  }

  test('isolates accounts and drives real Push Conflict resolution plus Replica retirement through Product HTTP', async () => {
    const api = productApp();
    try {
      const owner = await login(`p3-36-owner-${randomUUID()}`);
      const outsider = await login(`p3-36-outsider-${randomUUID()}`);
      const empty = await login(`p3-36-empty-${randomUUID()}`);
      const owned = await createCollectionAndNode(api, owner, 'Owned sync');
      const other = await createCollectionAndNode(api, outsider, 'Other sync');
      const secondNode = await createNode(api, owner, owned.collectionId, owned.rootId, 'Second sync');
      const patched = await api.inject({ method: 'PATCH',
        url: `/api/v1/collections/${owned.collectionId}/nodes/${owned.node.id}`,
        headers: { ...mutation(owner, randomUUID(), 'application/merge-patch+json'), 'if-match': owned.node.etag },
        payload: { title: 'Server title' } });
      assert.equal(patched.statusCode, 200, patched.body);
      const secondPatched = await api.inject({ method: 'PATCH',
        url: `/api/v1/collections/${owned.collectionId}/nodes/${secondNode.id}`,
        headers: { ...mutation(owner, randomUUID(), 'application/merge-patch+json'), 'if-match': secondNode.etag },
        payload: { title: 'Second server title' } });
      assert.equal(secondPatched.statusCode, 200, secondPatched.body);
      const ownerSync = await syncContext(owner, owned.collectionId, 'Owner');
      const expiredSync = await syncContext(owner, owned.collectionId, 'Expired');
      const recoverySync = await syncContext(owner, owned.collectionId, 'Recovery');
      const outsiderSync = await syncContext(outsider, other.collectionId, 'Outsider');
      assert.equal(new Set([ownerSync.replica.replicaId, expiredSync.replica.replicaId,
        recoverySync.replica.replicaId, outsiderSync.replica.replicaId]).size, 4);
      const lifecycle = createPostgresReplicaLifecycleService(runtime.db);
      await runtime.pool.query('update sync_replicas set lease_expires_at=current_timestamp where replica_id=$1',
        [expiredSync.replica.replicaId]);
      assert.ok((await lifecycle.expireDue({ limit: 10 })).expiredReplicaIds.includes(expiredSync.replica.replicaId));
      assert.equal((await lifecycle.requireRecovery({ scope: { accountId: owner.accountId,
        collectionId: owned.collectionId, replicaId: recoverySync.replica.replicaId,
        expectedLeaseGeneration: recoverySync.replica.leaseGeneration,
        expectedLifecycleRevision: recoverySync.replica.lifecycleRevision } })).state, 'committed');
      const constructedStates = await runtime.pool.query<{ replica_id: string; status: string }>(
        'select replica_id,status from sync_replicas where replica_id=any($1::text[])',
        [[ownerSync.replica.replicaId, expiredSync.replica.replicaId, recoverySync.replica.replicaId]],
      );
      assert.deepEqual(new Map(constructedStates.rows.map((row) => [row.replica_id, row.status])), new Map([
        [ownerSync.replica.replicaId, 'active'], [expiredSync.replica.replicaId, 'expired'],
        [recoverySync.replica.replicaId, 'recovery_required'],
      ]));

      const pushClient = await startPush(ownerSync);
      const push = await pushClient.push({ idempotencyKey: `p3-36-push-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({ sessionId: ownerSync.session.sessionId,
          replicaId: ownerSync.replica.replicaId, collectionId: owned.collectionId,
          targetId: owned.node.id, baseRevision: owned.node.revision, opId: `p3-36-conflict-${randomUUID()}`,
          base: { title: 'Owned sync base' }, value: { title: 'Incoming title' } }) });
      assert.equal(push.status, 200, JSON.stringify(push.body));
      const pushBody = syncResult(push.body);
      assert.equal(pushBody.results[0]?.status, 'conflicted');
      const conflictId = pushBody.results[0]!.conflictId!;

      const secondPush = await pushClient.push({ idempotencyKey: `p3-36-push-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({ sessionId: ownerSync.session.sessionId,
          replicaId: ownerSync.replica.replicaId, collectionId: owned.collectionId, sequence: 2,
          targetId: secondNode.id, baseRevision: secondNode.revision, opId: `p3-36-conflict-${randomUUID()}`,
          base: { title: 'Second sync base' }, value: { title: 'Second incoming title' } }) });
      assert.equal(secondPush.status, 200, JSON.stringify(secondPush.body));
      const secondConflictId = syncResult(secondPush.body).results[0]!.conflictId!;
      assert.equal(syncResult(secondPush.body).results[0]?.status, 'conflicted');

      const ownerStatus = await api.inject({ method: 'GET', url: '/api/v1/sync/status', headers: { cookie: owner.cookie } });
      const outsiderStatus = await api.inject({ method: 'GET', url: '/api/v1/sync/status', headers: { cookie: outsider.cookie } });
      const emptyStatus = await api.inject({ method: 'GET', url: '/api/v1/sync/status', headers: { cookie: empty.cookie } });
      assert.equal(ownerStatus.statusCode, 200, ownerStatus.body);
      assert.equal(outsiderStatus.statusCode, 200, outsiderStatus.body);
      assert.equal(emptyStatus.statusCode, 200, emptyStatus.body);
      assert.deepEqual(emptyStatus.json(), { devices: [], replicas: [] });
      assert.deepEqual(new Map((ownerStatus.json() as { replicas: Array<{ id: string; status: string }> }).replicas
        .map((row) => [row.id, row.status])), new Map([
        [ownerSync.replica.replicaId, 'active'], [expiredSync.replica.replicaId, 'expired'],
        [recoverySync.replica.replicaId, 'recovery_required'],
      ]));
      assert.deepEqual((outsiderStatus.json() as { replicas: Array<{ id: string }> }).replicas.map((row) => row.id),
        [outsiderSync.replica.replicaId]);
      const ownerConflicts = await api.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=1',
        headers: { cookie: owner.cookie } });
      const outsiderConflicts = await api.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=1',
        headers: { cookie: outsider.cookie } });
      assert.equal(ownerConflicts.statusCode, 200, ownerConflicts.body);
      const firstPage = ownerConflicts.json() as { items: Array<{ id: string; summary: { current: string | null; incoming: string | null } }>; page: { nextCursor: string | null } };
      assert.equal(firstPage.items.length, 1);
      assert.deepEqual(firstPage.items[0]?.summary, { current: 'Second server title', incoming: 'Second incoming title' });
      assert.ok(firstPage.page.nextCursor);
      const secondPageResponse = await api.inject({ method: 'GET',
        url: `/api/v1/sync/conflicts?cursor=${encodeURIComponent(firstPage.page.nextCursor)}`,
        headers: { cookie: owner.cookie } });
      assert.equal(secondPageResponse.statusCode, 200, secondPageResponse.body);
      const secondPage = secondPageResponse.json() as { items: Array<{ id: string; summary: { current: string | null; incoming: string | null } }>; page: { nextCursor: string | null } };
      assert.deepEqual(secondPage.items[0]?.summary, { current: 'Server title', incoming: 'Incoming title' });
      assert.deepEqual(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)),
        new Set([conflictId, secondConflictId]));
      assert.equal(secondPage.page.nextCursor, null);
      const tampered = await api.inject({ method: 'GET',
        url: `/api/v1/sync/conflicts?cursor=${encodeURIComponent(`${firstPage.page.nextCursor}x`)}`,
        headers: { cookie: owner.cookie } });
      assert.equal(tampered.statusCode, 400, tampered.body);
      assert.equal(tampered.json().error.code, 'invalid_cursor');
      const crossPrincipal = await api.inject({ method: 'GET',
        url: `/api/v1/sync/conflicts?cursor=${encodeURIComponent(firstPage.page.nextCursor)}`,
        headers: { cookie: outsider.cookie } });
      assert.equal(crossPrincipal.statusCode, 400, crossPrincipal.body);
      assert.equal(crossPrincipal.json().error.code, 'invalid_cursor');
      assert.deepEqual((outsiderConflicts.json() as { items: unknown[] }).items, []);
      assert.equal(ownerConflicts.body.includes('https://example.test/redacted-marker'), false);

      const beforeResolve = await counts(owned.collectionId, ownerSync.replica.replicaId, conflictId);
      const resolutionCommand = randomUUID();
      const resolutionRequest = { method: 'POST' as const,
        url: `/api/v1/sync/conflicts/${conflictId}/resolution`,
        headers: { ...mutation(owner, resolutionCommand, 'application/json'), 'if-match': '"conflict-r1"' },
        payload: { resolution: 'incoming' } };
      const resolved = await api.inject(resolutionRequest);
      assert.equal(resolved.statusCode, 200, resolved.body);
      const replay = await api.inject(resolutionRequest);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.body, resolved.body);
      assert.equal(replay.headers.etag, resolved.headers.etag);
      assert.deepEqual(await counts(owned.collectionId, ownerSync.replica.replicaId, conflictId),
        incrementResolution(beforeResolve));
      const reused = await api.inject({ ...resolutionRequest, payload: { resolution: 'server' } });
      assert.equal(reused.statusCode, 409, reused.body);
      assert.equal(reused.json().error.code, 'command_id_reused');
      // FIX-M-011 (SYNC-R06): the versioned keyring readiness view is global
      // (keys are shared across accounts), so close this second Conflict before
      // the rotation test asserts on referenced key versions in this schema.
      const secondResolution = { method: 'POST' as const,
        url: `/api/v1/sync/conflicts/${secondConflictId}/resolution`,
        headers: { ...mutation(owner, randomUUID(), 'application/json'), 'if-match': '"conflict-r1"' },
        payload: { resolution: 'incoming' } };
      const secondResolved = await api.inject(secondResolution);
      assert.equal(secondResolved.statusCode, 200, secondResolved.body);

      const retirementCommand = randomUUID();
      const retirementRequest = { method: 'DELETE' as const,
        url: `/api/v1/sync/replicas/${ownerSync.replica.replicaId}`,
        headers: { ...mutation(owner, retirementCommand), 'if-match': `"${ownerSync.replica.lifecycleRevision}"` } };
      const beforeRetire = await retirementCounts(ownerSync.replica.replicaId);
      let release!: () => void; let responseReady!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { responseReady = resolve; });
      const lossyApi = productApp();
      lossyApi.addHook('onSend', async (request, _reply, payload) => {
        if (request.url === retirementRequest.url) { responseReady(); await gate; }
        return payload;
      });
      const lossyOrigin = await lossyApi.listen({ host: '127.0.0.1', port: 0 });
      const abort = new AbortController();
      const unknown = fetch(`${lossyOrigin}${retirementRequest.url}`, {
        method: 'DELETE', headers: retirementRequest.headers, signal: abort.signal,
      });
      await ready; abort.abort(); release();
      await assert.rejects(unknown, /abort/iu);
      await lossyApi.close();
      const retired = await api.inject(retirementRequest);
      assert.equal(retired.statusCode, 200, retired.body);
      const retiredReplay = await api.inject(retirementRequest);
      assert.equal(retiredReplay.statusCode, 200, retiredReplay.body);
      assert.equal(retiredReplay.body, retired.body);
      const retiredReuse = await api.inject({ ...retirementRequest,
        headers: { ...retirementRequest.headers, 'if-match': '"999"' } });
      assert.equal(retiredReuse.statusCode, 409, retiredReuse.body);
      assert.equal(retiredReuse.json().error.code, 'command_id_reused');
      assert.deepEqual(await retirementCounts(ownerSync.replica.replicaId), {
        lifecycleRevision: String(BigInt(beforeRetire.lifecycleRevision) + 1n),
        audits: beforeRetire.audits + 1, productReceipts: beforeRetire.productReceipts + 1,
        activeSessions: 0,
      });
      const retiredFacts = await runtime.pool.query(`select replica.status,replica.retired_at,
        count(session.session_id)::int session_count,
        count(session.session_id) filter (where session.status='active')::int active_sessions
        from sync_replicas replica left join sync_sessions session on session.replica_id=replica.replica_id
        where replica.replica_id=$1 group by replica.replica_id`, [ownerSync.replica.replicaId]);
      assert.equal(retiredFacts.rows[0].status, 'retired');
      assert.ok(retiredFacts.rows[0].retired_at instanceof Date);
      assert.equal(retiredFacts.rows[0].active_sessions, 0);
      assert.equal(retiredFacts.rows[0].session_count, 1);
      const statusAfterRetire = await api.inject({ method: 'GET', url: '/api/v1/sync/status',
        headers: { cookie: owner.cookie } });
      assert.equal(statusAfterRetire.statusCode, 200, statusAfterRetire.body);
      const retiredView = (statusAfterRetire.json() as { replicas: Array<{ id: string; status: string }> }).replicas
        .find((replica) => replica.id === ownerSync.replica.replicaId);
      assert.equal(retiredView?.status, 'retired');
    } finally { await api.close(); }
  }, 120_000);

  test('rotates conflict keys with a retained decryption keyring, gates readiness, and drains by re-encryption', async () => {
    await truncateFixtureTables(runtime.pool, 'truncate table sync_conflicts cascade');
    const keyringV1: SyncConflictPayloadKeyring = { active: { key: CONFLICT_KEY_V1, keyVersion: 1 }, retained: [] };
    const keyringV2: SyncConflictPayloadKeyring = {
      active: { key: CONFLICT_KEY_V2, keyVersion: 2 },
      retained: [{ key: CONFLICT_KEY_V1, keyVersion: 1 }],
    };
    const apiV1 = productApp(keyringV1);
    try {
      const owner = await login(`p3-36-rot-owner-${randomUUID()}`);
      const owned = await createCollectionAndNode(apiV1, owner, 'Rotated sync');
      const secondNode = await createNode(apiV1, owner, owned.collectionId, owned.rootId, 'Rotated second');
      const thirdNode = await createNode(apiV1, owner, owned.collectionId, owned.rootId, 'Rotated third');
      const ownerSync = await syncContext(owner, owned.collectionId, 'Rotated');
      const v1Push = await startPush(ownerSync, { key: CONFLICT_KEY_V1, keyVersion: 1 });
      const pushA = await v1Push.push({ idempotencyKey: `p3-36-rot-a-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({ sessionId: ownerSync.session.sessionId,
          replicaId: ownerSync.replica.replicaId, collectionId: owned.collectionId,
          targetId: owned.node.id, baseRevision: owned.node.revision, opId: `p3-36-rot-a-${randomUUID()}`,
          base: { title: 'Rotated base A' }, value: { title: 'Rotated incoming A' } }) });
      assert.equal(pushA.status, 200, JSON.stringify(pushA.body));
      const conflictA = syncResult(pushA.body).results[0]!.conflictId!;
      const pushB = await v1Push.push({ idempotencyKey: `p3-36-rot-b-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({ sessionId: ownerSync.session.sessionId,
          replicaId: ownerSync.replica.replicaId, collectionId: owned.collectionId, sequence: 2,
          targetId: secondNode.id, baseRevision: secondNode.revision, opId: `p3-36-rot-b-${randomUUID()}`,
          base: { title: 'Rotated base B' }, value: { title: 'Rotated incoming B' } }) });
      assert.equal(pushB.status, 200, JSON.stringify(pushB.body));
      const conflictB = syncResult(pushB.body).results[0]!.conflictId!;
      const v1Rows = await runtime.pool.query<{ private_payload_key_version: number }>(
        'select private_payload_key_version from sync_conflicts where conflict_id=any($1::text[])',
        [[conflictA, conflictB]],
      );
      assert.deepEqual(new Set(v1Rows.rows.map((row) => row.private_payload_key_version)), new Set([1]));

      // Removing a key that is still referenced by an open Conflict fails readiness closed.
      const withoutV1 = createPostgresSyncConflictKeyringReadiness(runtime.db,
        { active: { key: CONFLICT_KEY_V2, keyVersion: 2 }, retained: [] });
      assert.equal((await withoutV1()).status, 'not-ready');
      const withV1 = createPostgresSyncConflictKeyringReadiness(runtime.db, keyringV2);
      assert.deepEqual(await withV1(), { capability: 'sync-conflicts', status: 'ready',
        referencedVersions: [1] });

      // After rotation the product center decrypts historical payloads through the retained key.
      const apiV2 = productApp(keyringV2);
      try {
        const conflicts = await apiV2.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=10',
          headers: { cookie: owner.cookie } });
        assert.equal(conflicts.statusCode, 200, conflicts.body);
        const page = conflicts.json() as { items: Array<{ id: string;
          summary: { current: string | null; incoming: string | null } }> };
        const itemA = page.items.find((item) => item.id === conflictA);
        const itemB = page.items.find((item) => item.id === conflictB);
        assert.deepEqual(itemA?.summary, { current: 'Rotated sync base', incoming: 'Rotated incoming A' });
        assert.deepEqual(itemB?.summary, { current: 'Rotated second base', incoming: 'Rotated incoming B' });
        const resolveA = { method: 'POST' as const,
          url: `/api/v1/sync/conflicts/${conflictA}/resolution`,
          headers: { ...mutation(owner, randomUUID(), 'application/json'), 'if-match': '"conflict-r1"' },
          payload: { resolution: 'incoming' } };
        const resolvedA = await apiV2.inject(resolveA);
        assert.equal(resolvedA.statusCode, 200, resolvedA.body);
        assert.equal((await withoutV1()).status, 'not-ready');

        // Draining the remaining v1 Conflicts makes the version removable.
        const drain = await createUnitOfWork(runtime.db).execute(({ transaction }) =>
          reencryptOpenSyncConflicts(transaction, keyringV2, 1));
        assert.deepEqual(drain, { reencrypted: 1 });
        assert.deepEqual(await withoutV1(), { capability: 'sync-conflicts', status: 'ready',
          referencedVersions: [2] });
        const resolveB = { method: 'POST' as const,
          url: `/api/v1/sync/conflicts/${conflictB}/resolution`,
          headers: { ...mutation(owner, randomUUID(), 'application/json'), 'if-match': '"conflict-r1"' },
          payload: { resolution: 'incoming' } };
        const resolvedB = await apiV2.inject(resolveB);
        assert.equal(resolvedB.statusCode, 200, resolvedB.body);
        const rowB = await runtime.pool.query<{ private_payload_key_version: number }>(
          'select private_payload_key_version from sync_conflicts where conflict_id=$1', [conflictB]);
        assert.equal(rowB.rows[0]?.private_payload_key_version, 2);
      } finally { await apiV2.close(); }

      // Resolutions use independent server authors, so this browser continues at Sequence 3.
      const v2Push = await startPush(ownerSync, { key: CONFLICT_KEY_V2, keyVersion: 2 });
      const pushC = await v2Push.push({ idempotencyKey: `p3-36-rot-c-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({ sessionId: ownerSync.session.sessionId,
          replicaId: ownerSync.replica.replicaId, collectionId: owned.collectionId, sequence: 3,
          targetId: thirdNode.id, baseRevision: thirdNode.revision, opId: `p3-36-rot-c-${randomUUID()}`,
          base: { title: 'Rotated base C' }, value: { title: 'Rotated incoming C' } }) });
      assert.equal(pushC.status, 200, JSON.stringify(pushC.body));
      const conflictC = syncResult(pushC.body).results[0]!.conflictId!;
      const rowC = await runtime.pool.query<{ private_payload_key_version: number }>(
        'select private_payload_key_version from sync_conflicts where conflict_id=$1', [conflictC]);
      assert.equal(rowC.rows[0]?.private_payload_key_version, 2);

      // Unknown persisted versions and tampered material stay masked and fail closed.
      const apiV2b = productApp(keyringV2);
      try {
        const beforeTamper = await apiV2b.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=10',
          headers: { cookie: owner.cookie } });
        assert.equal(beforeTamper.statusCode, 200, beforeTamper.body);
        const page = beforeTamper.json() as { items: Array<{ id: string;
          summary: { current: string | null; incoming: string | null } }> };
        assert.deepEqual(page.items.map((item) => item.id), [conflictC]);
        assert.deepEqual(page.items[0]?.summary, { current: 'Rotated third base', incoming: 'Rotated incoming C' });
        await runtime.pool.query('update sync_conflicts set private_payload_key_version=999 where conflict_id=$1',
          [conflictC]);
        const tampered = await apiV2b.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=10',
          headers: { cookie: owner.cookie } });
        assert.equal(tampered.statusCode, 500, tampered.body);
        assert.equal(tampered.json().error.code, 'internal_error');
        assert.equal(tampered.body.includes('Rotated incoming C'), false);
        assert.equal(tampered.body.includes(CONFLICT_KEY_V1.toString('base64')), false);
        assert.equal(tampered.body.includes(CONFLICT_KEY_V2.toString('base64')), false);
      } finally { await apiV2b.close(); }
    } finally { await apiV1.close(); }
  }, 120_000);

  test('dismisses a delete_update Conflict through Product HTTP while keeping the tombstone', async () => {
    const api = productApp();
    try {
      const owner = await login(`p3-36-dismiss-owner-${randomUUID()}`);
      const owned = await createCollectionAndNode(api, owner, 'Dismiss sync');
      const ownerSync = await syncContext(owner, owned.collectionId, 'Dismiss');
      const pushClient = await startPush(ownerSync);

      const deleteOpId = `p3-36-dismiss-delete-${randomUUID()}`;
      const deleted = await pushClient.push({ idempotencyKey: `p3-36-dismiss-delete-${randomUUID()}`,
        request: syncNodeDeletePushRequest({ sessionId: ownerSync.session.sessionId,
          replicaId: ownerSync.replica.replicaId, collectionId: owned.collectionId,
          targetId: owned.node.id, baseRevision: owned.node.revision, opId: deleteOpId }) });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal(syncResult(deleted.body).results[0]?.status, 'applied');

      const conflicted = await pushClient.push({ idempotencyKey: `p3-36-dismiss-conflict-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({ sessionId: ownerSync.session.sessionId,
          replicaId: ownerSync.replica.replicaId, collectionId: owned.collectionId, sequence: 2,
          targetId: owned.node.id, baseRevision: owned.node.revision,
          opId: `p3-36-dismiss-conflict-${randomUUID()}`, base: { title: 'Dismiss sync base' },
          value: { title: 'Dismiss incoming' } }) });
      assert.equal(conflicted.status, 200, JSON.stringify(conflicted.body));
      const conflictId = syncResult(conflicted.body).results[0]!.conflictId!;

      // FIX-M-015 (SYNC-R10): the external menu advertises exactly the executable
      // dismiss choice; the stored Conflict event itself stays immutable.
      const conflicts = await api.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=10',
        headers: { cookie: owner.cookie } });
      assert.equal(conflicts.statusCode, 200, conflicts.body);
      const item = (conflicts.json() as { items: Array<{ id: string; type: string;
        allowedResolutions: string[] }> }).items.find((row) => row.id === conflictId);
      assert.equal(item?.type, 'delete_update');
      assert.deepEqual(item?.allowedResolutions, ['server']);
      const event = await runtime.pool.query<{ status: string; allowed: string[] }>(
        'select pull_wire_json->>\'status\' as status,pull_wire_json->\'allowedResolutions\' as allowed from sync_conflicts where conflict_id=$1',
        [conflictId]);
      assert.equal(event.rows[0]?.status, 'open');
      assert.deepEqual(event.rows[0]?.allowed, ['server']);

      // Non-advertised choices stay stable 422 before any side effect.
      for (const payload of [{ resolution: 'incoming' }, { resolution: 'both' },
        { resolution: 'custom', value: 'Merged title' }]) {
        const denied = await api.inject({ method: 'POST',
          url: `/api/v1/sync/conflicts/${conflictId}/resolution`,
          headers: { ...mutation(owner, randomUUID(), 'application/json'), 'if-match': '"conflict-r1"' },
          payload });
        assert.equal(denied.statusCode, 422, denied.body);
        assert.equal(denied.json().error.code, 'invalid_document');
      }

      // The delete_update Conflict cannot be widened back to a lying menu.
      await assert.rejects(runtime.pool.query(
        'update sync_conflicts set allowed_resolutions=$2::jsonb where conflict_id=$1',
        [conflictId, JSON.stringify(['server', 'incoming'])]),
      (error: unknown) => (error as { code?: string }).code === '23514');

      const beforeResolve = await counts(owned.collectionId, ownerSync.replica.replicaId, conflictId);
      const dismissCommand = randomUUID();
      const dismissRequest = { method: 'POST' as const,
        url: `/api/v1/sync/conflicts/${conflictId}/resolution`,
        headers: { ...mutation(owner, dismissCommand, 'application/json'), 'if-match': '"conflict-r1"' },
        payload: { resolution: 'server' } };
      const dismissed = await api.inject(dismissRequest);
      assert.equal(dismissed.statusCode, 200, dismissed.body);
      const view = dismissed.json() as { conflictId: string; status: string; revision: string; etag: string };
      assert.equal(view.conflictId, conflictId);
      assert.equal(view.status, 'resolved');
      assert.match(view.revision, /^conflict-resolved-/u);
      assert.equal(view.etag, `"${view.revision}"`);
      const replay = await api.inject(dismissRequest);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.body, dismissed.body);
      assert.deepEqual(await counts(owned.collectionId, ownerSync.replica.replicaId, conflictId),
        incrementDismissal(beforeResolve));

      // Dismiss keeps the tombstone and the deleted Node row untouched.
      const nodeRows = await runtime.pool.query<{ deleted: boolean }>(
        'select deleted_at is not null as deleted from nodes where collection_id=$1 and id=$2',
        [owned.collectionId, owned.node.id]);
      assert.equal(nodeRows.rows[0]?.deleted, true);
      const tombstone = await runtime.pool.query<{ operation_id: string }>(
        'select operation_id from sync_node_tombstones where collection_id=$1 and target_id=$2',
        [owned.collectionId, owned.node.id]);
      assert.equal(tombstone.rows[0]?.operation_id, deleteOpId);
      const closed = await runtime.pool.query<{ status: string; resolution: string | null }>(
        'select status,resolution from sync_conflicts where conflict_id=$1', [conflictId]);
      assert.equal(closed.rows[0]?.status, 'resolved');
      assert.equal(closed.rows[0]?.resolution, 'server');
      const openConflicts = await api.inject({ method: 'GET', url: '/api/v1/sync/conflicts?limit=10',
        headers: { cookie: owner.cookie } });
      assert.equal(openConflicts.statusCode, 200, openConflicts.body);
      const remaining = (openConflicts.json() as { items: Array<{ id: string }> }).items
        .map((row) => row.id);
      assert.equal(remaining.includes(conflictId), false);
    } finally { await api.close(); }
  }, 120_000);

  test('uses the production owner/open Conflict keyset index', async () => {
    await runtime.pool.query('set enable_seqscan=off');
    try {
      const explained = await runtime.pool.query<{ 'QUERY PLAN': unknown }>(`explain (format json)
        select conflict.conflict_id,conflict.created_at from sync_conflicts conflict
        join sync_replicas replica on replica.replica_id=conflict.replica_id
        where replica.account_id=$1 and conflict.status='open'
        order by conflict.created_at desc,conflict.conflict_id desc limit 21`, ['plan-account']);
      assert.match(JSON.stringify(explained.rows[0]?.['QUERY PLAN']), /sync_conflicts_replica_open_product_idx/u);
    } finally { await runtime.pool.query('reset enable_seqscan'); }
  });

  async function counts(collectionId: string, replicaId: string, conflictId: string) {
    return (await runtime.pool.query(`select
      (select count(*)::int from operations where collection_id=$1) operations,
      (select count(*)::int from audit_events where collection_id=$1) audits,
      (select count(*)::int from outbox_events where aggregate_scope=$1) outbox,
      (select count(*)::int from sync_conflict_resolution_receipts where conflict_id=$2) sync_receipts,
      (select count(*)::int from product_command_receipts where command_scope=$3) product_receipts,
      (select count(*)::int from sync_sequence_receipts where replica_id=$4) sequence_receipts`,
    [collectionId, conflictId, `sync-conflict-resolution:${conflictId}`, replicaId])).rows[0];
  }

  async function retirementCounts(replicaId: string) {
    const row = (await runtime.pool.query(`select
      (select lifecycle_revision::text from sync_replicas where replica_id=$1) "lifecycleRevision",
      (select count(*)::int from audit_events event join audit_event_payloads payload
        on payload.event_id=event.id where event.event_type like 'sync.replica.lifecycle.%_to_retired'
        and payload.details_json->>'replicaId'=$1) audits,
      (select count(*)::int from product_command_receipts where command_scope=$2) "productReceipts",
      (select count(*)::int from sync_sessions where replica_id=$1 and status='active') "activeSessions"`,
    [replicaId, `sync-replica-retire:${replicaId}`])).rows[0];
    return { lifecycleRevision: row.lifecycleRevision as string, audits: row.audits as number,
      productReceipts: row.productReceipts as number, activeSessions: row.activeSessions as number };
  }
});

function incrementResolution(before: Record<string, number>) {
  return { operations: before.operations + 1, audits: before.audits + 1, outbox: before.outbox + 1,
    sync_receipts: before.sync_receipts + 1, product_receipts: before.product_receipts + 1,
    // Server resolution has an independent author; browser lane receipts do not change.
    sequence_receipts: before.sequence_receipts };
}

function incrementDismissal(before: Record<string, number>) {
  return { operations: before.operations + 1, audits: before.audits + 1, outbox: before.outbox,
    sync_receipts: before.sync_receipts + 1, product_receipts: before.product_receipts + 1,
    // FIX-M-015 (SYNC-R10): dismiss keeps the tombstone, so no canonical mutation
    // and no projection outbox events — only the dismissal operation, its audit
    // event and the single server-claimed Sequence slot.
    sequence_receipts: before.sequence_receipts };
}

function syncResult(body: Problem | SyncPushResult): SyncPushResult {
  assert.ok('results' in body, `expected SyncPushResult, got ${'code' in body ? body.code : 'unknown'}`);
  return body;
}

function manifest(app: FastifyInstance): Manifest {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Sync test server did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  return { protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019fa766-5737-7413-8a21-afb8ccebcd83', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncPush: `${origin}/private-entry/canonical-update` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
  } as Manifest;
}
