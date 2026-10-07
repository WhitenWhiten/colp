import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPushResult } from '@know-n/colp/types';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/*
 * CS-01/CS-02 bookmark generation fencing through the real sync push entry
 * (POST syncPush → `update_node_content` → canonical merge/write over
 * PostgreSQL):
 *
 * - A semantic URL rewrite A→B rotates the minted `bm-gen-*` generation;
 *   pushing B→A mints another — never a rewind.
 * - A normalization-equivalent rewrite is pinned to the stored raw URL by
 *   `pinEquivalentBookmarkUrlMerge`, so the canonical write keeps the
 *   original spelling and the generation survives.
 */

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer CS-FENCE-AUTHORIZATION-SECRET-MARKER';
const ACCOUNT = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ';
const SUBJECT = 'gen-fence-subject';
const COLLECTION = 'cXFxcXFxcXFxcXFxcXFxcQ';
const ROOT = 'gen-fence-root';
const NOW = new Date('2026-09-10T02:00:00.000Z');

describeWithPostgres('CS-02 bookmark generation fence via sync push', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_gen_fence_sync', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    const collectionPayload = materializeCollectionPayload({
      id: COLLECTION, ownerSubjectId: SUBJECT, title: 'Sync fence', summary: null,
      kind: 'bookmarks', visibility: 'private', rootNodeId: ROOT,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1',
      policyRevision: 'policy-r1', commitOrdinal: 0n, createdAt: NOW, updatedAt: NOW,
      deletedAt: null,
    });
    assert.equal(collectionPayload.ok, true);
    const rootPayload = materializeNodePayload({
      id: ROOT, collectionId: COLLECTION, parentId: null, kind: 'folder', isRoot: true,
      title: 'Root', url: null, description: null, tags: [], visibility: 'inherit',
      positionToken: null, resourceRevision: 'root-r1', childrenRevision: 'root-children-r1',
      createdAt: NOW, updatedAt: NOW, deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(rootPayload.ok, true);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')",
        [ACCOUNT, SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'Fence owner')",
        [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('gen-fence-identity',$1,$2,'gen-fence-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('gen_fence_owner',$1)",
        [ACCOUNT]);
      await client.query(
        "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')",
        [COLLECTION, ROOT]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'Sync fence','bookmarks','private',$3,'collection-r1','content-r1',
          'policy-r1',0,$4,$4,$5,$6,'backfilled')`,
      [COLLECTION, SUBJECT, ROOT, NOW,
        collectionPayload.ok ? collectionPayload.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,null,'folder',true,'Root',null,'inherit',null,'root-r1','root-children-r1',$3,$3,$4,$5,'backfilled')`,
      [ROOT, COLLECTION, NOW,
        rootPayload.ok ? rootPayload.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }, 120_000);
  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => {
    try { await app.close(); } catch { /* already closed */ }
  })));
  afterAll(async () => isolated?.close());

  async function seedBookmark(url: string) {
    const id = `gen-fence-${randomUUID()}`;
    const revision = `gen-fence-base-${randomUUID()}`;
    const childrenRevision = `children-${randomUUID()}`;
    const materialized = materializeNodePayload({
      id, collectionId: COLLECTION, parentId: ROOT, kind: 'bookmark', isRoot: false,
      title: 'Fence bookmark', url, description: null, tags: [], visibility: 'inherit',
      positionToken: `M${id.slice(-8)}`, resourceRevision: revision,
      childrenRevision,
      createdAt: NOW, updatedAt: NOW, deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(materialized.ok, true);
    const payload = materialized.ok ? materialized.payload : {};
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [id]);
    await isolated.runtime.pool.query(`insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,
       resource_revision,children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,$3,'bookmark',false,'Fence bookmark',$4,null,'[]'::jsonb,'inherit',$5,$6,$7,$8,$8,$9,$10,'backfilled')`,
    [id, COLLECTION, ROOT, url, `M${id.slice(-8)}`, revision, childrenRevision,
      NOW, payload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'bookmark',$4,0,null)`, [COLLECTION, id, revision, payload]);
    return { id, revision };
  }

  async function context() {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: 'gen-fence-oidc',
      credentialId: `gen-fence-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `gen-fence-device-${suffix}`, replicaId: () => `gen-fence-replica-${suffix}`,
      leaseId: () => `gen-fence-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Fence device',
      replicaName: 'Fence replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `gen-fence-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `gen-fence-generation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 43), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `gen-fence-session-${suffix}`,
      requestFingerprint: `gen-fence-fingerprint-${suffix}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:push', 'sync:pull'], origin: ORIGIN,
      protocolVersion: '0.1',
    });
    return { credential, replica, issuer, session: issued.session };
  }

  function manifestFor(app: FastifyInstance): Manifest {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
      serverId: `${origin}/`, serverUuid: '019f97ff-1313-7131-8131-131313131313', title: 'Known',
      mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
        endpoints: { syncPush: `${origin}/private-entry/canonical-update` },
        features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
        auth: { anonymousRead: false, apiKeys: false, oauth: true,
          protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
        limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
          minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
    } as Manifest;
  }

  async function start(value: Awaited<ReturnType<typeof context>>) {
    const app = Fastify({ logger: false });
    app.get('/.well-known/collection-protocol', async () => manifestFor(app));
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-update', allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(isolated.runtime.db, value.issuer, {
        conflictPayloadEncryption: { key: Buffer.alloc(32, 71), keyVersion: 7 },
      }),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1,
      allowInsecureLoopback: true,
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    return { app, origin };
  }

  function blackBox(origin: string) {
    return createSyncSessionBlackBoxClient({
      manifestUrl: `${origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: AUTHORIZATION, origin: ORIGIN,
    });
  }

  function resultOf(body: Problem | SyncPushResult): SyncPushResult {
    assert.ok('results' in body, `expected SyncPushResult, got ${'code' in body ? body.code : 'unknown'}`);
    return body;
  }

  async function generationOf(nodeId: string): Promise<string> {
    const row = (await isolated.runtime.pool.query<{ generation: string }>(
      `select generation from community_bookmark_generations
       where collection_id=$1 and node_id=$2`, [COLLECTION, nodeId])).rows[0];
    assert.ok(row, 'a stored bookmark always owns a generation row');
    return row.generation;
  }

  async function storedUrl(nodeId: string): Promise<string> {
    const row = (await isolated.runtime.pool.query<{ url: string }>(
      'select url from nodes where id=$1', [nodeId])).rows[0];
    assert.ok(row);
    return row.url;
  }

  test('sync update_node_content rotates A→B→A and pins equivalent rewrites', async () => {
    const urlA = 'https://sync.example/original';
    const urlB = 'https://sync.example/moved';
    const node = await seedBookmark(urlA);
    const value = await context();
    const server = await start(value);

    const push = async (fromUrl: string, toUrl: string, baseRevision: string, sequence: number) => {
      const response = await blackBox(server.origin).push({
        idempotencyKey: `gen-fence-push-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({
          sessionId: value.session.sessionId,
          replicaId: value.replica.replicaId,
          collectionId: COLLECTION,
          targetId: node.id,
          baseRevision,
          sequence,
          opId: `gen-fence-op-${randomUUID()}`,
          base: { url: fromUrl },
          value: { url: toUrl },
        }),
      });
      assert.equal(response.status, 200,
        `sync push should succeed, got ${'code' in (response.body as Problem) ? (response.body as Problem).code : 'unknown'}`);
      const result = resultOf(response.body).results[0];
      assert.ok(result?.status === 'applied' || result?.status === 'rebased');
      assert.ok(result.revision, 'the push receipt carries the new base revision');
      return result.revision!;
    };

    const genA = await generationOf(node.id);

    // A→B: the canonical write rotates the minted generation.
    const revB = await push(urlA, urlB, node.revision, 1);
    assert.equal(await storedUrl(node.id), urlB);
    const genB = await generationOf(node.id);
    assert.notEqual(genB, genA, 'the A→B sync push must rotate the generation');

    // B→A: pushing the URL back mints another opaque generation.
    const revA2 = await push(urlB, urlA, revB, 2);
    assert.equal(await storedUrl(node.id), urlA);
    const genA2 = await generationOf(node.id);
    assert.notEqual(genA2, genB, 'the B→A sync push must mint a fresh generation');
    assert.notEqual(genA2, genA, 'the fence never rewinds to a spent generation');

    // A normalization-equivalent rewrite is pinned to the stored raw URL:
    // the canonical write keeps the original spelling, no DISTINCT url
    // reaches the trigger, and the generation survives.
    await push(urlA, `${urlA}/`, revA2, 3);
    assert.equal(await storedUrl(node.id), urlA,
      'the equivalent rewrite is pinned to the stored raw spelling');
    assert.equal(await generationOf(node.id), genA2,
      'a normalization-equivalent sync rewrite preserves the generation');
  }, 60_000);
});
