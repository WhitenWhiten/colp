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
  type PostgresSyncNodeCreateFaultPhase,
} from '../../../src/infrastructure/sync/index.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { syncNodeCreatePushRequest, syncPushAdmissionRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { recordPhase3SyncPushScenario } from '../../support/phase3-sync-push-acceptance-recorder.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-12-AUTHORIZATION-SECRET-MARKER';
const ACCOUNT = 'DAwMDAwMDAwMDAwMDAwMDA';
const SUBJECT = 'p3-12-subject';
const COLLECTION = 'cHBwcHBwcHBwcHBwcHBwcA';
const ROOT = 'p3-12-root';
const CHILD_FOLDER = 'p3-12-child-folder';
const FIRST = 'p3-12-first';
const LAST = 'p3-12-last';

describeWithPostgres('P3-12 real Fastify/PostgreSQL canonical Node creates', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_node_create', { maxConnections: 16 });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date('2026-07-26T01:00:00.000Z');
    const collectionPayload = materializeCollectionPayload({
      id: COLLECTION, ownerSubjectId: SUBJECT, title: 'P3-12 canonical', summary: null,
      kind: 'bookmarks', visibility: 'private', rootNodeId: ROOT,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1',
      policyRevision: 'policy-r1', commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
    });
    assert.equal(collectionPayload.ok, true);
    const nodePayload = (input: {
      id: string; parentId: string | null; kind: 'folder' | 'bookmark'; isRoot: boolean;
      title: string; url: string | null; position: string | null; revision: string; childrenRevision: string;
    }) => {
      const payload = materializeNodePayload({
        id: input.id, collectionId: COLLECTION, parentId: input.parentId, kind: input.kind,
        isRoot: input.isRoot, title: input.title, url: input.url, description: null, tags: [],
        visibility: 'inherit', positionToken: input.position, resourceRevision: input.revision,
        childrenRevision: input.childrenRevision, createdAt: now, updatedAt: now,
        deletedAt: null, deletedCommitOrdinal: null,
      });
      assert.equal(payload.ok, true);
      return payload.ok ? payload.payload : {};
    };
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'P3-12 owner')", [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('p3-12-identity',$1,$2,'p3-12-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('p3_12_owner',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node'),($4,'node'),($5,'node')`,
      [COLLECTION, ROOT, CHILD_FOLDER, FIRST, LAST]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'P3-12 canonical','bookmarks','private',$3,'collection-r1','content-r1',
          'policy-r1',0,$4,$4,$5,$6,'backfilled')`,
      [COLLECTION, SUBJECT, ROOT, now, collectionPayload.ok ? collectionPayload.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      for (const row of [
        { id: ROOT, parent: null, kind: 'folder', root: true, title: 'Root', url: null,
          position: null, revision: 'root-r1', children: 'root-children-r1' },
        { id: CHILD_FOLDER, parent: ROOT, kind: 'folder', root: false, title: 'Child', url: null,
          position: 'G', revision: 'child-r1', children: 'child-children-r1' },
        { id: FIRST, parent: ROOT, kind: 'bookmark', root: false, title: 'First',
          url: 'https://example.test/first', position: 'M', revision: 'first-r1', children: 'first-children-r1' },
        { id: LAST, parent: ROOT, kind: 'bookmark', root: false, title: 'Last',
          url: 'https://example.test/last', position: 't', revision: 'last-r1', children: 'last-children-r1' },
      ] as const) {
        await client.query(`insert into nodes
          (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
           children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
          values ($1,$2,$3,$4,$5,$6,$7,'inherit',$8,$9,$10,$11,$11,$12,$13,'backfilled')`, [
          row.id, COLLECTION, row.parent, row.kind, row.root, row.title, row.url, row.position,
          row.revision, row.children, now,
          nodePayload({ id: row.id, parentId: row.parent, kind: row.kind, isRoot: row.root,
            title: row.title, url: row.url, position: row.position, revision: row.revision,
            childrenRevision: row.children }), RESOURCE_PAYLOAD_SCHEMA_VERSION,
        ]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }, 20_000);

  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => {
    try { await app.close(); } catch { /* response-loss fixture may already close it */ }
  })));
  afterAll(async () => isolated?.close());

  async function context(role: 'owner' | 'editor' | 'viewer' = 'owner') {
    const suffix = randomUUID();
    const accountId = role === 'owner' ? ACCOUNT : `p3-12-${role}-${suffix}`;
    const subjectId = role === 'owner' ? SUBJECT : `p3-12-${role}-subject-${suffix}`;
    if (role !== 'owner') {
      await isolated.runtime.pool.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [accountId, subjectId]);
      await isolated.runtime.pool.query('insert into profile_handles(handle,account_id) values ($1,$2)',
        [`p3_12_${role}_${suffix}`, accountId]);
      await isolated.runtime.pool.query(`insert into account_identities(id,account_id,issuer,subject)
        values ($1,$2,$3,$4)`, [`p3-12-identity-${suffix}`, accountId, ISSUER, `p3-12-oidc-${suffix}`]);
      await isolated.runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
        values ($1,$2,$3)`, [COLLECTION, subjectId, role]);
    }
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: role === 'owner' ? 'p3-12-oidc' : `p3-12-oidc-${suffix}`,
      credentialId: `p3-12-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `p3-12-device-${suffix}`, replicaId: () => `p3-12-replica-${suffix}`,
      leaseId: () => `p3-12-lease-${suffix}`,
    } }).create({
      accountId, collectionId: COLLECTION, deviceName: 'P3-12 device', replicaName: 'P3-12 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: role !== 'viewer', events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `p3-12-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `p3-12-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: accountId });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 42), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `p3-12-session-${suffix}`, requestFingerprint: `p3-12-fingerprint-${suffix}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: role === 'viewer' ? ['sync:pull'] : ['sync:push'], origin: ORIGIN,
    });
    return { credential, replica, issuer, session: issued.session };
  }

  async function start(value: Awaited<ReturnType<typeof context>>, options: {
    readonly nodeId?: () => string;
    readonly managedBookmarkWrites?: boolean;
    readonly failAt?: PostgresSyncNodeCreateFaultPhase;
    readonly responseGate?: Promise<void>;
    readonly onResponseReady?: () => void;
  } = {}) {
    const app = Fastify({ logger: false });
    if (options.responseGate) app.addHook('onSend', async (request, _reply, payload) => {
      if (request.url === '/private-entry/canonical-create') {
        options.onResponseReady?.();
        await options.responseGate;
      }
      return payload;
    });
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-create', allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(isolated.runtime.db, value.issuer, {
        ...(options.nodeId ? { nodeId: options.nodeId } : {}),
        managedBookmarkWrites: options.managedBookmarkWrites ?? false,
        ...(options.failAt ? { faultInjector: { afterPhase(phase) {
          if (phase === options.failAt) throw new Error(`P3-12 injected ${phase}`);
        } } } : {}),
      }),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1,
      allowInsecureLoopback: true,
    });
    app.get('/.well-known/collection-protocol', async () => manifestFor(app));
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    return { app, origin: `http://127.0.0.1:${address.port}` };
  }

  function blackBox(origin: string, fetchImplementation?: typeof fetch) {
    return createSyncSessionBlackBoxClient({
      manifestUrl: `${origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: AUTHORIZATION, origin: ORIGIN,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  function result(body: Problem | SyncPushResult): SyncPushResult {
    assert.ok('results' in body, `expected SyncPushResult, got ${'code' in body ? body.code : 'unknown'}`);
    return body;
  }

  function problem(body: Problem | SyncPushResult): Problem {
    assert.ok('code' in body, 'expected COLP Problem');
    return body;
  }

  async function facts(replicaId: string, nodeId?: string) {
    const response = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_lanes where replica_id=$1) lanes,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts,
      (select count(*)::int from operations where collection_id=$2) operations,
      (select count(*)::int from resource_revisions where collection_id=$2) resource_revisions,
      (select count(*)::int from children_revisions where collection_id=$2) children_revisions,
      (select count(*)::int from audit_events where collection_id=$2 and operation_id is not null) audits,
      (select count(*)::int from outbox_events where aggregate_scope=$2) outbox,
      (select count(*)::int from resource_id_ledger) ledger,
      (select to_jsonb(n) from nodes n where n.id=$3) node,
      (select payload_json from operation_payloads where operation_id=(select operation_id from sync_sequence_receipts
        where replica_id=$1 order by sequence_number desc limit 1)) operation_payload,
      (select effect_json from sync_operation_effects where operation_id=(select operation_id from sync_sequence_receipts
        where replica_id=$1 order by sequence_number desc limit 1)) operation_effect,
      (select result_json from sync_sequence_receipts where replica_id=$1 order by sequence_number desc limit 1) receipt
    `, [replicaId, COLLECTION, nodeId ?? 'missing']);
    return response.rows[0];
  }

  test('creates Folder, Bookmark, and Separator at root/child and first/middle/final positions', async () => {
    const value = await context();
    const ids = ['p3-12-created-folder', 'p3-12-created-bookmark', 'p3-12-created-separator',
      'p3-12-created-middle', 'p3-12-created-final'];
    const server = await start(value, { nodeId: () => ids.shift()! });
    const cases = [
      { parentId: ROOT, beforeId: CHILD_FOLDER, node: { kind: 'folder', title: 'Created folder' } },
      { parentId: 'p3-12-created-folder', node: { kind: 'bookmark', title: 'Child bookmark',
        url: 'https://example.test/child' } },
      { parentId: ROOT, afterId: CHILD_FOLDER, beforeId: FIRST,
        node: { kind: 'separator', extensions: { 'https://extensions.example/p3-12': { nested: ['exact'] } } } },
      { parentId: ROOT, afterId: FIRST, beforeId: LAST,
        node: { kind: 'bookmark', title: 'Middle', url: 'https://example.test/middle' } },
      { parentId: ROOT, afterId: LAST,
        node: { kind: 'bookmark', title: 'Final', url: 'https://example.test/final' } },
    ] as const;
    for (const [index, item] of cases.entries()) {
      const request = syncNodeCreatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, sequence: index + 1, opId: `p3-12-create-op-${index + 1}`,
        parentId: item.parentId, ...('afterId' in item ? { afterId: item.afterId } : {}),
        ...('beforeId' in item ? { beforeId: item.beforeId } : {}), node: item.node,
      });
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-12-key-${index + 1}`, request });
      assert.equal(response.status, 200,
        `create case ${index + 1}: ${'code' in response.body ? response.body.code : 'unexpected response'}`);
      const applied = result(response.body).results[0]!;
      assert.equal(applied.status, 'applied');
      assert.equal(applied.targetId, `p3-12-created-${['folder', 'bookmark', 'separator', 'middle', 'final'][index]}`);
      assert.ok(applied.revision);
      assert.ok(applied.cursor);
    }
    const ordered = await isolated.runtime.pool.query(`select id,kind,position_token,payload_json
      from nodes where collection_id=$1 and parent_id=$2 and deleted_at is null
      order by position_token collate "C"`, [COLLECTION, ROOT]);
    assert.deepEqual(ordered.rows.map((row) => row.id), [
      'p3-12-created-folder', CHILD_FOLDER, 'p3-12-created-separator', FIRST,
      'p3-12-created-middle', LAST, 'p3-12-created-final',
    ]);
    const separator = ordered.rows.find((row) => row.id === 'p3-12-created-separator');
    assert.equal(separator.kind, 'separator');
    assert.deepEqual(separator.payload_json.extensions,
      { 'https://extensions.example/p3-12': { nested: ['exact'] } });
    assert.equal(Object.hasOwn(separator.payload_json, 'title'), false);
    const manifest = await fetch(`${server.origin}/.well-known/collection-protocol`).then(
      async (response) => response.json() as Promise<Manifest>,
    );
    assert.ok(manifest.mounts.every((mount) => !mount.profiles.includes('sync')));
    const ownership = (await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts,
      (select count(*)::int from operations where operation_id=any($2::text[])) operations`,
    [value.replica.replicaId, cases.map((_, index) => `p3-12-create-op-${index + 1}`)])).rows[0];
    assert.deepEqual(ownership, { claims: 5, receipts: 5, operations: 5 });
    recordPhase3SyncPushScenario('create_folder');
    recordPhase3SyncPushScenario('create_bookmark');
    recordPhase3SyncPushScenario('create_separator');
    recordPhase3SyncPushScenario('single_sequence_owner');
    recordPhase3SyncPushScenario('manifest_sync_unclaimed');
  });

  test('persists an immutable exact result and single canonical side effects across restart/replay', async () => {
    const value = await context();
    const nodeId = `p3-12-replay-node-${randomUUID()}`;
    const firstServer = await start(value, { nodeId: () => nodeId });
    const request = syncNodeCreatePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, opId: `p3-12-replay-op-${randomUUID()}`, parentId: ROOT,
      node: { kind: 'bookmark', title: 'REPLAY-TITLE-SECRET-MARKER',
        url: 'https://example.test/REPLAY-URL-SECRET-MARKER',
        extensions: { 'https://extensions.example/secret-marker': { exact: 'EXTENSION-SECRET-MARKER' } } },
    });
    const first = await blackBox(firstServer.origin).push({ idempotencyKey: 'p3-12-replay-key', request });
    const afterFirst = await facts(value.replica.replicaId, nodeId);
    await firstServer.app.close();
    const restarted = await start(value, { nodeId: () => assert.fail('replay must not mint a second Node ID') });
    const replay = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-12-replay-key', request });
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(value.replica.replicaId, nodeId), afterFirst);
    assert.deepEqual(afterFirst.receipt, first.body);
    assert.equal(afterFirst.node.payload_json.resourceRevision, result(first.body).results[0]!.revision);
    assert.deepEqual(afterFirst.node.payload_json.extensions,
      { 'https://extensions.example/secret-marker': { exact: 'EXTENSION-SECRET-MARKER' } });
    assert.equal(afterFirst.operation_payload.resourceId, nodeId);
    assert.deepEqual(afterFirst.operation_payload.extensions,
      { 'https://extensions.example/secret-marker': { exact: 'EXTENSION-SECRET-MARKER' } });
    assert.equal(afterFirst.operation_effect.kind, 'node_created');
    assert.deepEqual(afterFirst.operation_effect.node.extensions,
      { 'https://extensions.example/secret-marker': { exact: 'EXTENSION-SECRET-MARKER' } });
  });

  test('keeps unsupported operations, viewer, wrong parent, stale anchor, and managed bookmark default at zero mutation', async () => {
    const value = await context();
    const server = await start(value, { nodeId: () => `p3-12-denied-${randomUUID()}` });
    const before = await facts(value.replica.replicaId);
    const deniedRequests = [
      syncPushAdmissionRequest({ type: 'update_collection_metadata', sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `p3-12-update-${randomUUID()}` }),
      syncNodeCreatePushRequest({ sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `p3-12-parent-${randomUUID()}`, parentId: 'other-collection-secret' }),
      syncNodeCreatePushRequest({ sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `p3-12-anchor-${randomUUID()}`, parentId: ROOT, afterId: 'missing-anchor' }),
      syncNodeCreatePushRequest({ sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId: `p3-12-managed-${randomUUID()}`, parentId: ROOT,
        node: { kind: 'folder', title: 'Managed', folderRole: 'managed-bookmarks' } }),
    ];
    const codes: string[] = [];
    for (const [index, request] of deniedRequests.entries()) {
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-12-denied-key-${index}`, request });
      assert.notEqual(response.status, 200);
      codes.push(problem(response.body).code);
      assert.deepEqual(await facts(value.replica.replicaId), before);
    }
    assert.deepEqual(codes, ['unsupported_operation', 'resource_not_found', 'position_context_stale', 'node_read_only']);

    const viewer = await context('viewer');
    const viewerServer = await start(viewer);
    const viewerBefore = await facts(viewer.replica.replicaId);
    const viewerResponse = await blackBox(viewerServer.origin).push({
      idempotencyKey: 'p3-12-viewer', request: syncNodeCreatePushRequest({
        sessionId: viewer.session.sessionId, replicaId: viewer.replica.replicaId,
        collectionId: COLLECTION, opId: `p3-12-viewer-${randomUUID()}`, parentId: ROOT,
      }),
    });
    assert.notEqual(viewerResponse.status, 200);
    assert.deepEqual(await facts(viewer.replica.replicaId), viewerBefore);
  });

  test('database ledger is the final same-ID winner under two real concurrent connections', async () => {
    const left = await context();
    const right = await context();
    const sameId = `p3-12-race-node-${randomUUID()}`;
    const leftServer = await start(left, { nodeId: () => sameId });
    const rightServer = await start(right, { nodeId: () => sameId });
    const make = (value: typeof left, opId: string) => syncNodeCreatePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, opId, parentId: ROOT,
      node: { kind: 'bookmark', title: 'Concurrent', url: 'https://example.test/concurrent' },
    });
    const [one, two] = await Promise.all([
      blackBox(leftServer.origin).push({ idempotencyKey: 'p3-12-race-left',
        request: make(left, `p3-12-race-left-${randomUUID()}`) }),
      blackBox(rightServer.origin).push({ idempotencyKey: 'p3-12-race-right',
        request: make(right, `p3-12-race-right-${randomUUID()}`) }),
    ]);
    const outcomes = [result(one.body).results[0]!, result(two.body).results[0]!];
    assert.equal(outcomes.filter((item) => item.status === 'applied').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected'
      && item.code === 'resource_id_unavailable').length, 1);
    const rows = await isolated.runtime.pool.query('select id from nodes where id=$1', [sameId]);
    assert.equal(rows.rowCount, 1);
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from resource_id_ledger where resource_id=$1', [sameId])).rows[0].count, 1);
  });

  test('replays a terminal historical cross-kind ID conflict without reviving or overwriting it', async () => {
    const value = await context();
    const historicalId = `p3-12-historical-${randomUUID()}`;
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection')",
      [historicalId],
    );
    const server = await start(value, { nodeId: () => historicalId });
    const request = syncNodeCreatePushRequest({
      sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId,
      collectionId: COLLECTION,
      opId: `p3-12-historical-op-${randomUUID()}`,
      parentId: ROOT,
      node: { kind: 'folder', title: 'Must not overwrite historical identity' },
    });
    const first = await blackBox(server.origin).push({ idempotencyKey: 'p3-12-historical-key', request });
    assert.equal(first.status, 200);
    assert.equal(result(first.body).results[0]?.status, 'rejected');
    assert.equal(result(first.body).results[0]?.code, 'resource_id_unavailable');
    const afterFirst = await facts(value.replica.replicaId, historicalId);
    assert.equal(afterFirst.node, null);
    assert.equal(afterFirst.receipts, 1);
    const replay = await blackBox(server.origin).push({ idempotencyKey: 'p3-12-historical-key', request });
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(value.replica.replicaId, historicalId), afterFirst);
    const ledger = await isolated.runtime.pool.query(
      'select resource_type from resource_id_ledger where resource_id=$1', [historicalId],
    );
    assert.deepEqual(ledger.rows, [{ resource_type: 'collection' }]);
  });

  test('serializes two real connections at one anchor without duplicate positions or ordinals', async () => {
    const left = await context();
    const right = await context();
    const leftId = `p3-12-position-left-${randomUUID()}`;
    const rightId = `p3-12-position-right-${randomUUID()}`;
    const leftServer = await start(left, { nodeId: () => leftId });
    const rightServer = await start(right, { nodeId: () => rightId });
    const make = (value: typeof left, opId: string) => syncNodeCreatePushRequest({
      sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId,
      collectionId: COLLECTION,
      opId,
      parentId: ROOT,
      afterId: LAST,
      node: { kind: 'bookmark', title: 'Position race', url: 'https://example.test/position-race' },
    });
    const [one, two] = await Promise.all([
      blackBox(leftServer.origin).push({ idempotencyKey: 'p3-12-position-left',
        request: make(left, `p3-12-position-left-op-${randomUUID()}`) }),
      blackBox(rightServer.origin).push({ idempotencyKey: 'p3-12-position-right',
        request: make(right, `p3-12-position-right-op-${randomUUID()}`) }),
    ]);
    assert.deepEqual([one.status, two.status], [200, 200]);
    const rows = await isolated.runtime.pool.query(`select id,position_token from nodes
      where id=any($1::text[]) order by position_token collate "C"`, [[leftId, rightId]]);
    assert.equal(rows.rowCount, 2);
    assert.equal(new Set(rows.rows.map((row) => row.position_token)).size, 2);
    const operations = await isolated.runtime.pool.query(`select commit_ordinal from operations
      where operation_id=any($1::text[]) order by commit_ordinal`, [
      [result(one.body).results[0]!.opId, result(two.body).results[0]!.opId],
    ]);
    assert.equal(operations.rowCount, 2);
    assert.equal(new Set(operations.rows.map((row) => String(row.commit_ordinal))).size, 2);
    const duplicates = await isolated.runtime.pool.query(`select position_token,count(*)::int count from nodes
      where collection_id=$1 and parent_id=$2 and deleted_at is null
      group by position_token having count(*) > 1`, [COLLECTION, ROOT]);
    assert.equal(duplicates.rowCount, 0);
  });

  test('requires deployment enablement and transaction-local Replica write capability for managed folders', async () => {
    const owner = await context();
    const ownerServer = await start(owner, {
      managedBookmarkWrites: true,
      nodeId: () => `p3-12-managed-enabled-${randomUUID()}`,
    });
    const managed = (value: typeof owner, opId: string) => syncNodeCreatePushRequest({
      sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId,
      collectionId: COLLECTION,
      opId,
      parentId: ROOT,
      node: { kind: 'folder', title: 'Managed enabled', folderRole: 'managed-bookmarks' },
    });
    const created = await blackBox(ownerServer.origin).push({
      idempotencyKey: 'p3-12-managed-enabled',
      request: managed(owner, `p3-12-managed-owner-${randomUUID()}`),
    });
    assert.equal(created.status, 200);
    assert.equal(result(created.body).results[0]?.status, 'applied');

    const viewer = await context('viewer');
    const viewerServer = await start(viewer, { managedBookmarkWrites: true });
    const before = await facts(viewer.replica.replicaId);
    const denied = await blackBox(viewerServer.origin).push({
      idempotencyKey: 'p3-12-managed-viewer',
      request: managed(viewer as typeof owner, `p3-12-managed-viewer-${randomUUID()}`),
    });
    assert.notEqual(denied.status, 200);
    assert.deepEqual(await facts(viewer.replica.replicaId), before);
  });

  test('faults through effect persistence and before receipt finalize roll back the complete transaction', async () => {
    for (const phase of ['ledger', 'node', 'operation', 'effect_built', 'effect_persisted',
      'effect_pages_persisted', 'before_receipt_finalize'] as const) {
      const value = await context();
      const nodeId = `p3-12-fault-${phase}-${randomUUID()}`;
      const before = await facts(value.replica.replicaId, nodeId);
      const server = await start(value, { nodeId: () => nodeId, failAt: phase });
      const response = await blackBox(server.origin).push({
        idempotencyKey: `p3-12-fault-${phase}`, request: syncNodeCreatePushRequest({
          sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
          collectionId: COLLECTION, opId: `p3-12-fault-op-${phase}-${randomUUID()}`, parentId: ROOT,
        }),
      });
      assert.notEqual(response.status, 200);
      assert.deepEqual(await facts(value.replica.replicaId, nodeId), before, phase);
    }
  });

  test('commit-after-response-loss replays the same result without a second canonical mutation', async () => {
    const value = await context();
    const nodeId = `p3-12-loss-node-${randomUUID()}`;
    let release!: () => void;
    let responseReady!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { responseReady = resolve; });
    const lossy = await start(value, {
      nodeId: () => nodeId,
      responseGate: gate,
      onResponseReady: responseReady,
    });
    const request = syncNodeCreatePushRequest({ sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId, collectionId: COLLECTION,
      opId: `p3-12-loss-op-${randomUUID()}`, parentId: ROOT });
    const controller = new AbortController();
    const pending = blackBox(lossy.origin, (input, init) => fetch(input, { ...init, signal: controller.signal }))
      .push({ idempotencyKey: 'p3-12-loss-key', request });
    await ready;
    controller.abort();
    release();
    await assert.rejects(pending, /abort/iu);
    await lossy.app.close();
    const committed = await facts(value.replica.replicaId, nodeId);
    assert.equal(committed.receipts, 1);
    const restarted = await start(value, { nodeId: () => assert.fail('retry must use persisted receipt') });
    const replay = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-12-loss-key', request });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, committed.receipt);
    assert.deepEqual(await facts(value.replica.replicaId, nodeId), committed);
  }, 20_000);
});

function manifestFor(app: FastifyInstance): Manifest {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f97ff-1212-7121-8121-121212121212', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncPush: `${origin}/private-entry/canonical-create` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
  } as Manifest;
}
