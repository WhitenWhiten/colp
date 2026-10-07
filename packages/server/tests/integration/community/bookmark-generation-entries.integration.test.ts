import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type { SyncPushResult } from '@know-n/colp/types';
import { createPostgresCollectionVersionUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublisherCanonicalMutationApplication } from '../../../src/infrastructure/publisher/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import {
  createCollectionVersion,
  restoreCollectionVersion,
  strongEntityTag,
  type RestoreCollectionVersionPorts,
} from '../../../src/modules/collections/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { mintExtensionCredentialHttpFixture } from '../../support/extension-credential.js';
import { isFetchForbiddenPort } from '../../support/fetch-port.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import {
  createPostgresPhase4bMcpWriteHarness,
  writeToolContext,
} from '../../support/postgres-phase4b-mcp-write-tools.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { createGenerationEntriesFixture } from './bookmark-generation-entries-helpers.js';

/*
 * CS-02 bookmark generation fence through every real URL-mutating entry.
 * The `community_bookmark_generations` trigger (migration
 * 202610012400_community_voting.ts) rotates the opaque generation on every
 * DISTINCT `nodes.url` write — this suite drives A→B→A through each
 * production entry that can change a bookmark URL:
 *
 * - product:   PATCH /api/v1/collections/:id/nodes/:nodeId (merge-patch
 *              route -> updateCollectionNode canonical mutation)
 * - MCP:       the nodes.update write tool (low-risk-node-update.ts accepts
 *              patch.url -> updateCollectionNode)
 * - publisher: the publisher canonical-mutation application —
 *              src/infrastructure/publisher/canonical-unit-of-work.ts is the
 *              production entry point and intentionally has no HTTP adapter,
 *              so the real application execute() is driven directly
 * - sync:      POST syncPush update_node_content over the real
 *              registerSyncPushRoutes route -> evaluateSyncNodeUpdate
 *              (sync-node-update.ts lists url in BOOKMARK_FIELDS) ->
 *              canonical update
 * - restore:   the collection-version unit of work behind
 *              POST /api/v1/collections/:id/versions/:versionId/restore —
 *              restore-collection-version-apply.ts rebuilds {title,url}
 *              patches through updateCollectionNode; here the snapshot@A,
 *              the A→B drift (real product PATCH), and the B→A restore are
 *              all genuine production writes
 *
 * Every entry must rotate the generation twice (never rewinding to a spent
 * value) and fence superseded-generation interactions: a vote replaying an
 * old generation is 409 revision_conflict and generation-bound comment
 * reads conceal to 404 — no vote or comment migrates to a new generation.
 */

const SYNC_ISSUER = 'https://issuer.example';
const SYNC_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const MCP_SCOPES = Object.freeze(['nodes:write', 'access:write', 'changes:commit', 'changes:cancel']);
const URL_A = 'https://alpha.example/path';
const URL_B = 'https://beta.example/other';

