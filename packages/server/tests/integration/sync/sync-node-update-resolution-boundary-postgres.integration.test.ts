import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  ConflictResolutionRequest,
  Manifest,
  Problem,
  SyncPushResult,
} from '@know-n/colp/types';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncConflictResolutionApplication,
  createPostgresSyncPullReadPort,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
  createPostgresSyncSessionHttpApplication,
  type PostgresSyncConflictFaultPhase,
  type PostgresSyncConflictResolutionFaultPhase,
  type PostgresSyncNodeDeleteFaultPhase,
  type PostgresSyncNodeMoveFaultPhase,
  type PostgresSyncNodeUpdateFaultPhase,
  type PostgresSyncPushFaultPhase,
} from '../../../src/infrastructure/sync/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../../../src/infrastructure/outbox/index.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { registerSyncConflictRoutes } from '../../../src/transport/colp-sync/sync-conflict-routes.js';
import { registerSyncPullRoutes } from '../../../src/transport/colp-sync/sync-pull-routes.js';
import { registerSyncSessionRoutes } from '../../../src/transport/colp-sync/sync-session-routes.js';
import {
  createSyncPullCursorKeyring,
  SyncConflictResolutionError,
} from '../../../src/modules/sync/index.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { isFetchForbiddenPort } from '../../support/fetch-port.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-13-AUTHORIZATION-SECRET-MARKER';
const ACCOUNT = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ';
const SUBJECT = 'p3-13-subject';
const COLLECTION = 'cXFxcXFxcXFxcXFxcXFxcQ';
const ROOT = 'p3-13-root';

type NodeKind = 'folder' | 'bookmark' | 'separator';

