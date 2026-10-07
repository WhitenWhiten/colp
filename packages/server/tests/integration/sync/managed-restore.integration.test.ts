/**
 * Owner: KNS-08 (QA). Fixture: see Known-Extension/e2e/kns-08-ids.ts.
 * Run: see Known-Extension/e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { subtreeDeleteSource } from '@know-n/colp/sync';
import { PostgresSyncTombstonePurgeCoordinator } from '../../../src/infrastructure/sync/sync-tombstone-purge-postgres.js';
import { purgeOwnedTrashInTransaction } from '../../../src/infrastructure/sync/sync-tombstone-user-purge-postgres.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPushResult } from '@know-n/colp/types';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresProductSyncCenterUnitOfWork,
  createPostgresReplicaStore,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { NODE_DELETION_PURGE_RETENTION_MS } from '../../../src/modules/collections/index.js';
import { encodeTrashDeletionId } from '../../../src/modules/sync/product-sync-trash.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { syncNodeRestorePushRequest } from '../../fixtures/phase3/sync-node-restore.js';
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
const AUTHORIZATION = 'Bearer KNS-06-EXTENSION-AUTHORIZATION-MARKER';

interface ProductClient {
  readonly cookie: string; readonly csrf: string; readonly accountId: string;
  readonly subjectId: string; readonly identitySubject: string;
}

describeWithPostgres('KNS-06 mount uniqueness, restore, and Product trash', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  const syncApps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('kns_06_mount_restore_trash', { maxConnections: 16 });
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
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'kns-06-editor-cursor-secret', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    });
  }, 120_000);

  afterEach(async () => {
    await Promise.all(syncApps.splice(0).map(async (app) => { try { await app.close(); } catch { /* already closed */ } }));
  });
  afterAll(async () => isolated?.close());

  function productApp() {
    const identity = createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    return buildApiApp({
      config, identityUnitOfWork: identity,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      productSyncCenterUnitOfWork: createPostgresProductSyncCenterUnitOfWork(runtime.db, {
        cursorSecret: 'kns-06-product-sync-trash-cursor-secret-32b',
        conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] },
      }),
      browserSessionAuthority: factory.authority,
    });
  }

  async function login(subject: string): Promise<ProductClient> {
    const client = await issueTestSession({
      factory, subject, displayName: subject, handle: `kns06_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    await runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
      [`kns-06-identity-${randomUUID()}`, client.accountId, EXTENSION_ISSUER, subject],
    );
    return { cookie: client.cookie, csrf: client.csrfToken,
      accountId: client.accountId, subjectId: client.subjectId, identitySubject: subject };
  }

  function mutation(client: ProductClient, commandId: string, contentType?: string) {
    return { cookie: client.cookie, origin: PRODUCT_ORIGIN, 'x-csrf-token': client.csrf,
      'known-command-id': commandId, ...(contentType ? { 'content-type': contentType } : {}) };
  }

  async function createCollection(api: ReturnType<typeof productApp>, owner: ProductClient, title: string) {
    const response = await api.inject({ method: 'POST', url: '/api/v1/collections',
      headers: mutation(owner, randomUUID(), 'application/json'),
      payload: { kind: 'bookmarks', title, summary: null } });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json() as { collection: { id: string }; root: { id: string } };
    return { collectionId: body.collection.id, rootId: body.root.id };
  }

  async function syncContext(owner: ProductClient, collectionId: string) {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: owner.identitySubject, credentialId: `kns-06-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(runtime.db, { ids: {
      deviceId: () => `kns-06-device-${suffix}`, replicaId: () => `kns-06-replica-${suffix}`,
      leaseId: () => `kns-06-lease-${suffix}`,
    } }).create({
      accountId: owner.accountId, collectionId, deviceName: 'KNS-06 device', replicaName: 'KNS-06 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `kns-06-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `kns-06-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: owner.accountId });
    const issuer = createPostgresSyncSessionIssuer(runtime.db, {
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 6), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `kns-06-session-${suffix}`, requestFingerprint: `kns-06-fingerprint-${suffix}`,
      collectionId, replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push', 'sync:pull'], origin: EXTENSION_ORIGIN,
    });
    return { credential, replica, issuer, session: issued.session, collectionId };
  }

  async function startPush(value: Awaited<ReturnType<typeof syncContext>>, nodeId?: () => string, managedBookmarkWrites = false) {
    const app = Fastify({ logger: false });
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-update', allowedOrigins: [EXTENSION_ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(runtime.db, value.issuer, {
        ...(nodeId ? { nodeId } : {}), managedBookmarkWrites,
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
      manifestUrl: `http://127.0.0.1:${address.port}/.well-known/collection-protocol`,
      mountId: 'known-sync-entry', authorization: AUTHORIZATION, origin: EXTENSION_ORIGIN,
    });
  }

  function applied(body: Problem | SyncPushResult): SyncPushResult['results'][number] {
    assert.ok('results' in body, `expected SyncPushResult, got ${'code' in body ? body.code : 'unknown'}`);
    return body.results[0]!;
  }


  test('SD-01 restore enforces managed ancestry and rolls back denial', async () => {
    const api = productApp();
    try {
      const owner = await login(`audit-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'Audit restore');
      const ctx = await syncContext(owner, collectionId);
      const push = await startPush(ctx);
      let sequence = 1;
      const base = () => ({ sessionId: ctx.session.sessionId, replicaId: ctx.replica.replicaId,
        collectionId, sequence: sequence++, opId: `audit-${randomUUID()}` });
      async function apply(request: ReturnType<typeof syncNodeCreatePushRequest>) {
        const response = await push.push({ idempotencyKey: `audit-${randomUUID()}`, request });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return applied(response.body);
      }
      const parent = await apply(syncNodeCreatePushRequest({ ...base(), parentId: rootId,
        node: { kind: 'folder', title: 'Managed ancestor' } }));
      const child = await apply(syncNodeCreatePushRequest({ ...base(), parentId: parent.targetId,
        node: { kind: 'bookmark', title: 'Restore me', url: 'https://example.test/audit' } }));
      const deleted = await apply(syncNodeDeletePushRequest({ ...base(), targetId: child.targetId,
        baseRevision: child.revision }));
      // Model an existing managed tree after the deployment capability is disabled.
      await runtime.pool.query(`update nodes set payload_json=jsonb_set(payload_json,'{folderRole}','"managed-bookmarks"') where id=$1`, [parent.targetId]);
      const before = await runtime.pool.query<{ audit: string; outbox: string }>(
        `select (select count(*) from audit_events where collection_id=$1)::text audit,
                (select count(*) from outbox_events where aggregate_scope=$1)::text outbox`, [collectionId]);
      const request = syncNodeRestorePushRequest({ ...base(), targetId: child.targetId, baseRevision: deleted.revision, reason: 'restore' });
      const restored = await push.push({ idempotencyKey: `audit-${randomUUID()}`, request });
      assert.ok('code' in restored.body);
      assert.equal(restored.body.code, 'node_read_only');
      const after = await runtime.pool.query<{ audit: string; outbox: string }>(
        `select (select count(*) from audit_events where collection_id=$1)::text audit,
                (select count(*) from outbox_events where aggregate_scope=$1)::text outbox`, [collectionId]);
      assert.deepEqual(after.rows[0], before.rows[0]);
      sequence--; // denied transaction did not advance the replica lane
      // Positive control: create uses the managed ancestry policy on the same live parent.
      const denied = await push.push({ idempotencyKey: `audit-${randomUUID()}`,
        request: syncNodeCreatePushRequest({ ...base(), parentId: parent.targetId,
          node: { kind: 'bookmark', title: 'Must deny', url: 'https://example.test/denied' } }) });
      assert.ok('code' in denied.body);
      assert.equal(denied.body.code, 'node_read_only');
      const remains = await runtime.db.selectFrom('sync_node_tombstones').select('target_id').where('target_id', '=', child.targetId).execute();
      assert.equal(remains.length, 1);
      const enabled = await startPush(ctx, undefined, true);
      const allowed = await enabled.push({ idempotencyKey: `allowed-${randomUUID()}`, request });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
      assert.equal(applied(allowed.body).status, 'applied');
    } finally { await api.close(); }
  }, 60000);


});

function manifest(app: FastifyInstance): Manifest {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Sync test server did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  return { protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019fa766-5706-7413-8a21-afb8ccebcd83', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncPush: `${origin}/private-entry/canonical-update` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
  } as Manifest;
}
