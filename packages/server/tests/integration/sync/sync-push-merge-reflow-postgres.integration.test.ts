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
  createPostgresSyncSessionHttpApplication,
} from '../../../src/infrastructure/sync/index.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { registerSyncSessionRoutes } from '../../../src/transport/colp-sync/sync-session-routes.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer T07-AUTHORIZATION-SECRET-MARKER';
const ACCOUNT = 'dG9yZWZsb3ctYWNjb3VudA';
const SUBJECT = 't07-reflow-subject';
const COLLECTION = 'dG9yZWZsb3ctY29sbGVjdA';
const ROOT = 't07-reflow-root';

describeWithPostgres('F011 merged Push results reflow authoritative content', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t07_merge_reflow', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date('2026-09-11T02:00:00.000Z');
    const collectionPayload = materializeCollectionPayload({
      id: COLLECTION, ownerSubjectId: SUBJECT, title: 'T-07 reflow', summary: null,
      kind: 'bookmarks', visibility: 'private', rootNodeId: ROOT,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1',
      policyRevision: 'policy-r1', commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
    });
    const rootPayload = materializeNodePayload({
      id: ROOT, collectionId: COLLECTION, parentId: null, kind: 'folder', isRoot: true,
      title: 'Root', url: null, description: null, tags: [], visibility: 'inherit',
      positionToken: null, resourceRevision: 'root-r1', childrenRevision: 'root-children-r1',
      createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(collectionPayload.ok, true); assert.equal(rootPayload.ok, true);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'T-07 owner')", [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('t07-identity',$1,$2,'t07-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('t07_owner',$1)", [ACCOUNT]);
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')",
        [COLLECTION, ROOT]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'T-07 reflow','bookmarks','private',$3,'collection-r1','content-r1',
          'policy-r1',0,$4,$4,$5,$6,'backfilled')`,
      [COLLECTION, SUBJECT, ROOT, now, collectionPayload.payload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,null,'folder',true,'Root',null,'inherit',null,'root-r1','root-children-r1',$3,$3,$4,$5,'backfilled')`,
      [ROOT, COLLECTION, now, rootPayload.payload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }, 30_000);

  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => {
    try { await app.close(); } catch { /* listener already closed */ }
  })));
  afterAll(async () => isolated?.close());

  async function seedBookmark(input: { readonly title?: string; readonly url?: string } = {}) {
    const id = `t07-bookmark-${randomUUID()}`;
    const revision = `t07-base-${randomUUID()}`;
    const childrenRevision = `children-${randomUUID()}`;
    const now = new Date('2026-09-11T02:10:00.000Z');
    const title = input.title ?? 'Reflow base';
    const url = input.url ?? 'https://example.test/base';
    const materialized = materializeNodePayload({
      id, collectionId: COLLECTION, parentId: ROOT, kind: 'bookmark', isRoot: false, title, url,
      description: null, tags: [], visibility: 'inherit', positionToken: `M${id.slice(-8)}`,
      resourceRevision: revision, childrenRevision,
      createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(materialized.ok, true);
    const payload = materialized.ok ? materialized.payload : {};
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [id]);
    await isolated.runtime.pool.query(`insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,
       resource_revision,children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,$3,'bookmark',false,$4,$5,'inherit',$6,$7,$8,$9,$9,$10,$11,'backfilled')`,
    [id, COLLECTION, ROOT, title, url, `M${id.slice(-8)}`, revision,
      childrenRevision, now, payload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'bookmark',$4,0,null)`, [COLLECTION, id, revision, payload]);
    return { id, revision, payload };
  }

  async function advanceCurrent(node: Awaited<ReturnType<typeof seedBookmark>>, values: Record<string, unknown>) {
    const revision = `t07-current-${randomUUID()}`;
    const payload = { ...node.payload, ...values, resourceRevision: revision,
      updatedAt: '2026-09-11T02:20:00Z' };
    await isolated.runtime.pool.query(`update nodes set title=$2,url=$3,resource_revision=$4,
      updated_at=$5,payload_json=$6 where id=$1`, [node.id, payload.title ?? null, payload.url ?? null,
      revision, new Date('2026-09-11T02:20:00.000Z'), payload]);
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'bookmark',$4,0,null)`, [COLLECTION, node.id, revision, payload]);
    return { ...node, revision, payload };
  }

  async function context() {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: 't07-oidc',
      credentialId: `t07-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `t07-device-${suffix}`, replicaId: () => `t07-replica-${suffix}`,
      leaseId: () => `t07-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'T-07 device', replicaName: 'T-07 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `t07-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `t07-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 43), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `t07-session-${suffix}`, requestFingerprint: `t07-fingerprint-${suffix}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:push', 'sync:pull'], origin: ORIGIN,
      protocolVersion: '0.1',
    });
    return { credential, replica, issuer, session: issued.session };
  }

  async function start(value: Awaited<ReturnType<typeof context>>) {
    const app = Fastify({ logger: false });
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
    registerSyncSessionRoutes(app, {
      path: '/private-entry/session-negotiation', allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncSessionHttpApplication(isolated.runtime.db, value.issuer),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, allowInsecureLoopback: true,
    });
    app.get('/.well-known/collection-protocol', async () => manifestFor(app));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    apps.push(app);
    return { app, origin: `http://127.0.0.1:${address.port}` };
  }

  function manifestFor(app: FastifyInstance): Manifest {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
      serverId: `${origin}/`, serverUuid: '019f97ff-2222-7222-8222-222222222222', title: 'Known',
      mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
        endpoints: {
          syncPush: `${origin}/private-entry/canonical-update`,
          syncSessions: `${origin}/private-entry/session-negotiation`,
        },
        features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
        auth: { anonymousRead: false, apiKeys: false, oauth: true,
          protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
        limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
          minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
    } as Manifest;
  }

  function blackBox(origin: string) {
    return createSyncSessionBlackBoxClient({
      manifestUrl: `${origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: AUTHORIZATION, origin: ORIGIN,
    });
  }

  function result(body: Problem | SyncPushResult): SyncPushResult {
    assert.ok('results' in body, `expected SyncPushResult, got ${JSON.stringify(body)}`);
    return body;
  }

  async function push(server: { readonly origin: string }, value: Awaited<ReturnType<typeof context>>,
    input: Parameters<typeof syncNodeUpdatePushRequest>[0], sequence: number) {
    const response = await blackBox(server.origin).push({
      idempotencyKey: `t07-push-${randomUUID()}`,
      request: syncNodeUpdatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, sequence, ...input,
      }),
    });
    return result(response.body).results[0];
  }

  test('sanity: a same-revision update applies', async () => {
    const value = await context();
    const server = await start(value);
    const node = await seedBookmark({ title: 'Base title', url: 'https://example.test/base' });
    const first = await push(server, value, {
      targetId: node.id, baseRevision: node.revision, opId: `t07-op-${randomUUID()}`,
      base: { title: 'Base title', url: 'https://example.test/base' },
      value: { title: 'Local edit', url: 'https://example.test/base' },
    }, 1);
    assert.equal(first?.status, 'applied');
    assert.deepEqual((first as { readonly transform?: unknown })?.transform,
      { title: 'Local edit', url: 'https://example.test/base' });
  });

  test('a rebased update returns the merged transform and a reflowed second edit applies', async () => {
    const value = await context();
    const server = await start(value);
    const node = await seedBookmark({ title: 'Base title', url: 'https://example.test/base' });
    // A competing writer lands between the client's snapshot and its push.
    const current = await advanceCurrent(node, { url: 'https://example.test/server' });

    const first = await push(server, value, {
      targetId: node.id, baseRevision: node.revision, opId: `t07-op-${randomUUID()}`,
      base: { title: 'Base title', url: 'https://example.test/base' },
      value: { title: 'Local edit', url: 'https://example.test/base' },
    }, 1);
    assert.equal(first?.status, 'rebased');
    // F011: the merged authoritative fields must come back on the receipt.
    assert.deepEqual((first as { readonly transform?: unknown })?.transform,
      { title: 'Local edit', url: 'https://example.test/server' });

    // A client that reflows the transform into its projection edits from the
    // authoritative base and merges cleanly — no sync_base_untrusted.
    const transform = (first as { readonly transform?: Record<string, unknown> }).transform!;
    const second = await push(server, value, {
      targetId: node.id, baseRevision: String(first?.revision), opId: `t07-op-${randomUUID()}`,
      base: transform, value: { ...transform, title: 'Second edit' },
    }, 2);
    assert.equal(second?.status, 'applied');
    assert.equal(second?.targetId, current.id);
  });

  test('without the reflow the stale local base still conflicts as sync_base_untrusted', async () => {
    const value = await context();
    const server = await start(value);
    const node = await seedBookmark({ title: 'Base title', url: 'https://example.test/base' });
    await advanceCurrent(node, { url: 'https://example.test/server' });

    const first = await push(server, value, {
      targetId: node.id, baseRevision: node.revision, opId: `t07-op-${randomUUID()}`,
      base: { title: 'Base title', url: 'https://example.test/base' },
      value: { title: 'Local edit', url: 'https://example.test/base' },
    }, 1);
    assert.equal(first?.status, 'rebased');

    // The pre-fix client kept `base + value`; pushing that stale projection
    // against the merged revision is the F011 pseudo-conflict.
    const stale = await push(server, value, {
      targetId: node.id, baseRevision: String(first?.revision), opId: `t07-op-${randomUUID()}`,
      base: { title: 'Local edit', url: 'https://example.test/base' },
      value: { title: 'Second edit', url: 'https://example.test/base' },
    }, 2);
    assert.equal(stale?.status, 'conflicted');
    const conflict = await isolated.runtime.pool.query<{ conflict_type: string }>(
      'select conflict_type from sync_conflicts where operation_id = $1', [stale?.opId]);
    assert.equal(conflict.rows[0]?.conflict_type, 'untrusted_base');
  });
});