describeWithPostgres('P3-18 conflict resolution rechecks and fault boundaries', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_node_resolve', { maxConnections: 20 });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date('2026-07-26T02:00:00.000Z');
    const collectionPayload = materializeCollectionPayload({
      id: COLLECTION, ownerSubjectId: SUBJECT, title: 'P3-13 canonical', summary: null,
      kind: 'bookmarks', visibility: 'private', rootNodeId: ROOT,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1',
      policyRevision: 'policy-r1', commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
    });
    assert.equal(collectionPayload.ok, true);
    const rootPayload = materializeNodePayload({
      id: ROOT, collectionId: COLLECTION, parentId: null, kind: 'folder', isRoot: true,
      title: 'Root', url: null, description: null, tags: [], visibility: 'inherit',
      positionToken: null, resourceRevision: 'root-r1', childrenRevision: 'root-children-r1',
      createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(rootPayload.ok, true);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'P3-13 owner')", [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('p3-13-identity',$1,$2,'p3-13-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('p3_13_owner',$1)", [ACCOUNT]);
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')",
        [COLLECTION, ROOT]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'P3-13 canonical','bookmarks','private',$3,'collection-r1','content-r1',
          'policy-r1',0,$4,$4,$5,$6,'backfilled')`,
      [COLLECTION, SUBJECT, ROOT, now, collectionPayload.ok ? collectionPayload.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,null,'folder',true,'Root',null,'inherit',null,'root-r1','root-children-r1',$3,$3,$4,$5,'backfilled')`,
      [ROOT, COLLECTION, now, rootPayload.ok ? rootPayload.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
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

  async function seedNode(kind: NodeKind, input: {
    readonly title?: string;
    readonly url?: string;
    readonly description?: string | null;
    readonly extensions?: Record<string, unknown>;
    readonly parentId?: string;
  } = {}) {
    const id = `p3-13-${kind}-${randomUUID()}`;
    const revision = `p3-13-base-${randomUUID()}`;
    const childrenRevision = `children-${randomUUID()}`;
    const now = new Date('2026-07-26T02:10:00.000Z');
    const title = kind === 'separator' ? null : input.title ?? `${kind} title`;
    const url = kind === 'bookmark' ? input.url ?? `https://example.test/${id}` : null;
    const materialized = materializeNodePayload({
      id, collectionId: COLLECTION, parentId: input.parentId ?? ROOT, kind, isRoot: false, title, url,
      description: input.description ?? null, tags: [], visibility: 'inherit', positionToken: `M${id.slice(-8)}`,
      resourceRevision: revision, childrenRevision,
      createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(materialized.ok, true);
    const payload = { ...(materialized.ok ? materialized.payload : {}), extensions: input.extensions ?? {} };
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')", [id]);
    await isolated.runtime.pool.query(`insert into nodes
      (id,collection_id,parent_id,kind,is_root,title,url,description,tags,visibility,position_token,
       resource_revision,children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
      values ($1,$2,$3,$4,false,$5,$6,$7,null,'inherit',$8,$9,$10,$11,$11,$12,$13,'backfilled')`,
    [id, COLLECTION, input.parentId ?? ROOT, kind, title, url, input.description ?? null, `M${id.slice(-8)}`, revision,
      childrenRevision, now, payload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,$4,$5,0,null)`, [COLLECTION, id, revision, kind, payload]);
    return { id, revision, payload };
  }

  async function setCurrent(node: Awaited<ReturnType<typeof seedNode>>, values: Record<string, unknown>, deleted = false) {
    const revision = `p3-13-current-${randomUUID()}`;
    const payload = {
      ...node.payload, ...values, resourceRevision: revision,
      updatedAt: '2026-07-26T02:20:00Z',
      ...(deleted ? { deletedAt: '2026-07-26T02:20:00.000Z', deletedCommitOrdinal: '1' } : {}),
    };
    await isolated.runtime.pool.query(`update nodes set title=$2,url=$3,description=$4,tags=$5::jsonb,
      visibility=$6,resource_revision=$7,updated_at=$8,deleted_at=$9,deleted_commit_ordinal=$10,payload_json=$11
      where id=$1`, [node.id, payload.title ?? null, payload.url ?? null, payload.description ?? null,
      JSON.stringify(payload.tags ?? []), payload.visibility ?? 'inherit', revision,
      new Date('2026-07-26T02:20:00.000Z'), deleted ? new Date('2026-07-26T02:20:00.000Z') : null,
      deleted ? 1 : null, payload]);
    await isolated.runtime.pool.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,$4,$5,0,null)`, [COLLECTION, node.id, revision, payload.kind, payload]);
    return { ...node, revision, payload };
  }

  async function context(
    role: 'owner' | 'editor' | 'viewer' = 'owner',
    protocolVersion: '0.1' | '0.2' = '0.1',
  ) {
    const suffix = randomUUID();
    const accountId = role === 'owner' ? ACCOUNT : `p3-13-${role}-${suffix}`;
    const subjectId = role === 'owner' ? SUBJECT : `p3-13-${role}-subject-${suffix}`;
    const oidcSubject = role === 'owner' ? 'p3-13-oidc' : `p3-13-oidc-${suffix}`;
    if (role !== 'owner') {
      await isolated.runtime.pool.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [accountId, subjectId]);
      await isolated.runtime.pool.query('insert into profile_handles(handle,account_id) values ($1,$2)',
        [`p3_13_${role}_${suffix}`, accountId]);
      await isolated.runtime.pool.query(`insert into account_identities(id,account_id,issuer,subject)
        values ($1,$2,$3,$4)`, [`p3-13-identity-${suffix}`, accountId, ISSUER, oidcSubject]);
      await isolated.runtime.pool.query(`insert into collection_members(collection_id,subject_id,role)
        values ($1,$2,$3)`, [COLLECTION, subjectId, role]);
    }
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: oidcSubject,
      credentialId: `p3-13-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `p3-13-device-${suffix}`, replicaId: () => `p3-13-replica-${suffix}`,
      leaseId: () => `p3-13-lease-${suffix}`,
    } }).create({
      accountId, collectionId: COLLECTION, deviceName: 'P3-13 device', replicaName: 'P3-13 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: role !== 'viewer', events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `p3-13-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `p3-13-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: accountId });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 43), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `p3-13-session-${suffix}`, requestFingerprint: `p3-13-fingerprint-${suffix}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: role === 'viewer' ? ['sync:pull'] : ['sync:push', 'sync:pull'], origin: ORIGIN,
      protocolVersion,
    });
    return { credential, replica, issuer, session: issued.session };
  }

  async function start(value: Awaited<ReturnType<typeof context>>, options: {
    readonly failAt?: PostgresSyncNodeUpdateFaultPhase | PostgresSyncNodeMoveFaultPhase
      | PostgresSyncNodeDeleteFaultPhase | PostgresSyncPushFaultPhase | PostgresSyncConflictFaultPhase;
    readonly managedBookmarkWrites?: boolean;
    readonly tombstoneRetentionSeconds?: number;
    readonly responseGate?: Promise<void>;
    readonly onResponseReady?: () => void;
    readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
  } = {}) {
    const app = Fastify({ logger: false });
    if (options.responseGate) app.addHook('onSend', async (request, _reply, payload) => {
      if (request.url === '/private-entry/canonical-update') {
        options.onResponseReady?.();
        await options.responseGate;
      }
      return payload;
    });
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-update', allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(isolated.runtime.db, value.issuer, {
        conflictPayloadEncryption: { key: Buffer.alloc(32, 71), keyVersion: 7 },
        ...(options.managedBookmarkWrites ? { managedBookmarkWrites: true } : {}),
        ...(options.tombstoneRetentionSeconds === undefined
          ? {} : { tombstoneRetentionSeconds: options.tombstoneRetentionSeconds }),
        ...(options.reportSourceInvalidation === undefined
          ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
        ...(options.failAt ? { faultInjector: { afterPhase(phase) {
          if (phase === options.failAt) throw new Error(`P3-13 injected ${phase}`);
        } } } : {}),
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
    registerSyncConflictRoutes(app, {
      pathTemplate: '/private-entry/conflicts/{conflictId}/decision', allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: resolver(value), rateLimit: { maxRequests: 100, windowMs: 60_000 },
      allowInsecureLoopback: true,
    });
    const pullKeys = createSyncPullCursorKeyring({
      active: { id: 'p3-21-http-v1', secret: Buffer.alloc(32, 83).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    registerSyncPullRoutes(app, {
      path: '/private-entry/ordered-pull', allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      reader: createPostgresSyncPullReadPort(isolated.runtime.db, pullKeys),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 100,
      responseBudgetBytes: 262_144, requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 30,
      allowInsecureLoopback: true,
    });
    app.addHook('onClose', async () => pullKeys.destroy());
    app.get('/.well-known/collection-protocol', async () => manifestFor(app));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    if (isFetchForbiddenPort(address.port)) {
      await app.close();
      return start(value, options);
    }
    apps.push(app);
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

  async function facts(replicaId: string, nodeId: string) {
    return (await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts,
      (select count(*)::int from operations where collection_id=$2) operations,
      (select count(*)::int from resource_revisions where collection_id=$2 and resource_id=$3) revisions,
      (select count(*)::int from sync_node_revision_history where collection_id=$2 and resource_id=$3) history,
      (select count(*)::int from sync_node_tombstones where collection_id=$2) tombstones,
      (select count(*)::int from sync_conflicts where collection_id=$2) conflicts,
      (select count(*)::int from audit_events where collection_id=$2 and operation_id is not null) audits,
      (select count(*)::int from outbox_events where aggregate_scope=$2) outbox,
      (select count(*)::int from resource_id_ledger) ledger,
      (select jsonb_build_object('commitOrdinal',commit_ordinal::text,
        'payloadCommitOrdinal',payload_json->>'commitOrdinal') from collections where id=$2) collection_commit,
      (select to_jsonb(n) from nodes n where n.id=$3) node,
      (select result_json from sync_sequence_receipts where replica_id=$1 order by sequence_number desc limit 1) receipt,
      (select next_sequence::int from sync_sequence_lanes where replica_id=$1) next_sequence
    `, [replicaId, COLLECTION, nodeId])).rows[0];
  }

  async function openConflict(input: {
    readonly kind?: NodeKind;
    readonly base?: Record<string, unknown>;
    readonly current?: Record<string, unknown>;
    readonly incoming?: Record<string, unknown>;
  } = {}) {
    const kind = input.kind ?? 'bookmark';
    const base = input.base ?? { title: 'P3-18 base' };
    const node = await seedNode(kind, {
      title: kind === 'separator' ? undefined : String(base.title ?? 'P3-18 base'),
      url: kind === 'bookmark' ? String(base.url ?? 'https://example.test/p3-18-base') : undefined,
    });
    await setCurrent(node, input.current ?? { title: 'P3-18 server' });
    const value = await context();
    const server = await start(value);
    const request = syncNodeUpdatePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: node.id, baseRevision: node.revision,
      opId: `p3-18-conflict-${randomUUID()}`, base,
      value: input.incoming ?? { title: 'P3-18 incoming' },
    });
    const response = await blackBox(server.origin).push({
      idempotencyKey: `p3-18-open-${randomUUID()}`, request,
    });
    assert.equal(response.status, 200);
    const conflictId = result(response.body).results[0]?.conflictId;
    assert.equal(typeof conflictId, 'string');
    return { node, value, conflictId: conflictId!, revision: 'conflict-r1' as const };
  }

  function resolver(
    value: Awaited<ReturnType<typeof context>>,
    failAt?: PostgresSyncConflictResolutionFaultPhase,
    managedBookmarkWrites = false,
  ) {
    return createPostgresSyncConflictResolutionApplication(isolated.runtime.db, value.issuer, {
      conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] },
      operationId: () => `p3-18-resolution-${randomUUID()}`,
      nodeId: () => `p3-18-both-${randomUUID()}`,
      ...(managedBookmarkWrites ? { managedBookmarkWrites: true } : {}),
      ...(failAt ? { faultInjector: { afterPhase(phase) {
        if (phase === failAt) throw new Error(`P3-18 injected ${phase}`);
      } } } : {}),
    });
  }

  function resolveInput(
    opened: {
      readonly value: Awaited<ReturnType<typeof context>>;
      readonly conflictId: string;
      readonly revision: 'conflict-r1';
    },
    request: ConflictResolutionRequest,
    idempotencyKey = `p3-18-resolve-${randomUUID()}`,
  ) {
    return {
      credential: opened.value.credential,
      sessionId: opened.value.session.sessionId,
      replicaId: opened.value.replica.replicaId,
      collectionId: COLLECTION,
      conflictId: opened.conflictId,
      idempotencyKey,
      ifMatch: [`"${opened.revision}"`],
      request,
    };
  }

  test('P3-18 rechecks deleted target and policy and rolls back each resolution boundary', async () => {
    const deleted = await openConflict();
    const deleteServer = await start(deleted.value);
    const deletion = await blackBox(deleteServer.origin).push({ idempotencyKey: 'p3-18-delete-target',
      request: syncNodeDeletePushRequest({ sessionId: deleted.value.session.sessionId,
        replicaId: deleted.value.replica.replicaId, collectionId: COLLECTION, targetId: deleted.node.id,
        sequence: 2,
        baseRevision: (await isolated.runtime.pool.query('select resource_revision from nodes where id=$1', [deleted.node.id]))
          .rows[0].resource_revision,
        opId: `p3-18-delete-${randomUUID()}` }) });
    assert.equal(deletion.status, 200);
    await assert.rejects(resolver(deleted.value).resolve(resolveInput(deleted, {
      resolution: 'incoming', baseConflictRevision: deleted.revision,
    })), (error: unknown) => error instanceof SyncConflictResolutionError
      && error.code === 'resource_not_found');

    const changedPolicy = await openConflict();
    await isolated.runtime.pool.query(`update collections set policy_revision='policy-p3-18-changed'
      where id=$1`, [COLLECTION]);
    await assert.rejects(resolver(changedPolicy.value).resolve(resolveInput(changedPolicy, {
      resolution: 'server', baseConflictRevision: changedPolicy.revision,
    })), (error: unknown) => error instanceof SyncConflictResolutionError
      && error.code === 'resource_not_found');
    await isolated.runtime.pool.query(`update collections set policy_revision='policy-r1'
      where id=$1`, [COLLECTION]);

    for (const phase of ['mutation', 'effect_built', 'effect_persisted', 'effect_pages_persisted',
      'conflict_update', 'before_receipt_finalize'] as const) {
      const opened = await openConflict();
      const before = await facts(opened.value.replica.replicaId, opened.node.id);
      await assert.rejects(resolver(opened.value, phase).resolve(resolveInput(opened, {
        resolution: 'incoming', baseConflictRevision: opened.revision,
      }, `p3-18-fault-${phase}`)));
      assert.deepEqual(await facts(opened.value.replica.replicaId, opened.node.id), before, phase);
      assert.equal((await isolated.runtime.pool.query(`select status,resolved_by_operation_id from sync_conflicts
        where conflict_id=$1`, [opened.conflictId])).rows[0].status, 'open');
      assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
        from sync_conflict_resolution_receipts where conflict_id=$1`, [opened.conflictId])).rows[0].count, 0);
    }
  }, 30_000);
});

function manifestFor(app: FastifyInstance): Manifest {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f97ff-1313-7131-8131-131313131313', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: {
        syncPush: `${origin}/private-entry/canonical-update`,
        syncSessions: `${origin}/private-entry/session-negotiation`,
        syncConflict: `${origin}/private-entry/conflicts/{conflictId}/decision`,
        syncPull: `${origin}/private-entry/ordered-pull`,
      },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
  } as Manifest;
}
