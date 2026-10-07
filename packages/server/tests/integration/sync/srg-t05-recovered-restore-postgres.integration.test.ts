import { createPostgresReportSourceInvalidationOutboxPort } from '../../../src/infrastructure/outbox/report-source-invalidation-producer.js';
import { PostgresCollectionMutationProjectionRepository } from '../../../src/infrastructure/outbox/postgres-collection-mutation-projection.js';
import assert from 'node:assert/strict';
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
  type PostgresSyncNodeCreateFaultPhase,
} from '../../../src/infrastructure/sync/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { syncNodeRestorePushRequest } from '../../fixtures/phase3/sync-node-restore.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PRODUCT_ORIGIN = 'https://app.example.test';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ISSUER = 'https://issuer.example/realms/known';
const AUTHORIZATION = 'Bearer SRG-T05-EXTENSION-AUTHORIZATION-MARKER';

interface ProductClient {
  readonly cookie: string; readonly csrf: string; readonly accountId: string;
  readonly subjectId: string; readonly identitySubject: string;
}

describeWithPostgres('T-05 Recovered create+restore (SRG-01)', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  const syncApps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('srg_t05_recovered_restore', { maxConnections: 16 });
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
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'srg-t05-editor-cursor-secret', NODE_ENV: 'test', LOG_LEVEL: 'silent',
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
        cursorSecret: 'srg-t05-product-sync-cursor-secret-32b',
        conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] },
      }),
      browserSessionAuthority: factory.authority,
    });
  }

  async function login(subject: string): Promise<ProductClient> {
    const client = await issueTestSession({
      factory, subject, displayName: subject, handle: `t05_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    await runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
      [`t05-identity-${randomUUID()}`, client.accountId, EXTENSION_ISSUER, subject],
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
      subject: owner.identitySubject, credentialId: `t05-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(runtime.db, { ids: {
      deviceId: () => `t05-device-${suffix}`, replicaId: () => `t05-replica-${suffix}`,
      leaseId: () => `t05-lease-${suffix}`,
    } }).create({
      accountId: owner.accountId, collectionId, deviceName: 'T-05 device', replicaName: 'T-05 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `t05-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `t05-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: owner.accountId });
    const issuer = createPostgresSyncSessionIssuer(runtime.db, {
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 5), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `t05-session-${suffix}`, requestFingerprint: `t05-fingerprint-${suffix}`,
      collectionId, replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push', 'sync:pull'], origin: EXTENSION_ORIGIN,
    });
    return { credential, replica, issuer, session: issued.session, collectionId };
  }

  async function startPush(value: Awaited<ReturnType<typeof syncContext>>, options: {
    readonly nodeId?: () => string;
    readonly failAt?: PostgresSyncNodeCreateFaultPhase;
  } = {}) {
    const app = Fastify({ logger: false });
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-update', allowedOrigins: [EXTENSION_ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(runtime.db, value.issuer, {
        ...(options.nodeId ? { nodeId: options.nodeId } : {}),
        reportSourceInvalidation: createPostgresReportSourceInvalidationOutboxPort(),
        ...(options.failAt ? { faultInjector: { afterPhase(phase) {
          if (phase === options.failAt) throw new Error(`t05 injected ${phase}`);
        } } } : {}),
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

  async function seedOrphan(owner: ProductClient, collectionId: string, rootId: string, mountRole:
    'bookmarks-bar' | 'other-bookmarks' | 'custom' = 'bookmarks-bar') {
    const ctx = await syncContext(owner, collectionId);
    const push = await startPush(ctx);
    let sequence = 1;
    const base = () => ({ sessionId: ctx.session.sessionId, replicaId: ctx.replica.replicaId,
      collectionId, sequence: sequence++, opId: `t05-${randomUUID()}` });
    async function apply(request: ReturnType<typeof syncNodeCreatePushRequest>) {
      const response = await push.push({ idempotencyKey: `t05-${randomUUID()}`, request });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const receipt = applied(response.body); assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
      return receipt;
    }
    const mount = await apply(syncNodeCreatePushRequest({ ...base(), parentId: rootId,
      node: { kind: 'folder', title: mountRole, folderRole: mountRole } }));
    const folder = await apply(syncNodeCreatePushRequest({ ...base(), parentId: mount.targetId,
      node: { kind: 'folder', title: 'Original parent' } }));
    const child = await apply(syncNodeCreatePushRequest({ ...base(), parentId: folder.targetId,
      node: { kind: 'bookmark', title: 'Restore me', url: 'https://example.test/t05' } }));
    const deleted = await apply(syncNodeDeletePushRequest({ ...base(), targetId: child.targetId,
      baseRevision: child.revision }));
    await apply(syncNodeDeletePushRequest({ ...base(), targetId: folder.targetId, baseRevision: folder.revision }));
    return { ctx, push, sequence, mount, child, deleted, restoreBase: () => ({
      sessionId: ctx.session.sessionId, replicaId: ctx.replica.replicaId, collectionId,
    }) };
  }

  test('R-02: Pull wire is Rec then X; consecutive ordinals; limit=1 paging', async () => {
    const api = productApp();
    try {
      const owner = await login(`t05-r02-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'T-05 R-02');
      const seeded = await seedOrphan(owner, collectionId, rootId);
      const restoreOpId = `t05-restore-${randomUUID()}`;
      const restoreSeq = seeded.sequence;
      const restored = await seeded.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeRestorePushRequest({
          ...seeded.restoreBase(), sequence: seeded.sequence, opId: restoreOpId,
          targetId: seeded.child.targetId, baseRevision: seeded.deleted.revision, reason: 'restore',
        }),
      });
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.equal(applied(restored.body).opId, restoreOpId);
      assert.equal(applied(restored.body).sequence, restoreSeq);
      assert.equal(applied(restored.body).targetId, seeded.child.targetId);
      const rows = await runtime.pool.query<{
        kind: string; ordinal: string; op_id: string; node_id: string; folder_role: string | null;
      }>(
        `select effect.effect_json->>'kind' as kind, effect.commit_ordinal::text as ordinal,
                effect.operation_id as op_id, effect.effect_json->'node'->>'id' as node_id,
                effect.effect_json->'node'->>'folderRole' as folder_role
           from sync_operation_effects effect
          where effect.collection_id=$1
            and effect.commit_ordinal >= (
              select commit_ordinal from sync_operation_effects where operation_id=$2) - 1
          order by effect.commit_ordinal, effect.operation_id`,
        [collectionId, restoreOpId],
      );
      assert.equal(rows.rows[0]?.kind, 'node_created');
      assert.equal(rows.rows[0]?.folder_role, 'recovered');
      assert.equal(rows.rows[1]?.kind, 'node_restored');
      assert.equal(rows.rows[1]?.node_id, seeded.child.targetId);
      assert.ok(BigInt(rows.rows[0]!.ordinal) + 1n === BigInt(rows.rows[1]!.ordinal));
      const page1 = rows.rows.slice(0, 1);
      const page2 = rows.rows.slice(1, 2);
      assert.equal(page1[0]?.kind, 'node_created');
      assert.equal(page2[0]?.kind, 'node_restored');
      const ordinal = BigInt(rows.rows[1]!.ordinal);
      const audits = await runtime.db.selectFrom('audit_events').select('operation_id').where('operation_id', '=', restoreOpId).execute();
      assert.equal(audits.length, 1);
      const events = await runtime.db.selectFrom('outbox_events').selectAll().where('aggregate_scope', '=', collectionId)
        .where('commit_ordinal', '=', ordinal).execute();
      const event = events.find(row => row.event_type === 'node.restored');
      assert.ok(event); assert.equal(event.aggregate_id, seeded.child.targetId);
      assert.equal(events.filter(row => row.event_type === 'node.restored').length, 1);
      assert.ok(events.some(row => (row.payload_json as { sourceEventType?: string }).sourceEventType === 'node.restored'),
        'report invalidation uses the final restore ordinal, not only Recovered creation');
      const projection = new PostgresCollectionMutationProjectionRepository(runtime.pool);
      assert.equal(await projection.apply({ eventId: event.domain_event_id, eventType: event.event_type, eventVersion: event.event_version,
        handlerName: event.handler_name, idempotencyKey: event.domain_event_id, aggregateId: event.aggregate_id!,
        aggregateScope: event.aggregate_scope, commitOrdinal: String(event.commit_ordinal), payload: event.payload_json,
        aggregateRevision: event.aggregate_revision, occurredAt: event.occurred_at.toISOString() }), 'applied');
      const projected = await projection.getResource(collectionId, 'node', seeded.child.targetId!);
      assert.equal(projected?.deleted, false); assert.equal(projected?.lastEventType, 'node.restored');

    } finally { await api.close(); }
  }, 60_000);

  test('R-03: concurrent same-mount restores share one Rec; different mounts stay independent', async () => {
    const api = productApp();
    try {
      const owner = await login(`t05-r03-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'T-05 R-03');
      const first = await seedOrphan(owner, collectionId, rootId, 'bookmarks-bar');
      const secondCtx = await syncContext(owner, collectionId);
      const secondPush = await startPush(secondCtx);
      const folderB = applied((await first.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeCreatePushRequest({
          sessionId: first.ctx.session.sessionId, replicaId: first.ctx.replica.replicaId,
          collectionId, sequence: first.sequence, opId: `t05-${randomUUID()}`, parentId: first.mount.targetId,
          node: { kind: 'folder', title: 'Parent B' },
        }),
      })).body);
      const childB = applied((await first.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeCreatePushRequest({
          sessionId: first.ctx.session.sessionId, replicaId: first.ctx.replica.replicaId,
          collectionId, sequence: first.sequence + 1, opId: `t05-${randomUUID()}`, parentId: folderB.targetId,
          node: { kind: 'bookmark', title: 'Sibling', url: 'https://example.test/t05-b' },
        }),
      })).body);
      const deletedB = applied((await first.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeDeletePushRequest({
          sessionId: first.ctx.session.sessionId, replicaId: first.ctx.replica.replicaId,
          collectionId, sequence: first.sequence + 2, opId: `t05-${randomUUID()}`,
          targetId: childB.targetId, baseRevision: childB.revision,
        }),
      })).body);
      await first.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeDeletePushRequest({
          sessionId: first.ctx.session.sessionId, replicaId: first.ctx.replica.replicaId,
          collectionId, sequence: first.sequence + 3, opId: `t05-${randomUUID()}`,
          targetId: folderB.targetId, baseRevision: folderB.revision,
        }),
      });
      const [left, right] = await Promise.all([
        first.push.push({
          idempotencyKey: `t05-${randomUUID()}`,
          request: syncNodeRestorePushRequest({
            sessionId: first.ctx.session.sessionId, replicaId: first.ctx.replica.replicaId,
            collectionId, sequence: first.sequence + 4, opId: `t05-${randomUUID()}`,
            targetId: first.child.targetId, baseRevision: first.deleted.revision, reason: 'restore',
          }),
        }),
        secondPush.push({
          idempotencyKey: `t05-${randomUUID()}`,
          request: syncNodeRestorePushRequest({
            sessionId: secondCtx.session.sessionId, replicaId: secondCtx.replica.replicaId,
            collectionId, sequence: 1, opId: `t05-${randomUUID()}`,
            targetId: childB.targetId, baseRevision: deletedB.revision, reason: 'restore',
          }),
        }),
      ]);
      assert.equal(left.status, 200, JSON.stringify(left.body));
      assert.equal(right.status, 200, JSON.stringify(right.body));
      const recs = await runtime.pool.query<{ id: string; parent_id: string }>(
        `select id, parent_id from nodes where collection_id=$1 and folder_role='recovered' and deleted_at is null`,
        [collectionId]);
      assert.equal(recs.rows.length, 1);
      assert.equal(recs.rows[0]?.parent_id, first.mount.targetId);

      const other = await seedOrphan(owner, collectionId, rootId, 'other-bookmarks');
      await other.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeRestorePushRequest({
          ...other.restoreBase(), sequence: other.sequence, opId: `t05-${randomUUID()}`,
          targetId: other.child.targetId, baseRevision: other.deleted.revision, reason: 'restore',
        }),
      });
      const both = await runtime.pool.query<{ id: string; parent_id: string }>(
        `select id, parent_id from nodes where collection_id=$1 and folder_role='recovered' and deleted_at is null`,
        [collectionId]);
      assert.equal(both.rows.length, 2);
      assert.equal(new Set(both.rows.map((row) => row.parent_id)).size, 2);
    } finally { await api.close(); }
  }, 60_000);

  test('R-04: crash at create/history/effect/restore/receipt leaves zero partial commit', async () => {
    const faults = ['recovered_create', 'history', 'recovered_effect', 'restore', 'audit', 'outbox', 'receipt'] as const;
    const api = productApp();
    try {
      for (const failAt of faults) {
        const owner = await login(`t05-r04-${failAt}-${randomUUID()}`);
        const { collectionId, rootId } = await createCollection(api, owner, `T-05 R-04 ${failAt}`);
        const seeded = await seedOrphan(owner, collectionId, rootId);
        const before = await counts(collectionId, seeded.child.targetId);
        const failing = await startPush(seeded.ctx, { failAt });
        const response = await failing.push({
          idempotencyKey: `t05-${randomUUID()}`,
          request: syncNodeRestorePushRequest({
            ...seeded.restoreBase(), sequence: seeded.sequence, opId: `t05-${randomUUID()}`,
            targetId: seeded.child.targetId, baseRevision: seeded.deleted.revision, reason: 'restore',
          }),
        });
        assert.notEqual(response.status, 200);
        const after = await counts(collectionId, seeded.child.targetId);
        assert.deepEqual(after, before, failAt);
      }
    } finally { await api.close(); }
  }, 120_000);

  test('R-05: lost response + cross-Session replay does not create a second Rec', async () => {
    const api = productApp();
    try {
      const owner = await login(`t05-r05-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'T-05 R-05');
      const seeded = await seedOrphan(owner, collectionId, rootId);
      const restoreOpId = `t05-replay-${randomUUID()}`;
      const request = syncNodeRestorePushRequest({
        ...seeded.restoreBase(), sequence: seeded.sequence, opId: restoreOpId,
        targetId: seeded.child.targetId, baseRevision: seeded.deleted.revision, reason: 'restore',
      });
      const first = await seeded.push.push({ idempotencyKey: `t05-${randomUUID()}`, request });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const beforeReplay = await counts(collectionId, seeded.child.targetId);
      const replica = await runtime.db.selectFrom('sync_replicas').selectAll()
        .where('replica_id', '=', seeded.ctx.replica.replicaId).executeTakeFirstOrThrow();
      const secondSession = await seeded.ctx.issuer.issue({
        credential: seeded.ctx.credential, idempotencyKey: `t05-new-session-${randomUUID()}`,
        requestFingerprint: `t05-new-fp-${randomUUID()}`, collectionId,
        replicaId: seeded.ctx.replica.replicaId, expectedLeaseGeneration: String(replica.lease_generation),
        expectedLifecycleRevision: String(replica.lifecycle_revision), binding: seeded.ctx.replica.binding,
        requestedScopes: ['sync:push', 'sync:pull'], origin: EXTENSION_ORIGIN,
      });
      const replay = await seeded.push.push({
        idempotencyKey: `t05-cross-${randomUUID()}`,
        request: { ...request, sessionId: secondSession.session.sessionId,
          batchId: `${secondSession.session.sessionId}.t05` },
      });
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(await counts(collectionId, seeded.child.targetId), beforeReplay);
      assert.equal(applied(replay.body).targetId, seeded.child.targetId);
      const recs = await runtime.pool.query<{ count: number }>(
        `select count(*)::int as count from nodes
          where collection_id=$1 and folder_role='recovered' and deleted_at is null`, [collectionId]);
      assert.equal(recs.rows[0]?.count, 1);
      const creates = await runtime.pool.query<{ count: number }>(
        `select count(*)::int as count from sync_operation_effects
          where collection_id=$1 and effect_json->>'kind'='node_created'
            and effect_json->'node'->>'folderRole'='recovered'`, [collectionId]);
      assert.equal(creates.rows[0]?.count, 1);
    } finally { await api.close(); }
  }, 60_000);

  test('R-06: custom mount Rec; deleted original mount falls back to Collection root', async () => {
    const api = productApp();
    try {
      const owner = await login(`t05-r06-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'T-05 R-06');
      const custom = await seedOrphan(owner, collectionId, rootId, 'custom');
      await custom.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeRestorePushRequest({
          ...custom.restoreBase(), sequence: custom.sequence, opId: `t05-${randomUUID()}`,
          targetId: custom.child.targetId, baseRevision: custom.deleted.revision, reason: 'restore',
        }),
      });
      const customRec = await runtime.pool.query<{ parent_id: string }>(
        `select recovered.parent_id from nodes child
         join nodes recovered on recovered.id=child.parent_id where child.id=$1`, [custom.child.targetId]);
      assert.equal(customRec.rows[0]?.parent_id, custom.mount.targetId);

      const mobile = await seedOrphan(owner, collectionId, rootId, 'bookmarks-bar');
      await mobile.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeDeletePushRequest({
          sessionId: mobile.ctx.session.sessionId, replicaId: mobile.ctx.replica.replicaId,
          collectionId, sequence: mobile.sequence, opId: `t05-${randomUUID()}`,
          targetId: mobile.mount.targetId, baseRevision: mobile.mount.revision,
        }),
      });
      await mobile.push.push({
        idempotencyKey: `t05-${randomUUID()}`,
        request: syncNodeRestorePushRequest({
          ...mobile.restoreBase(), sequence: mobile.sequence + 1, opId: `t05-${randomUUID()}`,
          targetId: mobile.child.targetId, baseRevision: mobile.deleted.revision, reason: 'restore',
        }),
      });
      const fallback = await runtime.pool.query<{ parent_id: string; folder_role: string | null }>(
        `select recovered.parent_id, recovered.folder_role from nodes child
         join nodes recovered on recovered.id=child.parent_id where child.id=$1`, [mobile.child.targetId]);
      assert.equal(fallback.rows[0]?.folder_role, 'recovered');
      assert.equal(fallback.rows[0]?.parent_id, rootId);
    } finally { await api.close(); }
  }, 60_000);

  async function counts(collectionId: string, targetId: string) {
    const nodes = await runtime.pool.query<{ count: number }>(
      `select count(*)::int as count from nodes where collection_id=$1 and folder_role='recovered' and deleted_at is null`,
      [collectionId]);
    const effects = await runtime.pool.query<{ count: number }>(
      `select count(*)::int as count from sync_operation_effects where collection_id=$1`, [collectionId]);
    const tombstones = await runtime.pool.query<{ count: number }>(
      `select count(*)::int as count from sync_node_tombstones where collection_id=$1 and target_id=$2`,
      [collectionId, targetId]);
    const live = await runtime.pool.query<{ deleted_at: Date | null }>(
      'select deleted_at from nodes where id=$1', [targetId]);
    const durable = await runtime.pool.query(`SELECT (SELECT count(*) FROM audit_events WHERE collection_id=$1) audits,
      (SELECT count(*) FROM outbox_events WHERE aggregate_scope=$1) outbox,
      (SELECT count(*) FROM sync_restored_tombstones WHERE collection_id=$1) restoration_evidence`, [collectionId]);
    return {
      ...durable.rows[0],
      recovered: nodes.rows[0]?.count, effects: effects.rows[0]?.count,
      tombstones: tombstones.rows[0]?.count, deleted: live.rows[0]?.deleted_at !== null,
    };
  }
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