describeWithPostgres('CS-02 bookmark generation fence — all URL write entries', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_gen_entries', { maxConnections: 16 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  const {
    testConfig, startApp, seedAccount, seedEntryFixture, generationOf, nodeFacts,
    collectionContentRevision, bindInteractions, expectRotation,
    assertSupersededFenced, productPatchUrl,
  } = createGenerationEntriesFixture(() => isolated);

  test('product PATCH rotates A→B→A and fences superseded-generation interactions', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `ge-owner-${randomUUID()}`,
        handle: `go${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const seed = await seedEntryFixture(owner.subjectId, URL_A);
      const genA = await generationOf(seed.collectionId, seed.nodeId);
      assert.match(genA, /^bm-gen-/u);
      const inter = await bindInteractions(origin, config, factory, seed.collectionId, seed.nodeId);
      assert.equal(inter.target.generation, genA);

      await productPatchUrl(origin, config, owner, seed, URL_B);
      const genB = await expectRotation(inter, seed.collectionId, seed.nodeId, URL_B, [genA]);
      await assertSupersededFenced(inter, [genA]);

      await productPatchUrl(origin, config, owner, seed, URL_A);
      await expectRotation(inter, seed.collectionId, seed.nodeId, URL_A, [genA, genB]);
      await assertSupersededFenced(inter, [genA, genB]);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('MCP nodes.update rotates A→B→A and fences superseded-generation interactions', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      // The MCP write binding is a principalId credential (no browser
      // session); the collection owner_subject_id binds it.
      const principalId = randomBytes(16).toString('base64url');
      await seedAccount(principalId);
      const binding: McpAuthenticatedAuthorizationBinding = Object.freeze({
        kind: 'authenticated', principalId, clientId: 'ge-client',
        credentialBindingId: `ge-credential-${randomUUID()}`,
        resourceAudience: 'https://collections.example.test/collections/-/mcp',
        securityEpoch: 'epoch-1',
      });
      const bundle = createPostgresPhase4bMcpWriteHarness(
        isolated.runtime, binding, MCP_SCOPES).bundle;
      const seed = await seedEntryFixture(principalId, URL_A);
      const rewrite = async (url: string) => {
        const result = await bundle.adapter.callTool(
          writeToolContext(binding, MCP_SCOPES, 'nodes.update', seed.collectionId),
          { name: 'nodes.update',
            arguments: {
              collectionId: seed.collectionId, nodeId: seed.nodeId,
              baseRevision: (await nodeFacts(seed.collectionId, seed.nodeId)).revision,
              patch: { url },
            } });
        assert.equal(result.resultType, 'complete');
      };
      const genA = await generationOf(seed.collectionId, seed.nodeId);
      const inter = await bindInteractions(origin, config, factory, seed.collectionId, seed.nodeId);
      assert.equal(inter.target.generation, genA);

      await rewrite(URL_B);
      const genB = await expectRotation(inter, seed.collectionId, seed.nodeId, URL_B, [genA]);
      await assertSupersededFenced(inter, [genA]);

      await rewrite(URL_A);
      await expectRotation(inter, seed.collectionId, seed.nodeId, URL_A, [genA, genB]);
      await assertSupersededFenced(inter, [genA, genB]);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('publisher canonical update rotates A→B→A and fences superseded-generation interactions', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const principalId = randomBytes(16).toString('base64url');
      await seedAccount(principalId);
      const application = createPostgresPublisherCanonicalMutationApplication(isolated.runtime.db);
      const seed = await seedEntryFixture(principalId, URL_A);
      const rewrite = async (url: string) => {
        const outcome = await application.execute({
          binding: {
            namespace: 'colp.publisher.v0.1.nodes.update',
            principalId, idempotencyKey: `ge-publisher-${randomUUID()}`,
          },
          payload: { url, kind: 'bookmark' },
          collectionId: seed.collectionId,
          operationId: randomUUID(),
          mutation: {
            action: 'update',
            target: { collectionId: seed.collectionId, resourceId: seed.nodeId,
              resourceKind: 'node' },
            parentId: seed.rootId,
            expectedResourceRevision:
              (await nodeFacts(seed.collectionId, seed.nodeId)).revision,
            fields: { kindFields: {
              kind: 'bookmark', title: 'Bookmark', url, description: null,
              tags: [], visibility: 'inherit',
            }, extensions: {} },
          },
        });
        assert.equal(outcome.kind, 'executed');
      };
      const genA = await generationOf(seed.collectionId, seed.nodeId);
      const inter = await bindInteractions(origin, config, factory, seed.collectionId, seed.nodeId);
      assert.equal(inter.target.generation, genA);

      await rewrite(URL_B);
      const genB = await expectRotation(inter, seed.collectionId, seed.nodeId, URL_B, [genA]);
      await assertSupersededFenced(inter, [genA]);

      await rewrite(URL_A);
      await expectRotation(inter, seed.collectionId, seed.nodeId, URL_A, [genA, genB]);
      await assertSupersededFenced(inter, [genA, genB]);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('sync update_node_content rotates A→B→A and fences superseded-generation interactions', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    const syncApps: FastifyInstance[] = [];
    try {
      // The sync account resolves through account_identities (the
      // credential issuer/subject pair) and owns the collection.
      const accountId = randomBytes(16).toString('base64url');
      const subjectId = `ge-sync-subject-${randomUUID()}`;
      const oidcSubject = `ge-sync-oidc-${randomUUID()}`;
      await seedAccount(accountId);
      await isolated.runtime.pool.query(
        `update accounts set subject_id=$2 where id=$1`, [accountId, subjectId]);
      await isolated.runtime.pool.query(
        `insert into profile_handles(handle, account_id) values ($1, $2)`,
        [`ge_sync_${randomUUID().replaceAll('-', '').slice(0, 12)}`, accountId]);
      await isolated.runtime.pool.query(
        `insert into account_identities(id, account_id, issuer, subject)
         values ($1, $2, $3, $4)`,
        [`ge-identity-${randomUUID()}`, accountId, SYNC_ISSUER, oidcSubject]);

      const seed = await seedEntryFixture(subjectId, URL_A);
      // update_node_content's trusted base is sync_node_revision_history;
      // seed the base-revision row the push protocol requires.
      const baseRevision = (await nodeFacts(seed.collectionId, seed.nodeId)).revision;
      const payload = (await isolated.runtime.pool.query<{ payload_json: unknown }>(
        'select payload_json from nodes where id=$1', [seed.nodeId])).rows[0]!.payload_json;
      await isolated.runtime.pool.query(
        `insert into sync_node_revision_history
          (collection_id, resource_id, revision, kind, payload_json, commit_ordinal, operation_id)
         values ($1, $2, $3, 'bookmark', $4, 0, null)`,
        [seed.collectionId, seed.nodeId, baseRevision, payload]);

      const minted = await mintExtensionCredentialHttpFixture({
        issuer: SYNC_ISSUER, audience: 'known-api', clientId: 'known-extension',
        subject: oidcSubject, credentialId: `ge-credential-${randomUUID()}`,
      });
      const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
        deviceId: () => `ge-device-${randomUUID()}`,
        replicaId: () => `ge-replica-${randomUUID()}`,
        leaseId: () => `ge-lease-${randomUUID()}`,
      } }).create({
        accountId, collectionId: seed.collectionId,
        deviceName: 'GE device', replicaName: 'GE replica',
        kind: 'browser_extension',
        adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
        capabilities: { read: true, write: true, events: true, separator: true,
          alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
        binding: { browserProfileId: `ge-profile-${randomUUID()}`,
          mountMode: 'whole-profile', browserGeneration: `ge-generation-${randomUUID()}` },
        leaseDurationSeconds: 3_600,
      }, { actorAccountId: accountId });
      const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
        issuer: SYNC_ISSUER, audience: 'known-api', clientId: 'known-extension',
        replayEncryptionKey: Buffer.alloc(32, 43), replayEncryptionKeyVersion: 1,
        sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
        tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
        endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
      });
      const issued = await issuer.issue({
        credential: minted.credential, idempotencyKey: `ge-session-${randomUUID()}`,
        requestFingerprint: `ge-fingerprint-${randomUUID()}`,
        collectionId: seed.collectionId, replicaId: replica.replicaId,
        expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:push', 'sync:pull'],
        origin: SYNC_ORIGIN, protocolVersion: '0.1',
      });

      // The real push route, wired like the production composition.
      let syncOrigin = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const syncApp = Fastify({ logger: false });
        registerSyncPushRoutes(syncApp, {
          path: '/colp/sync/push', allowedOrigins: [SYNC_ORIGIN],
          credentialVerifier: minted.verifier,
          application: createPostgresSyncPushApplication(isolated.runtime.db, issuer, {}),
          rateLimit: { maxRequests: 100, windowMs: 60_000 },
          maxBatchOperations: 1, allowInsecureLoopback: true,
        });
        await syncApp.listen({ host: '127.0.0.1', port: 0 });
        const address = syncApp.server.address();
        if (address && typeof address !== 'string' && !isFetchForbiddenPort(address.port)) {
          syncApps.push(syncApp);
          syncOrigin = `http://127.0.0.1:${address.port}`;
          break;
        }
        await syncApp.close();
      }
      assert.notEqual(syncOrigin, '', 'the sync push app must bind a fetchable port');

      let sequence = 0;
      const rewrite = async (url: string) => {
        const current = await nodeFacts(seed.collectionId, seed.nodeId);
        sequence += 1;
        const response = await fetch(`${syncOrigin}/colp/sync/push`, {
          method: 'POST',
          headers: {
            authorization: minted.authorization,
            'idempotency-key': `ge-push-${randomUUID()}`,
            origin: SYNC_ORIGIN, 'content-type': 'application/json',
          },
          body: JSON.stringify(syncNodeUpdatePushRequest({
            sessionId: issued.session.sessionId, replicaId: replica.replicaId,
            collectionId: seed.collectionId, targetId: seed.nodeId,
            baseRevision: current.revision, sequence, opId: randomUUID(),
            base: { url: current.url }, value: { url },
          })),
        });
        assert.equal(response.status, 200);
        const body = await response.json() as SyncPushResult;
        assert.equal(body.results[0]?.status, 'applied');
      };

      const genA = await generationOf(seed.collectionId, seed.nodeId);
      const inter = await bindInteractions(origin, config, factory, seed.collectionId, seed.nodeId);
      assert.equal(inter.target.generation, genA);

      await rewrite(URL_B);
      const genB = await expectRotation(inter, seed.collectionId, seed.nodeId, URL_B, [genA]);
      await assertSupersededFenced(inter, [genA]);

      await rewrite(URL_A);
      await expectRotation(inter, seed.collectionId, seed.nodeId, URL_A, [genA, genB]);
      await assertSupersededFenced(inter, [genA, genB]);
    } finally {
      await Promise.all(syncApps.splice(0).map((syncApp) => syncApp.close()));
      await app.close();
    }
  }, 90_000);

  test('collection-version restore rotates A→B→A and fences superseded-generation interactions', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueTestSession({ factory,
        subject: `ge-restore-${randomUUID()}`,
        handle: `gr${randomUUID().replaceAll('-', '').slice(0, 12)}` });
      const seed = await seedEntryFixture(owner.subjectId, URL_A);
      const versionUnit = createPostgresCollectionVersionUnitOfWork(isolated.runtime.db);
      const genA = await generationOf(seed.collectionId, seed.nodeId);
      const inter = await bindInteractions(origin, config, factory, seed.collectionId, seed.nodeId);
      assert.equal(inter.target.generation, genA);

      const created = await versionUnit.execute((ports) => createCollectionVersion(
        ports,
        { actor: { principalId: owner.accountId, subjectId: owner.subjectId },
          commandId: randomUUID(), collectionId: seed.collectionId,
          ifMatch: strongEntityTag('c1') },
      ));
      assert.equal(created.kind, 'succeeded');
      if (created.kind !== 'succeeded') return;
      const versionId = created.version.versionId;

      await productPatchUrl(origin, config, owner, seed, URL_B);
      const genB = await expectRotation(inter, seed.collectionId, seed.nodeId, URL_B, [genA]);
      await assertSupersededFenced(inter, [genA]);

      const restoreEtag = strongEntityTag(
        await collectionContentRevision(seed.collectionId));
      const restored = await versionUnit.execute((ports) => restoreCollectionVersion(
        { ...(ports as RestoreCollectionVersionPorts) },
        { actor: { principalId: owner.accountId, subjectId: owner.subjectId },
          commandId: randomUUID(), collectionId: seed.collectionId,
          versionId, ifMatch: restoreEtag },
      ));
      assert.equal(restored.kind, 'succeeded');
      if (restored.kind !== 'succeeded') return;
      assert.equal(restored.receipt.noop, false,
        'restoring a tree whose live URL moved must apply a real delta');
      await expectRotation(inter, seed.collectionId, seed.nodeId, URL_A, [genA, genB]);
      await assertSupersededFenced(inter, [genA, genB]);
    } finally {
      await app.close();
    }
  }, 60_000);
});
