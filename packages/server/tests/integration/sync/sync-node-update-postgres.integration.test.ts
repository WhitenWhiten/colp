import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  ConflictResolutionRequest,
  ConflictResolutionResult,
  Manifest,
  Problem,
  SyncPushResult,
  SyncSessionRequest,
} from '@know-n/colp/types';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateAuthoritativePullEvent } from '@know-n/colp/sync';
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
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  createPostgresReportSourceInvalidationOutboxPort,
  createSyncConflictOutboxRoute,
  syncConflictEnvelopeRegistration,
} from '../../../src/infrastructure/outbox/index.js';
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
  canonicalSyncSequenceDigest,
  canonicalSyncSequenceResultDigest,
  createSyncPullCursorKeyring,
  SyncConflictResolutionError,
} from '../../../src/modules/sync/index.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import { syncNodeMovePushRequest } from '../../fixtures/phase3/sync-node-move.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { observeSubtree } from '../../support/subtree-observation.js';
import { verifyObservedSubtreeSafety, verifyResolutionLaneSafety } from '../../support/sync-data-safety-cases.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { recordPhase3SyncPushScenario } from '../../support/phase3-sync-push-acceptance-recorder.js';
import { isFetchForbiddenPort } from '../../support/fetch-port.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-13-AUTHORIZATION-SECRET-MARKER';
const ACCOUNT = 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ';
const SUBJECT = 'p3-13-subject';
const COLLECTION = 'cXFxcXFxcXFxcXFxcXFxcQ';
const ROOT = 'p3-13-root';

type NodeKind = 'folder' | 'bookmark' | 'separator';

describeWithPostgres('P3-13 real Fastify/PostgreSQL typed Node updates', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_node_update', { maxConnections: 20 });
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

  async function openMultiFieldConflict() {
    const namespace = 'https://extensions.example/r05-multi';
    const node = await seedNode('bookmark', {
      title: 'Base title',
      url: 'https://example.test/base',
      extensions: { [namespace]: { token: 'base' } },
    });
    await setCurrent(node, {
      title: 'Server title',
      url: 'https://example.test/server',
      extensions: { [namespace]: { token: 'server' } },
    });
    const value = await context();
    const server = await start(value);
    const request = syncNodeUpdatePushRequest({
      sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId,
      collectionId: COLLECTION,
      targetId: node.id,
      baseRevision: node.revision,
      opId: `r05-multi-${randomUUID()}`,
      base: {
        title: 'Base title',
        url: 'https://example.test/base',
        extensions: { [namespace]: { token: 'base' } },
      },
      value: {
        title: 'Incoming title',
        url: 'https://example.test/incoming',
        extensions: { [namespace]: { token: 'incoming' } },
      },
    });
    const response = await blackBox(server.origin).push({
      idempotencyKey: `r05-multi-open-${randomUUID()}`,
      request,
    });
    assert.equal(response.status, 200);
    const conflictId = result(response.body).results[0]?.conflictId;
    assert.equal(typeof conflictId, 'string');
    await server.app.close();
    return {
      node,
      value,
      conflictId: conflictId!,
      revision: 'conflict-r1' as const,
      namespace,
    };
  }

  function legalMultiFieldCustomValue(opened: Awaited<ReturnType<typeof openMultiFieldConflict>>) {
    return {
      title: 'Custom merged title',
      url: 'https://example.test/custom-merged',
      extensions: { [opened.namespace]: { token: 'custom' } },
    };
  }

  async function assertInvalidMultiFieldCustom(
    opened: Awaited<ReturnType<typeof openMultiFieldConflict>>,
    value: unknown,
    idempotencyKey: string,
  ) {
    const before = await facts(opened.value.replica.replicaId, opened.node.id);
    await assert.rejects(
      resolver(opened.value).resolve(resolveInput(opened, {
        resolution: 'custom',
        value,
        baseConflictRevision: opened.revision,
      }, idempotencyKey)),
      (error: unknown) => error instanceof SyncConflictResolutionError
        && error.code === 'invalid_document',
    );
    assert.deepEqual(await facts(opened.value.replica.replicaId, opened.node.id), before);
    assert.equal((await isolated.runtime.pool.query(
      'select status from sync_conflicts where conflict_id=$1', [opened.conflictId])).rows[0].status, 'open');
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from sync_conflict_resolution_receipts where conflict_id=$1',
      [opened.conflictId])).rows[0].count, 0);
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

  test('Sync node writes append a report source invalidation when the optional fan-out is composed', async () => {
    const node = await seedNode('folder', { title: 'Report source base' });
    const current = await setCurrent(node, { description: 'Report source current' });
    const value = await context();
    const server = await start(value, {
      reportSourceInvalidation: createPostgresReportSourceInvalidationOutboxPort(),
    });
    const operationId = `p3-13-report-source-${randomUUID()}`;
    const response = await blackBox(server.origin).push({
      idempotencyKey: `p3-13-report-source-request-${randomUUID()}`,
      request: syncNodeUpdatePushRequest({
        sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId,
        collectionId: COLLECTION,
        targetId: node.id,
        baseRevision: node.revision,
        opId: operationId,
        base: { title: 'Report source base' },
        value: { title: 'Report source incoming' },
      }),
    });
    assert.equal(response.status, 200, 'Sync push should succeed');
    assert.equal(result(response.body).results[0]?.status, 'rebased');

    const rows = await isolated.runtime.pool.query<{
      event_type: string;
      handler_name: string;
      aggregate_id: string;
      payload_json: Record<string, unknown>;
    }>(`select event_type, handler_name, aggregate_id, payload_json
          from outbox_events
         where event_type = 'reports.source.invalidated@1'
           and aggregate_id = $1`, [COLLECTION]);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.handler_name, 'reports_source_invalidation');
    assert.equal(rows.rows[0]?.payload_json.collectionId, COLLECTION);
    assert.equal(typeof rows.rows[0]?.payload_json.contentRevision, 'string');
    assert.equal(typeof rows.rows[0]?.payload_json.policyRevision, 'string');
    assert.equal(rows.rows[0]?.payload_json.sourceEventType, 'node.updated');
    assert.notEqual(current.revision, (await isolated.runtime.pool.query<{ resource_revision: string }>(
      'select resource_revision from nodes where id = $1', [node.id],
    )).rows[0]?.resource_revision);
  });

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

  test('automatically merges each Node kind and persists each same-field conflict without changing Current', async () => {
    const cases = [
      { kind: 'folder' as const, base: { title: 'Folder', description: null },
        current: { description: 'server' }, incoming: { title: 'Incoming folder', description: null } },
      { kind: 'bookmark' as const, base: { title: 'Bookmark', url: 'https://example.test/base' },
        current: { url: 'https://example.test/server' },
        incoming: { title: 'Incoming bookmark', url: 'https://example.test/base' } },
      { kind: 'separator' as const, base: { description: null, visibility: 'inherit' as const },
        current: { visibility: 'private' }, incoming: { description: 'Incoming separator', visibility: 'inherit' as const } },
    ] as const;
    for (const item of cases) {
      const node = await seedNode(item.kind, { title: item.kind === 'separator' ? undefined : item.base.title,
        url: item.kind === 'bookmark' ? item.base.url : undefined });
      const current = await setCurrent(node, item.current);
      const value = await context();
      const server = await start(value);
      const request = syncNodeUpdatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, targetId: node.id, baseRevision: node.revision,
        opId: `p3-13-auto-${randomUUID()}`, base: item.base, value: item.incoming,
      });
      const applied = await blackBox(server.origin).push({ idempotencyKey: `p3-13-auto-${randomUUID()}`, request });
      assert.equal(
        applied.status,
        200,
        `${item.kind}: ${'code' in applied.body ? applied.body.code : 'unexpected response'}`,
      );
      assert.equal(result(applied.body).results[0]?.status, 'rebased');
      const after = await facts(value.replica.replicaId, node.id);
      assert.notEqual(after.node.resource_revision, current.revision);
      assert.equal(after.history, 3);

      const conflictNode = await seedNode(item.kind, { title: item.kind === 'separator' ? undefined : item.base.title,
        url: item.kind === 'bookmark' ? item.base.url : undefined });
      const conflictCurrent = await setCurrent(conflictNode,
        item.kind === 'separator' ? { description: 'server conflict' }
          : item.kind === 'bookmark' ? { url: 'https://example.test/server-conflict' }
            : { title: 'Server conflict' });
      const conflictContext = await context();
      const conflictServer = await start(conflictContext);
      const conflictBase = item.kind === 'separator' ? { description: null }
        : item.kind === 'bookmark' ? { url: 'https://example.test/base' }
          : { title: 'Folder' };
      const conflictIncoming = item.kind === 'separator' ? { description: 'incoming conflict' }
        : item.kind === 'bookmark' ? { url: 'https://example.test/incoming-conflict' }
          : { title: 'Incoming conflict' };
      const conflicted = await blackBox(conflictServer.origin).push({
        idempotencyKey: `p3-13-conflict-${randomUUID()}`,
        request: syncNodeUpdatePushRequest({
          sessionId: conflictContext.session.sessionId, replicaId: conflictContext.replica.replicaId,
          collectionId: COLLECTION, targetId: conflictNode.id, baseRevision: conflictNode.revision,
          opId: `p3-13-conflict-${randomUUID()}`, base: conflictBase, value: conflictIncoming,
        }),
      });
      assert.equal(conflicted.status, 200);
      assert.equal(result(conflicted.body).results[0]?.status, 'conflicted');
      assert.equal(typeof result(conflicted.body).results[0]?.conflictId, 'string');
      assert.equal(typeof result(conflicted.body).results[0]?.cursor, 'string');
      const conflictAfter = await facts(conflictContext.replica.replicaId, conflictNode.id);
      assert.equal(conflictAfter.node.resource_revision, conflictCurrent.revision);
      assert.equal(conflictAfter.conflicts, after.conflicts + 1);
      assert.equal(conflictAfter.operations, after.operations + 1);
      assert.equal(conflictAfter.audits, after.audits + 1);
      assert.equal(conflictAfter.outbox, after.outbox + 1);
      assert.equal(conflictAfter.next_sequence, 2);
    }
    const ordered = (await isolated.runtime.pool.query(`select c.commit_ordinal::text,c.conflict_id,
      encode(c.private_payload_iv,'hex') private_iv,o.commit_ordinal::text operation_ordinal
      from sync_conflicts c join operations o
      on o.operation_id=c.operation_id order by c.commit_ordinal,c.conflict_id`)).rows;
    assert.ok(ordered.length >= cases.length);
    for (let index = 0; index < ordered.length; index += 1) {
      assert.equal(ordered[index].commit_ordinal, ordered[index].operation_ordinal);
      if (index > 0) assert.ok(BigInt(ordered[index - 1].commit_ordinal) < BigInt(ordered[index].commit_ordinal));
    }
    assert.equal(new Set(ordered.map((row) => row.private_iv)).size, ordered.length);
    recordPhase3SyncPushScenario('typed_update');
  });

  test('browser tag sync removes only observed members, preserves concurrent additions and exactly replays its receipt', async () => {
    const base = await setCurrent(await seedNode('bookmark'), { tags: ['base'] });
    await setCurrent(base, { tags: ['base', 'concurrent'] });
    const value = await context(), server = await start(value), idempotencyKey = `metadata-${randomUUID()}`;
    const request = syncNodeUpdatePushRequest({ sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: base.id, baseRevision: base.revision, opId: `metadata-${randomUUID()}`,
      base: { tags: ['base'] }, value: { tags: ['local'] } });
    const applied = await blackBox(server.origin).push({ idempotencyKey, request });
    assert.equal(applied.status, 200);
    assert.equal(result(applied.body).results[0]?.status, 'rebased');
    const after = await facts(value.replica.replicaId, base.id);
    assert.deepEqual(after.node.tags, ['concurrent', 'local']);
    assert.equal(after.node.title, base.payload.title);
    const replay = await blackBox(server.origin).push({ idempotencyKey, request });
    assert.deepEqual(replay.body, applied.body);
    assert.deepEqual(await facts(value.replica.replicaId, base.id), after);
  });

  test('P3-17 serializes two-connection Conflict creation to one stable terminal result', async () => {
    const node = await seedNode('folder', { title: 'Concurrent base' });
    const current = await setCurrent(node, { title: 'Concurrent server' });
    const value = await context();
    const left = await start(value);
    const right = await start(value);
    const request = syncNodeUpdatePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: node.id, baseRevision: node.revision,
      opId: `p3-17-concurrent-${randomUUID()}`, base: { title: 'Concurrent base' },
      value: { title: 'Concurrent incoming' },
    });
    const [leftResult, rightResult] = await Promise.all([
      blackBox(left.origin).push({ idempotencyKey: 'p3-17-concurrent', request }),
      blackBox(right.origin).push({ idempotencyKey: 'p3-17-concurrent', request }),
    ]);
    assert.equal(leftResult.status, 200);
    assert.deepEqual(rightResult, leftResult);
    const conflictId = result(leftResult.body).results[0]?.conflictId;
    assert.equal(typeof conflictId, 'string');
    const rows = (await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_conflicts where operation_id=$1) conflicts,
      (select count(*)::int from operations where operation_id=$1) operations,
      (select count(*)::int from sync_sequence_receipts where operation_id=$1) receipts`,
    [request.operations[0]!.opId])).rows[0];
    assert.deepEqual(rows, { conflicts: 1, operations: 1, receipts: 1 });
    assert.equal((await isolated.runtime.pool.query('select resource_revision from nodes where id=$1', [node.id]))
      .rows[0].resource_revision, current.revision);
  });

  test('preserves nested unknown extensions and returns exact immutable replay after restart', async () => {
    const namespace = 'https://extensions.example/p3-13-secret';
    const node = await seedNode('bookmark', { title: 'Base title', url: 'https://example.test/base',
      extensions: { [namespace]: { nested: { stable: ['EXTENSION-SECRET-MARKER'] }, side: 'base' } } });
    await setCurrent(node, { title: 'Server title' });
    const value = await context();
    const firstServer = await start(value);
    const request = syncNodeUpdatePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: node.id, baseRevision: node.revision,
      opId: `p3-13-replay-${randomUUID()}`,
      base: { url: 'https://example.test/base', extensions: node.payload.extensions as Record<string, unknown> },
      value: { url: 'https://example.test/incoming', extensions: node.payload.extensions as Record<string, unknown> },
    });
    const first = await blackBox(firstServer.origin).push({ idempotencyKey: 'p3-13-replay-key', request });
    assert.equal(first.status, 200, 'code' in first.body ? first.body.code : 'unexpected response');
    assert.equal(result(first.body).results[0]?.status, 'rebased');
    const afterFirst = await facts(value.replica.replicaId, node.id);
    await firstServer.app.close();
    const restarted = await start(value);
    const replay = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-13-replay-key', request });
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(value.replica.replicaId, node.id), afterFirst);
    assert.deepEqual(afterFirst.node.payload_json.extensions, node.payload.extensions);
    recordPhase3SyncPushScenario('terminal_exact_replay');
    recordPhase3SyncPushScenario('restart_replay');
    recordPhase3SyncPushScenario('field_exact_replay');
  });

  test('P3-16 maps unknown commit to same-request recovery of the committed HTTP receipt', async () => {
    const node = await seedNode('folder', { title: 'Unknown commit base' });
    const value = await context();
    const lossy = await start(value, { failAt: 'sequence_after_commit' });
    const request = syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
      baseRevision: node.revision, opId: `p3-16-unknown-${randomUUID()}`,
      base: { title: 'Unknown commit base' }, value: { title: 'Unknown commit applied' } });
    const unknown = await blackBox(lossy.origin).push({ idempotencyKey: 'p3-16-unknown-key', request });
    assert.equal(unknown.status, 503);
    assert.equal((unknown.body as Problem).code, 'service_unavailable');
    const committed = await facts(value.replica.replicaId, node.id);
    assert.equal(committed.next_sequence, 2);
    assert.equal(committed.receipts, 1);
    await lossy.app.close();
    const restarted = await start(value);
    const recovered = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-16-unknown-key', request });
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, committed.receipt);
    assert.deepEqual(await facts(value.replica.replicaId, node.id), committed);
    recordPhase3SyncPushScenario('commit_outcome_unknown_same_request');
  });

  test('P3-17 exact-replays a terminal Conflict and rejects changed Sequence digest', async () => {
    const node = await seedNode('folder', { title: 'Deferred base' });
    await setCurrent(node, { title: 'Deferred server' });
    const value = await context();
    const server = await start(value);
    const request = syncNodeUpdatePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: node.id, baseRevision: node.revision,
      opId: `p3-16-deferred-${randomUUID()}`, base: { title: 'Deferred base' },
      value: { title: 'Deferred incoming' },
    });
    const first = await blackBox(server.origin).push({ idempotencyKey: 'p3-16-deferred-key', request });
    assert.equal(first.status, 200);
    assert.equal(result(first.body).results[0]?.status, 'conflicted');
    const afterConflict = await facts(value.replica.replicaId, node.id);
    assert.equal(afterConflict.next_sequence, 2);
    const replay = await blackBox(server.origin).push({ idempotencyKey: 'p3-16-deferred-key', request });
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(value.replica.replicaId, node.id), afterConflict);

    const changed = await blackBox(server.origin).push({
      idempotencyKey: 'p3-16-deferred-changed-key',
      request: syncNodeUpdatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, targetId: node.id, baseRevision: node.revision,
        opId: request.operations[0]!.opId, base: { title: 'Deferred base' },
        value: { title: 'Changed digest' },
      }),
    });
    assert.equal(changed.status, 409);
    assert.equal((changed.body as Problem).code, 'sequence_reuse');
    assert.deepEqual(await facts(value.replica.replicaId, node.id), afterConflict);
  });

  test('P3-16 maps HTTP gap and blocked replay, then P3-17 upgrades a retained deferred receipt', async () => {
    const node = await seedNode('folder', { title: 'Gap base' });
    const gapContext = await context();
    const gapServer = await start(gapContext);
    const gap = await blackBox(gapServer.origin).push({ idempotencyKey: 'p3-16-gap-key',
      request: syncNodeUpdatePushRequest({ sessionId: gapContext.session.sessionId,
        replicaId: gapContext.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        sequence: 2, baseRevision: node.revision, opId: `p3-16-gap-${randomUUID()}` }) });
    assert.equal(gap.status, 409);
    assert.equal((gap.body as Problem).code, 'sequence_gap');
    assert.equal((gap.body as Problem & { expectedSequence?: number }).expectedSequence, 1);
    const gapRows = (await isolated.runtime.pool.query(`select l.next_sequence::int,
      (select count(*)::int from sync_sequence_operation_claims c where c.replica_id=l.replica_id) claims,
      (select count(*)::int from sync_sequence_receipts r where r.replica_id=l.replica_id) receipts
      from sync_sequence_lanes l where l.replica_id=$1`, [gapContext.replica.replicaId])).rows[0];
    assert.deepEqual(gapRows, { next_sequence: 1, claims: 0, receipts: 0 });

    const blockedContext = await context();
    const blockedServer = await start(blockedContext);
    const deferredRequest = syncNodeUpdatePushRequest({ sessionId: blockedContext.session.sessionId,
      replicaId: blockedContext.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
      baseRevision: 'missing-base-revision', opId: `p3-16-blocker-${randomUUID()}` });
    const idempotencyKey = 'p3-16-blocker-key';
    const secretDigest = (await isolated.runtime.pool.query(`select secret_digest,lease_generation::text
      from sync_sessions where session_id=$1`, [blockedContext.session.sessionId])).rows[0];
    const serverBatchId = `${blockedContext.session.sessionId}.${createHmac('sha256', secretDigest.secret_digest)
      .update('known.sync-push.batch.v1\0', 'utf8').update(idempotencyKey, 'utf8').digest('base64url')}`;
    const canonicalDigest = canonicalSyncSequenceDigest({
      session: blockedContext.session,
      replicaId: blockedContext.replica.replicaId,
      leaseGeneration: secretDigest.lease_generation,
      sequenceScope: `collection:${COLLECTION}`,
      sequence: 1,
      operationId: deferredRequest.operations[0]!.opId,
      serverBatchId,
      mediaType: 'application/json',
      endpointIdentity: '/private-entry/canonical-update',
      payload: Object.freeze({ atomic: deferredRequest.atomic, operation: deferredRequest.operations[0]! }),
      reevaluateDeferred: true,
      transactionalAuthority: Object.freeze({ credential: blockedContext.credential, origin: ORIGIN }),
    });
    const deferredResult: SyncPushResult = {
      batchId: serverBatchId,
      results: [{ opId: deferredRequest.operations[0]!.opId, sequence: 1, status: 'deferred',
        targetId: node.id, code: 'sync_base_unavailable', warnings: [] }],
      serverCursor: 'sync-unchanged',
    };
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'operation')`, [deferredRequest.operations[0]!.opId]);
    await isolated.runtime.pool.query(`insert into sync_sequence_lanes
      (replica_id,collection_id,sequence_scope) values ($1,$2,$3)`,
    [blockedContext.replica.replicaId, COLLECTION, `collection:${COLLECTION}`]);
    await isolated.runtime.pool.query(`insert into sync_sequence_operation_claims
      (operation_id,replica_id,collection_id,sequence_scope,sequence_number,canonical_digest)
      values ($1,$2,$3,$4,1,$5)`, [deferredRequest.operations[0]!.opId,
      blockedContext.replica.replicaId, COLLECTION, `collection:${COLLECTION}`, canonicalDigest]);
    await isolated.runtime.pool.query(`insert into sync_sequence_receipts
      (replica_id,collection_id,sequence_scope,sequence_number,operation_id,canonical_digest,
       session_id,lease_generation,server_batch_id,media_type,endpoint_identity,status,
       result_json,result_digest,finalized_at)
      values ($1,$2,$3,1,$4,$5,$6,$7,$8,'application/json',$9,'deferred',$10,$11,null)`,
    [blockedContext.replica.replicaId, COLLECTION, `collection:${COLLECTION}`,
      deferredRequest.operations[0]!.opId, canonicalDigest, blockedContext.session.sessionId,
      secretDigest.lease_generation, serverBatchId, '/private-entry/canonical-update',
      deferredResult, canonicalSyncSequenceResultDigest(deferredResult)]);

    const blockedRequest = syncNodeUpdatePushRequest({ sessionId: blockedContext.session.sessionId,
      replicaId: blockedContext.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
      sequence: 2, baseRevision: node.revision, opId: `p3-16-blocked-${randomUUID()}`,
      base: { description: null }, value: { description: 'must remain blocked' } });
    const blocked = await blackBox(blockedServer.origin).push({ idempotencyKey: 'p3-16-next',
      request: blockedRequest });
    const blockedReplay = await blackBox(blockedServer.origin).push({ idempotencyKey: 'p3-16-next',
      request: blockedRequest });
    assert.deepEqual(blockedReplay, blocked);
    assert.equal(blocked.status, 409);
    assert.equal((blocked.body as Problem).code, 'sequence_blocked');

    const changed = await blackBox(blockedServer.origin).push({ idempotencyKey: 'p3-16-changed',
      request: syncNodeUpdatePushRequest({ sessionId: blockedContext.session.sessionId,
        replicaId: blockedContext.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: 'missing-base-revision', opId: deferredRequest.operations[0]!.opId,
        base: { title: 'Before' }, value: { title: 'changed digest' } }) });
    assert.equal(changed.status, 409);
    assert.equal((changed.body as Problem).code, 'sequence_reuse');

    await blockedServer.app.close();
    const restarted = await start(blockedContext);
    const recovered = await blackBox(restarted.origin).push({ idempotencyKey, request: deferredRequest });
    assert.equal(recovered.status, 200);
    assert.equal(result(recovered.body).results[0]?.status, 'conflicted');
    const blockedRows = (await isolated.runtime.pool.query(`select l.next_sequence::int,
      (select count(*)::int from sync_sequence_operation_claims c where c.replica_id=l.replica_id) claims,
      (select count(*)::int from sync_sequence_receipts r where r.replica_id=l.replica_id) receipts
      from sync_sequence_lanes l where l.replica_id=$1`, [blockedContext.replica.replicaId])).rows[0];
    assert.deepEqual(blockedRows, { next_sequence: 2, claims: 1, receipts: 1 });
    recordPhase3SyncPushScenario('sequence_gap');
    recordPhase3SyncPushScenario('sequence_blocked');
    recordPhase3SyncPushScenario('deferred_exact_replay');
    recordPhase3SyncPushScenario('deferred_digest_reuse_rejected');
    recordPhase3SyncPushScenario('deferred_recovery');
  });

  test('P3-16 fails closed over HTTP when an advanced lane has no predecessor receipt', async () => {
    const node = await seedNode('folder', { title: 'Receipt integrity' });
    const value = await context();
    const server = await start(value);
    const first = await blackBox(server.origin).push({ idempotencyKey: 'p3-16-receipt-first',
      request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: node.revision, opId: `p3-16-receipt-${randomUUID()}`,
        base: { title: 'Receipt integrity' }, value: { title: 'Receipt terminal' } }) });
    assert.equal(first.status, 200);
    await isolated.runtime.pool.query('alter table sync_sequence_receipts disable trigger user');
    try {
      await isolated.runtime.pool.query('delete from sync_sequence_receipts where replica_id=$1',
        [value.replica.replicaId]);
    } finally {
      await isolated.runtime.pool.query('alter table sync_sequence_receipts enable trigger user');
    }
    const denied = await blackBox(server.origin).push({ idempotencyKey: 'p3-16-receipt-next',
      request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        sequence: 2, baseRevision: result(first.body).results[0]!.revision!,
        opId: `p3-16-receipt-next-${randomUUID()}` }) });
    assert.equal(denied.status, 500);
    assert.equal((denied.body as Problem).code, 'internal_error');
    const rows = (await isolated.runtime.pool.query(`select next_sequence::int,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts
      from sync_sequence_lanes where replica_id=$1`, [value.replica.replicaId])).rows[0];
    assert.deepEqual(rows, { next_sequence: 2, claims: 1, receipts: 0 });
    recordPhase3SyncPushScenario('receipt_missing_fail_closed');
  });

  test('P3-16 isolates two Replica lanes and rejects a lifecycle-wide opId reuse across scopes', async () => {
    const leftNode = await seedNode('folder', { title: 'Left scope' });
    const rightNode = await seedNode('folder', { title: 'Right scope' });
    const left = await context();
    const right = await context();
    const leftServer = await start(left);
    const rightServer = await start(right);
    const sharedOpId = `p3-16-cross-scope-${randomUUID()}`;
    const leftResponse = await blackBox(leftServer.origin).push({ idempotencyKey: 'p3-16-left',
      request: syncNodeUpdatePushRequest({ sessionId: left.session.sessionId,
        replicaId: left.replica.replicaId, collectionId: COLLECTION, targetId: leftNode.id,
        baseRevision: leftNode.revision, opId: sharedOpId,
        base: { title: 'Left scope' }, value: { title: 'Left terminal' } }) });
    assert.equal(leftResponse.status, 200);
    const rightResponse = await blackBox(rightServer.origin).push({ idempotencyKey: 'p3-16-right',
      request: syncNodeUpdatePushRequest({ sessionId: right.session.sessionId,
        replicaId: right.replica.replicaId, collectionId: COLLECTION, targetId: rightNode.id,
        baseRevision: rightNode.revision, opId: `p3-16-right-${randomUUID()}`,
        base: { title: 'Right scope' }, value: { title: 'Right terminal' } }) });
    assert.equal(rightResponse.status, 200);
    const lanes = (await isolated.runtime.pool.query(`select replica_id,next_sequence::int
      from sync_sequence_lanes where replica_id=any($1::text[]) order by replica_id`,
    [[left.replica.replicaId, right.replica.replicaId]])).rows;
    assert.deepEqual(lanes.map((row) => row.next_sequence), [2, 2]);

    const third = await context();
    const thirdServer = await start(third);
    const reused = await blackBox(thirdServer.origin).push({ idempotencyKey: 'p3-16-cross-reuse',
      request: syncNodeUpdatePushRequest({ sessionId: third.session.sessionId,
        replicaId: third.replica.replicaId, collectionId: COLLECTION, targetId: rightNode.id,
        baseRevision: result(rightResponse.body).results[0]!.revision!, opId: sharedOpId }) });
    assert.equal(reused.status, 409);
    assert.equal((reused.body as Problem).code, 'op_id_reused');
    const thirdRows = (await isolated.runtime.pool.query(`select
      (select next_sequence::int from sync_sequence_lanes where replica_id=$1) next_sequence,
      (select count(*)::int from sync_sequence_operation_claims where replica_id=$1) claims,
      (select count(*)::int from sync_sequence_receipts where replica_id=$1) receipts`,
    [third.replica.replicaId])).rows[0];
    assert.deepEqual(thirdRows, { next_sequence: 1, claims: 0, receipts: 0 });
    recordPhase3SyncPushScenario('independent_replica_scope');
    recordPhase3SyncPushScenario('cross_scope_op_id_rejected');
  });

  test('fails closed for forged history, stale policy, viewer, oversized merge, and sensitive invalid URL', async () => {
    const node = await seedNode('bookmark', { title: 'SENSITIVE-TITLE-MARKER',
      url: 'https://example.test/SENSITIVE-URL-MARKER' });
    const value = await context();
    const server = await start(value);
    const before = await facts(value.replica.replicaId, node.id);
    const forged = await blackBox(server.origin).push({ idempotencyKey: 'p3-13-forged',
      request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: 'p3-13-forged-r9', opId: `p3-13-forged-${randomUUID()}` }) });
    assert.equal(forged.status, 200);
    assert.equal(result(forged.body).results[0]?.status, 'conflicted');
    assert.equal(typeof result(forged.body).results[0]?.conflictId, 'string');
    assert.equal(JSON.stringify(forged.body).includes('SENSITIVE-'), false);
    const afterConflict = await facts(value.replica.replicaId, node.id);
    const replay = await blackBox(server.origin).push({ idempotencyKey: 'p3-13-forged',
      request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: 'p3-13-forged-r9', opId: result(forged.body).results[0]!.opId }) });
    assert.deepEqual(replay, forged);
    const next = await blackBox(server.origin).push({ idempotencyKey: 'p3-13-forged-next',
      request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        sequence: 2, baseRevision: node.revision, opId: `p3-13-blocked-${randomUUID()}`,
        base: { description: null }, value: { description: 'after terminal conflict' } }) });
    assert.equal(next.status, 200);
    assert.ok(['applied', 'rebased'].includes(result(next.body).results[0]!.status));
    assert.equal(afterConflict.node.resource_revision, before.node.resource_revision);
    const afterNext = await facts(value.replica.replicaId, node.id);
    const invalidContext = await context();
    const invalidServer = await start(invalidContext);
    const conflictsBeforeInvalid = (await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflicts where collection_id=$1`, [COLLECTION])).rows[0].count;
    const invalid = await blackBox(invalidServer.origin).push({ idempotencyKey: 'p3-13-invalid-url',
      request: syncNodeUpdatePushRequest({ sessionId: invalidContext.session.sessionId,
        replicaId: invalidContext.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: node.revision, opId: `p3-13-invalid-${randomUUID()}`,
        base: { url: node.payload.url as string },
        value: { url: 'https://SECRET-USERINFO:password@example.test/path' } }) });
    assert.notEqual(invalid.status, 200);
    assert.equal(JSON.stringify(invalid.body).includes('SECRET-USERINFO'), false);
    assert.deepEqual((await facts(value.replica.replicaId, node.id)).node, afterNext.node);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflicts where collection_id=$1`, [COLLECTION])).rows[0].count, conflictsBeforeInvalid);

    const oversizedNode = await seedNode('folder', { title: 'Oversized authority',
      extensions: { 'https://extensions.example/p3-13-budget': { marker: 'x'.repeat(70_000) } } });
    const oversizedContext = await context();
    const oversizedServer = await start(oversizedContext);
    const oversized = await blackBox(oversizedServer.origin).push({ idempotencyKey: 'p3-13-budget',
      request: syncNodeUpdatePushRequest({ sessionId: oversizedContext.session.sessionId,
        replicaId: oversizedContext.replica.replicaId, collectionId: COLLECTION,
        targetId: oversizedNode.id, baseRevision: oversizedNode.revision,
        opId: `p3-13-budget-${randomUUID()}`, base: { title: 'Oversized authority' },
        value: { title: 'Small request' } }) });
    assert.notEqual(oversized.status, 200);
    assert.equal((oversized.body as Problem).code, 'payload_too_large');
    assert.equal(JSON.stringify(oversized.body).includes('xxxxx'), false);

    const stale = await context();
    const staleServer = await start(stale);
    await isolated.runtime.pool.query("update collections set policy_revision='policy-r2' where id=$1", [COLLECTION]);
    const denied = await blackBox(staleServer.origin).push({ idempotencyKey: 'p3-13-stale-policy',
      request: syncNodeUpdatePushRequest({ sessionId: stale.session.sessionId,
        replicaId: stale.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: node.revision, opId: `p3-13-stale-${randomUUID()}` }) });
    assert.notEqual(denied.status, 200);
    await isolated.runtime.pool.query("update collections set policy_revision='policy-r1' where id=$1", [COLLECTION]);

    const viewer = await context('viewer');
    const viewerServer = await start(viewer);
    const conflictsBeforeViewer = (await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflicts where collection_id=$1`, [COLLECTION])).rows[0].count;
    const viewerDenied = await blackBox(viewerServer.origin).push({ idempotencyKey: 'p3-13-viewer',
      request: syncNodeUpdatePushRequest({ sessionId: viewer.session.sessionId,
        replicaId: viewer.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: node.revision, opId: `p3-13-viewer-${randomUUID()}` }) });
    assert.notEqual(viewerDenied.status, 200);
    assert.equal(JSON.stringify(viewerDenied.body).includes('SENSITIVE-'), false);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflicts where collection_id=$1`, [COLLECTION])).rows[0].count, conflictsBeforeViewer);
  });

  test('P3-17 persists one bounded redacted multi-field Conflict with ordered atomic evidence', async () => {
    const secret = 'P3-17-SECRET-MARKER';
    const namespace = 'https://extensions.example/p3-17-private';
    const node = await seedNode('bookmark', { title: 'Base title',
      url: `https://example.test/base?private=${secret}-base-url`,
      extensions: { [namespace]: { token: `${secret}-base` } } });
    const current = await setCurrent(node, { title: 'Server title',
      url: `https://example.test/server?private=${secret}-server-url`,
      extensions: { [namespace]: { token: `${secret}-server` } } });
    const value = await context();
    const server = await start(value);
    const request = syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
      baseRevision: node.revision, opId: `p3-17-redacted-${randomUUID()}`,
      base: { title: 'Base title', url: node.payload.url as string,
        extensions: node.payload.extensions as Record<string, unknown> },
      value: { title: 'Incoming title', url: `https://example.test/incoming?private=${secret}-incoming-url`,
        extensions: { [namespace]: { token: `${secret}-incoming` } } },
    });
    const first = await blackBox(server.origin).push({ idempotencyKey: 'p3-17-redacted', request });
    assert.equal(first.status, 200);
    const operationResult = result(first.body).results[0]!;
    assert.equal(operationResult.status, 'conflicted');
    assert.ok(operationResult.conflictId);
    assert.equal(JSON.stringify(first.body).includes(secret), false);
    assert.equal(JSON.stringify(first.body).includes('password'), false);

    const persisted = (await isolated.runtime.pool.query(`select c.*,o.sync_wire_present,
      op.payload_json operation_payload,op.sync_wire_json,
      ap.details_json audit_details,x.payload_json outbox_payload,r.result_json receipt_result
      from sync_conflicts c join operations o on o.operation_id=c.operation_id
      join operation_payloads op on op.operation_id=o.operation_id
      join audit_events a on a.operation_id=c.operation_id
      join audit_event_payloads ap on ap.event_id=a.id
      join outbox_events x on x.domain_event_id=c.operation_id
      join sync_sequence_receipts r on r.operation_id=c.operation_id
      where c.conflict_id=$1`, [operationResult.conflictId])).rows;
    assert.equal(persisted.length, 1);
    const row = persisted[0];
    assert.equal(row.collection_id, COLLECTION);
    assert.equal(row.replica_id, value.replica.replicaId);
    assert.equal(row.session_id, value.session.sessionId);
    assert.equal(row.operation_id, request.operations[0]!.opId);
    assert.equal(row.target_id, node.id);
    assert.equal(row.status, 'open');
    assert.equal(row.revision, 'conflict-r1');
    assert.equal(row.base_revision, node.revision);
    assert.equal(row.trusted_base_revision, node.revision);
    assert.equal(row.current_revision, current.revision);
    assert.equal(row.sync_wire_present, false);
    assert.equal(row.sync_wire_json, null);
    assert.deepEqual(row.conflicting_fields, ['/extensions', '/title', '/url']);
    assert.deepEqual(row.allowed_resolutions, ['server', 'incoming', 'custom', 'both']);
    assert.ok(Buffer.isBuffer(row.private_payload_ciphertext));
    assert.equal(row.private_payload_iv.length, 12);
    assert.equal(row.private_payload_auth_tag.length, 16);
    assert.equal(row.private_payload_key_version, 7);
    assert.equal(String(row.commit_ordinal), String(row.operation_payload.commitOrdinal));
    const visible = JSON.stringify(persisted);
    for (const marker of [secret, 'base-url', 'server-url', 'incoming-url']) {
      assert.equal(visible.includes(marker), false, marker);
    }
    assert.equal(row.base_projection.fields['/title'].kind, 'string');
    assert.equal(typeof row.base_projection.fields['/title'].sha256, 'string');
    assert.equal((await isolated.runtime.pool.query('select resource_revision from nodes where id=$1', [node.id]))
      .rows[0].resource_revision, current.revision);

    await isolated.runtime.pool.query(`update outbox_events set available_at=current_timestamp + interval '1 hour'
      where state='pending' and domain_event_id<>$1`, [request.operations[0]!.opId]);
    await isolated.runtime.pool.query(`update outbox_events set available_at=current_timestamp - interval '1 second'
      where domain_event_id=$1 and handler_name='sync_conflict_pull'`, [request.operations[0]!.opId]);
    const outboxWorker = new VersionedOutboxWorker({
      repository: new PostgresOutboxRepository(isolated.runtime.pool),
      router: new OutboxRouter([createSyncConflictOutboxRoute(isolated.runtime.pool)]),
      envelopes: new EventEnvelopeRegistry([syncConflictEnvelopeRegistration]),
      logger: { info() {}, warn() {}, error() {} },
      leaseDurationMs: 2_000, heartbeatIntervalMs: 500, handlerTimeoutMs: 1_000,
    });
    assert.equal(await outboxWorker.runOnce(), true);
    assert.equal((await isolated.runtime.pool.query(`select state from outbox_events
      where domain_event_id=$1 and handler_name='sync_conflict_pull'`,
    [request.operations[0]!.opId])).rows[0].state, 'completed');

    const reader = `p3_17_reader_${randomUUID().replaceAll('-', '')}`;
    const schema = (await isolated.runtime.pool.query<{ current_schema: string }>('select current_schema()'))
      .rows[0]!.current_schema;
    assert.match(schema, /^[a-z0-9_]+$/u);
    await isolated.runtime.pool.query(`create role ${reader} nologin`);
    await isolated.runtime.pool.query(`grant usage on schema ${schema} to ${reader}`);
    await isolated.runtime.pool.query(`grant select (conflict_id,collection_id,target_id,status,revision,
      commit_ordinal,base_projection,current_projection,incoming_projection) on sync_conflicts to ${reader}`);
    const restricted = await isolated.runtime.pool.connect();
    try {
      await restricted.query(`set role ${reader}`);
      assert.equal((await restricted.query('select conflict_id from sync_conflicts where conflict_id=$1',
        [operationResult.conflictId])).rowCount, 1);
      await assert.rejects(restricted.query('select private_payload_ciphertext from sync_conflicts limit 1'),
        /permission denied/iu);
    } finally {
      await restricted.query('reset role');
      restricted.release();
      await isolated.runtime.pool.query(`revoke all privileges on sync_conflicts from ${reader}`);
      await isolated.runtime.pool.query(`revoke usage on schema ${schema} from ${reader}`);
      await isolated.runtime.pool.query(`drop role ${reader}`);
    }

    const beforeReplay = await facts(value.replica.replicaId, node.id);
    await server.app.close();
    const restarted = await start(value);
    const replay = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-17-redacted', request });
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(value.replica.replicaId, node.id), beforeReplay);
    await assert.rejects(isolated.runtime.pool.query(`update sync_conflicts set status='pending'
      where conflict_id=$1`, [operationResult.conflictId]), /check|invalid|immutable/iu);
    await assert.rejects(isolated.runtime.pool.query(`update sync_conflicts set target_id=$2
      where conflict_id=$1`, [operationResult.conflictId, ROOT]), /immutable/iu);
    await assert.rejects(isolated.runtime.pool.query('delete from sync_conflicts where conflict_id=$1',
      [operationResult.conflictId]), /immutable/iu);
  }, 20_000);

  test('P3-17 rolls back ordinal, Operation, Conflict, Audit, Outbox and receipt at every conflict boundary', async () => {
    for (const phase of ['conflict_ordinal', 'conflict_operation', 'conflict',
      'conflict_audit', 'conflict_outbox', 'before_receipt_finalize'] as const) {
      const node = await seedNode('folder', { title: `P3-17 base ${phase}` });
      const current = await setCurrent(node, { title: `P3-17 server ${phase}` });
      const value = await context();
      const before = await facts(value.replica.replicaId, node.id);
      const server = await start(value, { failAt: phase });
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-17-fault-${phase}`,
        request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
          replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
          baseRevision: node.revision, opId: `p3-17-fault-${phase}-${randomUUID()}`,
          base: { title: `P3-17 base ${phase}` }, value: { title: `P3-17 incoming ${phase}` } }) });
      assert.notEqual(response.status, 200);
      const after = await facts(value.replica.replicaId, node.id);
      assert.deepEqual(after, before, phase);
      assert.equal(after.node.resource_revision, current.revision);
    }
  }, 20_000);

  test('enforces immutable history bindings and deferred Operation integrity in PostgreSQL', async () => {
    const node = await seedNode('folder', { title: 'Immutable history' });
    await assert.rejects(
      isolated.runtime.pool.query(`update sync_node_revision_history
        set kind='bookmark' where collection_id=$1 and resource_id=$2 and revision=$3`,
      [COLLECTION, node.id, node.revision]),
      /immutable/iu,
    );
    await assert.rejects(
      isolated.runtime.pool.query(`delete from sync_node_revision_history
        where collection_id=$1 and resource_id=$2 and revision=$3`,
      [COLLECTION, node.id, node.revision]),
      /immutable/iu,
    );
    const wrongRevision = `p3-13-wrong-${randomUUID()}`;
    await assert.rejects(
      isolated.runtime.pool.query(`insert into sync_node_revision_history
        (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
        values ($1,$2,$3,'folder',$4,1,null)`,
      [COLLECTION, node.id, wrongRevision, node.payload]),
      /sync_node_revision_history_payload_binding/iu,
    );

    const client = await isolated.runtime.pool.connect();
    const deferredRevision = `p3-13-deferred-fk-${randomUUID()}`;
    const deferredPayload = { ...node.payload, resourceRevision: deferredRevision };
    try {
      await client.query('begin');
      await client.query(`insert into sync_node_revision_history
        (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
        values ($1,$2,$3,'folder',$4,1,$5)`,
      [COLLECTION, node.id, deferredRevision, deferredPayload, `missing-operation-${randomUUID()}`]);
      await assert.rejects(client.query('commit'), /sync_node_revision_history_operation_fk/iu);
    } finally {
      try { await client.query('rollback'); } catch { /* failed commit already ended the transaction */ }
      client.release();
    }
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from sync_node_revision_history where collection_id=$1 and resource_id=$2`,
    [COLLECTION, node.id])).rows[0]?.count, 1);
  });

  test('reads Current after a competing connection commits and rejects a concurrent delete', async () => {
    const node = await seedNode('bookmark', { title: 'Base', url: 'https://example.test/base' });
    const value = await context();
    const server = await start(value);
    const blocker = await isolated.runtime.pool.connect();
    await blocker.query('begin');
    const currentRevision = `p3-13-race-${randomUUID()}`;
    const currentPayload = { ...node.payload, title: 'Server race', resourceRevision: currentRevision };
    await blocker.query('update nodes set title=$2,resource_revision=$3,payload_json=$4 where id=$1',
      [node.id, 'Server race', currentRevision, currentPayload]);
    await blocker.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'bookmark',$4,0,null)`, [COLLECTION, node.id, currentRevision, currentPayload]);
    const pending = blackBox(server.origin).push({ idempotencyKey: 'p3-13-race-current',
      request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
        baseRevision: node.revision, opId: `p3-13-race-${randomUUID()}`,
        base: { title: 'Base', url: 'https://example.test/base' },
        value: { title: 'Base', url: 'https://example.test/incoming' } }) });
    await blocker.query('commit');
    blocker.release();
    const merged = await pending;
    assert.equal(result(merged.body).results[0]?.status, 'rebased');
    const row = (await isolated.runtime.pool.query('select title,url from nodes where id=$1', [node.id])).rows[0];
    assert.deepEqual(row, { title: 'Server race', url: 'https://example.test/incoming' });

    const deletedNode = await seedNode('folder', { title: 'Delete race' });
    const deleteContext = await context();
    const deleteServer = await start(deleteContext);
    const deleter = await isolated.runtime.pool.connect();
    await deleter.query('begin');
    const deletedPayload = { ...deletedNode.payload, deletedAt: '2026-07-26T02:30:00.000Z',
      deletedCommitOrdinal: '1', resourceRevision: `p3-13-deleted-${randomUUID()}` };
    await deleter.query(`update nodes set deleted_at=$2,deleted_commit_ordinal=1,
      resource_revision=$3,payload_json=$4 where id=$1`, [deletedNode.id,
      new Date('2026-07-26T02:30:00.000Z'), deletedPayload.resourceRevision, deletedPayload]);
    await deleter.query(`insert into sync_node_revision_history
      (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
      values ($1,$2,$3,'folder',$4,1,null)`, [COLLECTION, deletedNode.id,
      deletedPayload.resourceRevision, deletedPayload]);
    const deletePending = blackBox(deleteServer.origin).push({ idempotencyKey: 'p3-13-delete-race',
      request: syncNodeUpdatePushRequest({ sessionId: deleteContext.session.sessionId,
        replicaId: deleteContext.replica.replicaId, collectionId: COLLECTION, targetId: deletedNode.id,
        baseRevision: deletedNode.revision, opId: `p3-13-delete-race-${randomUUID()}`,
        base: { title: 'Delete race' }, value: { title: 'Incoming' } }) });
    await deleter.query('commit');
    deleter.release();
    const deleteResult = await deletePending;
    assert.equal(deleteResult.status, 200);
    assert.equal(result(deleteResult.body).results[0]?.status, 'conflicted');
    assert.equal(typeof result(deleteResult.body).results[0]?.conflictId, 'string');
    assert.equal((await isolated.runtime.pool.query('select deleted_at from nodes where id=$1', [deletedNode.id]))
      .rows[0].deleted_at instanceof Date, true);
  });

  test('P3-13 rejects managed-bookmarks subtree content updates unless deployment and Replica write capability allow', async () => {
    const managed = await seedNode('folder', { title: 'Managed update parent' });
    const child = await seedNode('bookmark', { title: 'Managed child', url: 'https://example.test/managed-child',
      parentId: managed.id });
    const nested = await seedNode('folder', { title: 'Managed nested', parentId: managed.id });
    const deep = await seedNode('bookmark', { title: 'Managed deep', url: 'https://example.test/managed-deep',
      parentId: nested.id });
    await isolated.runtime.pool.query('update nodes set payload_json=$2 where id=$1',
      [managed.id, { ...managed.payload, folderRole: 'managed-bookmarks' }]);

    for (const [label, target] of [
      ['managed folder itself', managed],
      ['direct child', child],
      ['deep descendant', deep],
    ] as const) {
      // COLP opaqueId/idempotency-key tokens only allow [A-Za-z0-9._~-]; the
      // human label stays in assertion messages only.
      const slug = label.replaceAll(' ', '-');
      const value = await context();
      const server = await start(value);
      const before = await facts(value.replica.replicaId, target.id);
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-13-managed-update-${slug}`,
        request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
          replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: target.id,
          baseRevision: target.revision, opId: `p3-13-managed-update-${slug}-${randomUUID()}`,
          base: { title: target.payload.title as string }, value: { title: 'Managed overwrite' } }) });
      assert.notEqual(response.status, 200, label);
      assert.equal((response.body as Problem).code, 'node_read_only', label);
      assert.deepEqual(await facts(value.replica.replicaId, target.id), before, label);
    }

    const viewer = await context('viewer');
    const viewerServer = await start(viewer, { managedBookmarkWrites: true });
    const viewerBefore = await facts(viewer.replica.replicaId, deep.id);
    const viewerDenied = await blackBox(viewerServer.origin).push({ idempotencyKey: 'p3-13-managed-update-viewer',
      request: syncNodeUpdatePushRequest({ sessionId: viewer.session.sessionId,
        replicaId: viewer.replica.replicaId, collectionId: COLLECTION, targetId: deep.id,
        baseRevision: deep.revision, opId: `p3-13-managed-update-viewer-${randomUUID()}`,
        base: { title: deep.payload.title as string }, value: { title: 'Viewer overwrite' } }) });
    assert.notEqual(viewerDenied.status, 200);
    assert.deepEqual(await facts(viewer.replica.replicaId, deep.id), viewerBefore);

    const allowedContext = await context();
    const allowedServer = await start(allowedContext, { managedBookmarkWrites: true });
    const allowed = await blackBox(allowedServer.origin).push({ idempotencyKey: 'p3-13-managed-update-allowed',
      request: syncNodeUpdatePushRequest({ sessionId: allowedContext.session.sessionId,
        replicaId: allowedContext.replica.replicaId, collectionId: COLLECTION, targetId: deep.id,
        baseRevision: deep.revision, opId: `p3-13-managed-update-allowed-${randomUUID()}`,
        base: { title: deep.payload.title as string }, value: { title: 'Managed allowed' } }) });
    assert.equal(allowed.status, 200);
    assert.equal(result(allowed.body).results[0]?.status, 'applied');
    assert.equal((await isolated.runtime.pool.query('select title from nodes where id=$1', [deep.id]))
      .rows[0].title, 'Managed allowed');
  }, 20_000);

  test('rolls back after history load, canonical resource, Operation, and receipt finalization faults', async () => {
    for (const phase of ['current_history_loaded', 'node', 'operation', 'effect_built',
      'effect_persisted', 'effect_pages_persisted', 'before_receipt_finalize'] as const) {
      const node = await seedNode('bookmark', { title: `Fault ${phase}`, url: 'https://example.test/fault' });
      const value = await context();
      const before = await facts(value.replica.replicaId, node.id);
      const server = await start(value, { failAt: phase });
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-13-fault-${phase}`,
        request: syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
          replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
          baseRevision: node.revision, opId: `p3-13-fault-${phase}-${randomUUID()}`,
          base: { title: `Fault ${phase}` }, value: { title: `Changed ${phase}` } }) });
      assert.notEqual(response.status, 200);
      assert.deepEqual(await facts(value.replica.replicaId, node.id), before, phase);
    }
  });

  test('recovers a committed update after HTTP response loss with one history and canonical side effect set', async () => {
    const node = await seedNode('folder', { title: 'Response loss' });
    const value = await context();
    let release!: () => void;
    let responseReady!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { responseReady = resolve; });
    const lossy = await start(value, { responseGate: gate, onResponseReady: responseReady });
    const request = syncNodeUpdatePushRequest({ sessionId: value.session.sessionId,
      replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
      baseRevision: node.revision, opId: `p3-13-loss-${randomUUID()}`,
      base: { title: 'Response loss' }, value: { title: 'Committed once' } });
    const controller = new AbortController();
    const pending = blackBox(lossy.origin, (input, init) => fetch(input, { ...init, signal: controller.signal }))
      .push({ idempotencyKey: 'p3-13-loss-key', request });
    await ready;
    controller.abort();
    release();
    await assert.rejects(pending, /abort/iu);
    await lossy.app.close();
    const committed = await facts(value.replica.replicaId, node.id);
    assert.equal(committed.receipts, 1);
    assert.equal(committed.history, 2);
    const restarted = await start(value);
    const replay = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-13-loss-key', request });
    assert.deepEqual(replay.body, committed.receipt);
    assert.deepEqual(await facts(value.replica.replicaId, node.id), committed);
  }, 20_000);

  test('P3-14 moves canonical Node identity across parents and reorders it with exact restart replay', async () => {
    const source = await seedNode('folder', { title: 'Move source' });
    const target = await seedNode('folder', { title: 'Move target',
      extensions: { 'https://extensions.example/p3-14': { preserved: ['unknown', { depth: 2 }] } } });
    const child = await seedNode('bookmark', { title: 'Move identity', url: 'https://example.test/move',
      extensions: { 'https://extensions.example/p3-14-child': { preserved: ['unknown', { depth: 2 }] } } });
    const anchor = await seedNode('separator');
    const childPayload = { ...child.payload, parentId: source.id, position: 'M' };
    const anchorPayload = { ...anchor.payload, parentId: target.id, position: 'U' };
    await isolated.runtime.pool.query('update nodes set parent_id=$2,position_token=$3,payload_json=$4 where id=$1',
      [child.id, source.id, 'M', childPayload]);
    await isolated.runtime.pool.query('update nodes set parent_id=$2,position_token=$3,payload_json=$4 where id=$1',
      [anchor.id, target.id, 'U', anchorPayload]);

    const value = await context();
    const firstServer = await start(value);
    const request = syncNodeMovePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: child.id, baseRevision: child.revision,
      newParentId: target.id, beforeId: anchor.id,
      baseSourceParentRevision: source.payload.childrenRevision as string,
      baseTargetParentRevision: target.payload.childrenRevision as string,
      opId: `p3-14-cross-${randomUUID()}`,
    });
    const first = await blackBox(firstServer.origin).push({ idempotencyKey: 'p3-14-cross-key', request });
    assert.equal(first.status, 200, 'code' in first.body ? first.body.code : 'unexpected response');
    const applied = result(first.body).results[0]!;
    assert.equal(applied.status, 'applied');
    assert.equal(applied.targetId, child.id);
    const moved = (await isolated.runtime.pool.query(`select parent_id,position_token,resource_revision,payload_json
      from nodes where id=$1`, [child.id])).rows[0];
    assert.equal(moved.parent_id, target.id);
    assert.ok(moved.position_token < 'U');
    assert.notEqual(moved.resource_revision, child.revision);
    assert.deepEqual(moved.payload_json.extensions, child.payload.extensions);
    const parentRows = (await isolated.runtime.pool.query(`select id,children_revision from nodes
      where id=any($1::text[]) order by id`, [[source.id, target.id]])).rows;
    assert.notEqual(parentRows.find((row) => row.id === source.id)?.children_revision,
      source.payload.childrenRevision);
    assert.notEqual(parentRows.find((row) => row.id === target.id)?.children_revision,
      target.payload.childrenRevision);
    const operationRow = (await isolated.runtime.pool.query(`select operation.operation_type,payload.payload_json
      from operations operation join operation_payloads payload using (operation_id)
      where operation.operation_id=$1`, [request.operations[0]!.opId])).rows[0];
    assert.equal(operationRow.operation_type, 'resource.move');
    assert.equal(operationRow.payload_json.action, 'move');
    assert.equal(operationRow.payload_json.parentId, target.id);
    const beforeReplay = await facts(value.replica.replicaId, child.id);
    await firstServer.app.close();
    const restarted = await start(value);
    const replay = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-14-cross-key', request });
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(value.replica.replicaId, child.id), beforeReplay);

    const reorderContext = await context();
    const reorderServer = await start(reorderContext);
    const currentSource = parentRows.find((row) => row.id === target.id)!.children_revision as string;
    const reorder = await blackBox(reorderServer.origin).push({ idempotencyKey: 'p3-14-reorder-key',
      request: syncNodeMovePushRequest({ sessionId: reorderContext.session.sessionId,
        replicaId: reorderContext.replica.replicaId, collectionId: COLLECTION, sequence: 1,
        targetId: child.id, baseRevision: moved.resource_revision, newParentId: target.id,
        afterId: anchor.id, baseSourceParentRevision: currentSource,
        baseTargetParentRevision: currentSource, opId: `p3-14-reorder-${randomUUID()}` }) });
    assert.equal(reorder.status, 200);
    const reordered = (await isolated.runtime.pool.query('select position_token from nodes where id=$1', [child.id])).rows[0];
    assert.ok(reordered.position_token > 'U');
    recordPhase3SyncPushScenario('move');
  }, 20_000);

  test('P3-14 rejects stale move fences, Root/cycles/foreign parents and rolls back injected faults', async () => {
    const source = await seedNode('folder', { title: 'Reject source' });
    const descendant = await seedNode('folder', { title: 'Reject descendant' });
    const descendantPayload = { ...descendant.payload, parentId: source.id };
    await isolated.runtime.pool.query('update nodes set parent_id=$2,payload_json=$3 where id=$1',
      [descendant.id, source.id, descendantPayload]);
    const rootChildrenRevision = (await isolated.runtime.pool.query('select children_revision from nodes where id=$1',
      [ROOT])).rows[0].children_revision as string;
    const before = (await isolated.runtime.pool.query('select to_jsonb(n) node from nodes n where id=$1', [source.id])).rows[0].node;
    for (const item of [
      { label: 'stale-node', targetId: source.id, baseRevision: 'stale-node-r9', newParentId: ROOT,
        sourceRevision: source.payload.childrenRevision, targetRevision: 'root-children-r1' },
      { label: 'stale-source', targetId: source.id, baseRevision: source.revision, newParentId: ROOT,
        sourceRevision: 'stale-children-r9', targetRevision: 'root-children-r1' },
      { label: 'cycle', targetId: source.id, baseRevision: source.revision, newParentId: descendant.id,
        sourceRevision: rootChildrenRevision, targetRevision: descendant.payload.childrenRevision },
      { label: 'stale-anchor', targetId: source.id, baseRevision: source.revision, newParentId: ROOT,
        sourceRevision: rootChildrenRevision, targetRevision: rootChildrenRevision, afterId: 'missing-anchor' },
      { label: 'root', targetId: ROOT, baseRevision: 'root-r1', newParentId: source.id,
        sourceRevision: 'root-children-r1', targetRevision: source.payload.childrenRevision },
      { label: 'foreign', targetId: source.id, baseRevision: source.revision, newParentId: 'foreign-parent',
        sourceRevision: source.payload.childrenRevision, targetRevision: 'foreign-children-r1' },
    ]) {
      const value = await context();
      const server = await start(value);
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-14-${item.label}-${randomUUID()}`,
        request: syncNodeMovePushRequest({ sessionId: value.session.sessionId,
          replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: item.targetId,
          baseRevision: item.baseRevision as string, newParentId: item.newParentId,
          ...('afterId' in item ? { afterId: item.afterId } : {}),
          baseSourceParentRevision: item.sourceRevision as string,
          baseTargetParentRevision: item.targetRevision as string,
          opId: `p3-14-${item.label}-${randomUUID()}` }) });
      assert.notEqual(response.status, 200, item.label);
      assert.ok(['resource_not_found', 'revision_conflict', 'position_context_stale', 'invalid_document']
        .includes((response.body as Problem).code), item.label);
    }
    assert.deepEqual((await isolated.runtime.pool.query('select to_jsonb(n) node from nodes n where id=$1',
      [source.id])).rows[0].node, before);

    const rollbackTarget = await seedNode('folder', { title: 'Rollback target' });
    for (const phase of ['move_facts_loaded', 'node', 'operation', 'effect_built',
      'effect_persisted', 'effect_pages_persisted', 'before_receipt_finalize'] as const) {
      const value = await context();
      const state = await facts(value.replica.replicaId, source.id);
      const server = await start(value, { failAt: phase });
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-14-fault-${phase}`,
        request: syncNodeMovePushRequest({ sessionId: value.session.sessionId,
          replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: source.id,
          baseRevision: source.revision, newParentId: rollbackTarget.id,
          baseSourceParentRevision: rootChildrenRevision,
          baseTargetParentRevision: rollbackTarget.payload.childrenRevision as string,
          opId: `p3-14-fault-${phase}-${randomUUID()}` }) });
      assert.notEqual(response.status, 200);
      assert.deepEqual(await facts(value.replica.replicaId, source.id), state, phase);
    }
  }, 20_000);

  test('P3-14 serializes competing positions and enforces managed-bookmark deployment policy', async () => {
    const target = await seedNode('folder', { title: 'Concurrent target' });
    const anchor = await seedNode('separator');
    const firstNode = await seedNode('bookmark', { title: 'Concurrent first', url: 'https://example.test/first' });
    const secondNode = await seedNode('bookmark', { title: 'Concurrent second', url: 'https://example.test/second' });
    await isolated.runtime.pool.query('update nodes set parent_id=$2,payload_json=$3 where id=$1',
      [anchor.id, target.id, { ...anchor.payload, parentId: target.id }]);
    const concurrentRevisions = (await isolated.runtime.pool.query(`select id,children_revision from nodes
      where id=any($1::text[])`, [[ROOT, target.id]])).rows;
    const rootRevision = concurrentRevisions.find((row) => row.id === ROOT)!.children_revision as string;
    const targetRevision = concurrentRevisions.find((row) => row.id === target.id)!.children_revision as string;
    const firstContext = await context();
    const secondContext = await context();
    const firstServer = await start(firstContext);
    const secondServer = await start(secondContext);
    const requests = [
      { context: firstContext, server: firstServer, node: firstNode },
      { context: secondContext, server: secondServer, node: secondNode },
    ].map(({ context: moveContext, server, node: moving }, index) => blackBox(server.origin).push({
      idempotencyKey: `p3-14-concurrent-${index}`,
      request: syncNodeMovePushRequest({ sessionId: moveContext.session.sessionId,
        replicaId: moveContext.replica.replicaId, collectionId: COLLECTION,
        targetId: moving.id, baseRevision: moving.revision, newParentId: target.id,
        beforeId: anchor.id, baseSourceParentRevision: rootRevision,
        baseTargetParentRevision: targetRevision,
        opId: `p3-14-concurrent-${index}-${randomUUID()}` }),
    }));
    const outcomes = await Promise.all(requests);
    assert.equal(outcomes.filter((outcome) => outcome.status === 200).length, 1);
    assert.equal(outcomes.filter((outcome) => (outcome.body as Problem).code === 'position_context_stale').length, 1);
    const ordered = (await isolated.runtime.pool.query(`select id from nodes where parent_id=$1 and deleted_at is null
      order by position_token collate "C"`, [target.id])).rows.map((row) => row.id);
    assert.equal(ordered.at(-1), anchor.id);
    assert.equal(ordered.length, 2);

    const managed = await seedNode('folder', { title: 'Managed target' });
    const managedCandidate = await seedNode('bookmark', { title: 'Managed candidate',
      url: 'https://example.test/managed-candidate' });
    const managedPayload = { ...managed.payload, folderRole: 'managed-bookmarks' };
    await isolated.runtime.pool.query('update nodes set payload_json=$2 where id=$1', [managed.id, managedPayload]);
    const managedRootRevision = (await isolated.runtime.pool.query('select children_revision from nodes where id=$1',
      [ROOT])).rows[0].children_revision as string;
    const deniedContext = await context();
    const deniedServer = await start(deniedContext);
    const denied = await blackBox(deniedServer.origin).push({ idempotencyKey: 'p3-14-managed-denied',
      request: syncNodeMovePushRequest({ sessionId: deniedContext.session.sessionId,
        replicaId: deniedContext.replica.replicaId, collectionId: COLLECTION, targetId: managedCandidate.id,
        baseRevision: managedCandidate.revision, newParentId: managed.id,
        baseSourceParentRevision: managedRootRevision,
        baseTargetParentRevision: managed.payload.childrenRevision as string,
        opId: `p3-14-managed-denied-${randomUUID()}` }) });
    assert.notEqual(denied.status, 200);
    assert.equal((denied.body as Problem).code, 'node_read_only');
    const allowedContext = await context();
    const allowedServer = await start(allowedContext, { managedBookmarkWrites: true });
    const allowed = await blackBox(allowedServer.origin).push({ idempotencyKey: 'p3-14-managed-allowed',
      request: syncNodeMovePushRequest({ sessionId: allowedContext.session.sessionId,
        replicaId: allowedContext.replica.replicaId, collectionId: COLLECTION,
        targetId: managedCandidate.id, baseRevision: managedCandidate.revision, newParentId: managed.id,
        baseSourceParentRevision: managedRootRevision,
        baseTargetParentRevision: managed.payload.childrenRevision as string,
        opId: `p3-14-managed-allowed-${randomUUID()}` }) });
    assert.equal(allowed.status, 200);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id=$1',
      [managedCandidate.id])).rows[0].parent_id, managed.id);
  }, 20_000);

  test('P3-15 deletes each leaf kind and an empty Folder with one durable receipt and tombstone', async () => {
    for (const kind of ['bookmark', 'separator', 'folder'] as const) {
      const target = await seedNode(kind, kind === 'bookmark'
        ? { title: 'Delete leaf', url: 'https://example.test/delete-leaf' }
        : kind === 'folder' ? { title: 'Delete empty Folder' } : {});
      const value = await context();
      const server = await start(value);
      const request = syncNodeDeletePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, targetId: target.id, baseRevision: target.revision,
        opId: `p3-15-${kind}-${randomUUID()}`,
      });
      const response = await blackBox(server.origin).push({
        idempotencyKey: `p3-15-${kind}-${randomUUID()}`, request,
      });
      assert.equal(response.status, 200, kind);
      const applied = result(response.body).results[0]!;
      assert.equal(applied.status, 'applied');
      assert.equal(applied.targetId, target.id);
      const rows = await isolated.runtime.pool.query(`select n.deleted_at,n.deleted_commit_ordinal,
        n.resource_revision,t.operation_id,t.delete_revision,t.delete_commit_ordinal,t.affected_count,
        t.scope,t.purge_after,t.deleted_at tombstone_deleted_at,t.payload_json
        from nodes n join sync_node_tombstones t on t.collection_id=n.collection_id and t.target_id=n.id
        where n.id=$1`, [target.id]);
      assert.equal(rows.rowCount, 1);
      const row = rows.rows[0];
      assert.ok(row.deleted_at instanceof Date);
      assert.equal(String(row.deleted_commit_ordinal), String(row.delete_commit_ordinal));
      assert.equal(row.resource_revision, row.delete_revision);
      assert.equal(row.operation_id, request.operations[0]!.opId);
      assert.equal(row.affected_count, 1);
      assert.equal(row.scope, 'single');
      assert.ok(row.purge_after.getTime() - row.tombstone_deleted_at.getTime() >= 30 * 24 * 60 * 60 * 1000);
      assert.equal(row.payload_json.title, undefined);
      assert.equal(row.payload_json.url, undefined);
      assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from resource_id_ledger
        where resource_id=$1 and resource_type='node'`, [target.id])).rows[0].count, 1);
    }
    recordPhase3SyncPushScenario('delete');
  });

  test('P3-38 persists the deployment-configured tombstone retention window', async () => {
    const target = await seedNode('bookmark', {
      title: 'Configured retention', url: 'https://example.test/configured-retention',
    });
    const value = await context();
    const server = await start(value, { tombstoneRetentionSeconds: 2_592_000 });
    const response = await blackBox(server.origin).push({
      idempotencyKey: `p3-38-retention-${randomUUID()}`,
      request: syncNodeDeletePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, targetId: target.id, baseRevision: target.revision,
        opId: `p3-38-retention-${randomUUID()}`,
      }),
    });
    assert.equal(response.status, 200);
    const row = (await isolated.runtime.pool.query<{ deleted_at: Date; purge_after: Date }>(`
      select deleted_at,purge_after from sync_node_tombstones where target_id=$1`, [target.id])).rows[0];
    assert.ok(row);
    assert.equal(row.purge_after.getTime() - row.deleted_at.getTime(), 2_592_000_000);
  });

  test('DS-04 observed subtree rejects unobserved descendant revisions, new members and legacy multi-member deletes', async () => {
    await verifyObservedSubtreeSafety({ runtime: isolated.runtime, collectionId: COLLECTION, accountId: ACCOUNT, subjectId: SUBJECT,
      seedNode, context, start, blackBox, result, openConflict });
  });

  test('P3-15 derives and tombstones every subtree member with safe unknown-extension payloads', async () => {
    const namespace = 'https://extensions.example/p3-15';
    const folder = await seedNode('folder', { title: 'Delete subtree root',
      extensions: { [namespace]: { preserved: ['safe', { depth: 2 }] } } });
    const nested = await seedNode('folder', { title: 'Nested', parentId: folder.id });
    const bookmark = await seedNode('bookmark', { title: 'Secret title',
      url: 'https://example.test/must-not-enter-tombstone?token=secret', parentId: nested.id,
      extensions: { [namespace]: { unknown: { nested: ['round-trip'] } } } });
    const separator = await seedNode('separator', { parentId: folder.id });
    const members = [folder.id, nested.id, bookmark.id, separator.id].sort();
    const value = await context();
    const server = await start(value);
    const request = syncNodeDeletePushRequest({
      sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
      collectionId: COLLECTION, targetId: folder.id, baseRevision: folder.revision,
      opId: `p3-15-subtree-${randomUUID()}`, subtree: true,
      source: await observeSubtree(isolated.runtime.db, folder.id),
    });
    const first = await blackBox(server.origin).push({ idempotencyKey: 'p3-15-subtree-key', request });
    assert.equal(first.status, 200);
    const rows = (await isolated.runtime.pool.query(`select target_id,root_target_id,operation_id,
      delete_commit_ordinal,affected_count,scope,payload_json from sync_node_tombstones
      where operation_id=$1 order by target_id`, [request.operations[0]!.opId])).rows;
    assert.deepEqual(rows.map((row) => row.target_id), members);
    assert.ok(rows.every((row) => row.root_target_id === folder.id
      && row.operation_id === request.operations[0]!.opId && row.scope === 'subtree'
      && row.affected_count === members.length));
    assert.equal(new Set(rows.map((row) => String(row.delete_commit_ordinal))).size, 1);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from nodes
      where id=any($1::text[]) and deleted_at is not null`, [members])).rows[0].count, members.length);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from operations
      where operation_id=$1 and operation_type='resource.delete'`, [request.operations[0]!.opId])).rows[0].count, 1);
    const bookmarkPayload = rows.find((row) => row.target_id === bookmark.id)!.payload_json;
    assert.deepEqual(bookmarkPayload.extensions, { [namespace]: { unknown: { nested: ['round-trip'] } } });
    assert.equal(bookmarkPayload.title, undefined);
    assert.equal(bookmarkPayload.url, undefined);
    assert.deepEqual(Object.keys(bookmarkPayload).sort(), [
      'affectedCount', 'collectionId', 'deleteCommitOrdinal', 'deleteRevision', 'extensions',
      'kind', 'operationId', 'resourceType', 'rootTargetId', 'scope', 'targetId',
    ]);
    await assert.rejects(isolated.runtime.pool.query(`update sync_node_tombstones
      set delete_cursor='forged-cursor' where collection_id=$1 and target_id=$2`,
    [COLLECTION, bookmark.id]), /immutable/i);
    const consume = await isolated.runtime.pool.connect();
    try {
      await consume.query('begin');
      assert.equal((await consume.query(`delete from sync_node_tombstones
        where collection_id=$1 and target_id=$2 and payload_purged_at is null`,
      [COLLECTION, bookmark.id])).rowCount, 1);
      await consume.query('rollback');
      await consume.query('begin');
      await consume.query(`update sync_node_tombstones
        set payload_json = jsonb_set(payload_json, '{extensions}', '{}'::jsonb, true),
            payload_purged_at = now(), purge_state_revision = 1
        where collection_id=$1 and target_id=$2`, [COLLECTION, bookmark.id]);
      await assert.rejects(consume.query(`delete from sync_node_tombstones
        where collection_id=$1 and target_id=$2`, [COLLECTION, bookmark.id]),
      /must not be deleted/i);
      await consume.query('rollback');
    } finally {
      consume.release();
    }
    await assert.rejects(isolated.runtime.pool.query(`update nodes set deleted_at=null
      where collection_id=$1 and id=$2`, [COLLECTION, bookmark.id]), /must not be resurrected/i);

    const afterFirst = await facts(value.replica.replicaId, folder.id);
    await server.app.close();
    const restarted = await start(value);
    const replay = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-15-subtree-key', request });
    assert.deepEqual(replay, first);
    assert.deepEqual(await facts(value.replica.replicaId, folder.id), afterFirst);

    const denied = await blackBox(restarted.origin).push({ idempotencyKey: 'p3-15-new-delete-intent',
      request: syncNodeDeletePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, sequence: 2, targetId: folder.id,
        baseRevision: folder.revision, opId: `p3-15-new-delete-${randomUUID()}`, subtree: true }) });
    assert.notEqual(denied.status, 200);
    assert.equal((denied.body as Problem).code, 'resource_not_found');
    const afterNewIntent = await facts(value.replica.replicaId, folder.id);
    assert.equal(afterNewIntent.receipts, 1);
    assert.equal(afterNewIntent.next_sequence, 2);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from sync_node_tombstones
      where root_target_id=$1`, [folder.id])).rows[0].count, members.length);
  }, 20_000);

  test('P3-15 rejects stale/non-empty/oversized deletes and keeps the complete old tree readable', async () => {
    const folder = await seedNode('folder', { title: 'Protected subtree' });
    const child = await seedNode('bookmark', { title: 'Child', url: 'https://example.test/child', parentId: folder.id });
    const value = await context();
    const server = await start(value);
    for (const [label, request] of [
      ['stale', syncNodeDeletePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: child.id,
        baseRevision: 'stale-r1', opId: `p3-15-stale-${randomUUID()}` })],
      ['non-empty', syncNodeDeletePushRequest({ sessionId: value.session.sessionId,
        replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: folder.id,
        baseRevision: folder.revision, opId: `p3-15-non-empty-${randomUUID()}` })],
    ] as const) {
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-15-${label}`, request });
      assert.notEqual(response.status, 200, label);
    }
    const oversized = await seedNode('bookmark', { title: 'Oversized', url: 'https://example.test/oversized',
      extensions: { 'https://extensions.example/oversized': { value: 'x'.repeat(140_000) } } });
    const oversizedContext = await context();
    const oversizedServer = await start(oversizedContext);
    const denied = await blackBox(oversizedServer.origin).push({ idempotencyKey: 'p3-15-oversized',
      request: syncNodeDeletePushRequest({ sessionId: oversizedContext.session.sessionId,
        replicaId: oversizedContext.replica.replicaId, collectionId: COLLECTION, targetId: oversized.id,
        baseRevision: oversized.revision, opId: `p3-15-oversized-${randomUUID()}` }) });
    assert.notEqual(denied.status, 200);
    assert.equal((denied.body as Problem).code, 'payload_too_large');
    const oldTree = await isolated.runtime.pool.query(`select id,resource_revision from nodes
      where id=any($1::text[]) and deleted_at is null order by id`, [[folder.id, child.id, oversized.id]]);
    assert.equal(oldTree.rowCount, 3);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from sync_node_tombstones
      where target_id=any($1::text[])`, [[folder.id, child.id, oversized.id]])).rows[0].count, 0);
  });

  test('P3-15 serializes update/delete and move/delete races without partial tombstones', async () => {
    const updateTarget = await seedNode('bookmark', { title: 'Race update', url: 'https://example.test/race-update' });
    const updateContext = await context();
    const deleteContext = await context();
    const updateServer = await start(updateContext);
    const deleteServer = await start(deleteContext);
    const [updated, deleted] = await Promise.all([
      blackBox(updateServer.origin).push({ idempotencyKey: 'p3-15-race-update',
        request: syncNodeUpdatePushRequest({ sessionId: updateContext.session.sessionId,
          replicaId: updateContext.replica.replicaId, collectionId: COLLECTION, targetId: updateTarget.id,
          baseRevision: updateTarget.revision, opId: `p3-15-race-update-${randomUUID()}`,
          base: { title: 'Race update' }, value: { title: 'Race updated' } }) }),
      blackBox(deleteServer.origin).push({ idempotencyKey: 'p3-15-race-delete',
        request: syncNodeDeletePushRequest({ sessionId: deleteContext.session.sessionId,
          replicaId: deleteContext.replica.replicaId, collectionId: COLLECTION, targetId: updateTarget.id,
          baseRevision: updateTarget.revision, opId: `p3-15-race-delete-${randomUUID()}` }) }),
    ]);
    // Sync Push returns HTTP 200 even when the loser is recorded as an open
    // conflict (per-operation status in the batch body); count applied
    // operations, not HTTP statuses, so the delete-first ordering holds too.
    const appliedCount = [updated, deleted].filter((item) =>
      (item.body as { results?: ReadonlyArray<{ status?: string }> }).results?.[0]?.status === 'applied',
    ).length;
    assert.equal(appliedCount, 1);
    const updateRow = (await isolated.runtime.pool.query('select deleted_at from nodes where id=$1', [updateTarget.id])).rows[0];
    const updateTombstones = (await isolated.runtime.pool.query(`select count(*)::int count
      from sync_node_tombstones where target_id=$1`, [updateTarget.id])).rows[0].count;
    assert.equal(updateTombstones, updateRow.deleted_at === null ? 0 : 1);

    const moveTarget = await seedNode('bookmark', { title: 'Race move', url: 'https://example.test/race-move' });
    const moveParent = await seedNode('folder', { title: 'Race target parent' });
    const rootRevision = (await isolated.runtime.pool.query('select children_revision from nodes where id=$1', [ROOT]))
      .rows[0].children_revision as string;
    const moveContext = await context();
    const moveDeleteContext = await context();
    const moveServer = await start(moveContext);
    const moveDeleteServer = await start(moveDeleteContext);
    const [moved, moveDeleted] = await Promise.all([
      blackBox(moveServer.origin).push({ idempotencyKey: 'p3-15-race-move',
        request: syncNodeMovePushRequest({ sessionId: moveContext.session.sessionId,
          replicaId: moveContext.replica.replicaId, collectionId: COLLECTION, targetId: moveTarget.id,
          baseRevision: moveTarget.revision, newParentId: moveParent.id,
          baseSourceParentRevision: rootRevision,
          baseTargetParentRevision: moveParent.payload.childrenRevision as string,
          opId: `p3-15-race-move-${randomUUID()}` }) }),
      blackBox(moveDeleteServer.origin).push({ idempotencyKey: 'p3-15-race-move-delete',
        request: syncNodeDeletePushRequest({ sessionId: moveDeleteContext.session.sessionId,
          replicaId: moveDeleteContext.replica.replicaId, collectionId: COLLECTION, targetId: moveTarget.id,
          baseRevision: moveTarget.revision, opId: `p3-15-race-move-delete-${randomUUID()}` }) }),
    ]);
    const appliedMoveCount = [moved, moveDeleted].filter((item) =>
      (item.body as { results?: ReadonlyArray<{ status?: string }> }).results?.[0]?.status === 'applied',
    ).length;
    assert.equal(appliedMoveCount, 1);
    const moveRow = (await isolated.runtime.pool.query('select deleted_at from nodes where id=$1', [moveTarget.id])).rows[0];
    const moveTombstones = (await isolated.runtime.pool.query(`select count(*)::int count
      from sync_node_tombstones where target_id=$1`, [moveTarget.id])).rows[0].count;
    assert.equal(moveTombstones, moveRow.deleted_at === null ? 0 : 1);
  }, 20_000);

  test('P3-15 rolls back every Node revision and side effect at each delete fault boundary', async () => {
    for (const phase of ['delete_facts_loaded', 'node', 'operation', 'tombstone', 'effect_built',
      'effect_persisted', 'effect_pages_persisted', 'before_receipt_finalize'] as const) {
      const folder = await seedNode('folder', { title: `Fault ${phase}` });
      const child = await seedNode('bookmark', { title: `Fault child ${phase}`,
        url: 'https://example.test/fault-delete', parentId: folder.id });
      const value = await context();
      const before = (await isolated.runtime.pool.query(`select id,resource_revision,children_revision,
        deleted_at,deleted_commit_ordinal,payload_json from nodes where id=any($1::text[]) order by id`,
      [[folder.id, child.id]])).rows;
      const sideEffects = await facts(value.replica.replicaId, folder.id);
      const server = await start(value, { failAt: phase });
      const response = await blackBox(server.origin).push({ idempotencyKey: `p3-15-fault-${phase}`,
        request: syncNodeDeletePushRequest({ sessionId: value.session.sessionId,
          replicaId: value.replica.replicaId, collectionId: COLLECTION, targetId: folder.id,
          baseRevision: folder.revision, opId: `p3-15-fault-${phase}-${randomUUID()}`, subtree: true,
          source: await observeSubtree(isolated.runtime.db, folder.id) }) });
      assert.notEqual(response.status, 200);
      assert.deepEqual((await isolated.runtime.pool.query(`select id,resource_revision,children_revision,
        deleted_at,deleted_commit_ordinal,payload_json from nodes where id=any($1::text[]) order by id`,
      [[folder.id, child.id]])).rows, before, phase);
      assert.deepEqual(await facts(value.replica.replicaId, folder.id), sideEffects, phase);
    }
  }, 20_000);

  test('DS-05 Product conflict resolution preserves queued browser Sequence and replays its server author', async () => {
    await verifyResolutionLaneSafety({ runtime: isolated.runtime, collectionId: COLLECTION, accountId: ACCOUNT, subjectId: SUBJECT,
      seedNode, context, start, blackBox, result, openConflict });
  });

  test('P3-18 resolves every allowed choice through one new canonical Operation', async () => {
    const cases = [
      { resolution: 'server' as const, expectedTitle: 'P3-18 server' },
      { resolution: 'incoming' as const, expectedTitle: 'P3-18 incoming' },
      { resolution: 'custom' as const, value: 'P3-18 custom', expectedTitle: 'P3-18 custom' },
      { resolution: 'both' as const, expectedTitle: 'P3-18 server' },
    ];
    for (const item of cases) {
      const opened = await openConflict();
      const before = await facts(opened.value.replica.replicaId, opened.node.id);
      const request: ConflictResolutionRequest = item.resolution === 'custom'
        ? { resolution: item.resolution, value: item.value, baseConflictRevision: opened.revision }
        : { resolution: item.resolution, baseConflictRevision: opened.revision };
      const resolved = await resolver(opened.value).resolve(resolveInput(opened, request));
      assert.equal(createValidatorRegistry().validate('conflictResolutionResult', resolved).valid, true);
      assert.equal(resolved.conflict.status, 'resolved');
      assert.notEqual(resolved.conflict.revision, opened.revision);
      assert.notEqual(resolved.operation.opId, before.receipt.operationId);
      assert.equal(resolved.operation.collectionId, COLLECTION);
      const after = await facts(opened.value.replica.replicaId, opened.node.id);
      assert.equal(after.operations, before.operations + 1);
      assert.equal(after.audits, before.audits + 1);
      assert.equal(after.outbox, before.outbox + 1);
      assert.equal(after.node.title, item.expectedTitle);
      const conflict = (await isolated.runtime.pool.query(`select status,resolution,resolved_by_operation_id,
        resolution_result_json from sync_conflicts where conflict_id=$1`, [opened.conflictId])).rows[0];
      assert.equal(conflict.status, 'resolved');
      assert.equal(conflict.resolution, item.resolution);
      assert.equal(conflict.resolved_by_operation_id, resolved.operation.opId);
      assert.deepEqual(conflict.resolution_result_json, resolved);
      const receipt = (await isolated.runtime.pool.query(`select principal_id,conflict_id,conflict_revision,
        request_digest,result_digest,operation_id,result_json from sync_conflict_resolution_receipts
        where conflict_id=$1`, [opened.conflictId])).rows[0];
      assert.equal(receipt.principal_id, ACCOUNT);
      assert.equal(receipt.conflict_id, opened.conflictId);
      assert.equal(receipt.conflict_revision, opened.revision);
      assert.match(receipt.request_digest, /^[0-9a-f]{64}$/u);
      assert.match(receipt.result_digest, /^[0-9a-f]{64}$/u);
      assert.equal(receipt.operation_id, resolved.operation.opId);
      assert.deepEqual(receipt.result_json, resolved);
      if (item.resolution === 'both') {
        assert.equal(resolved.operation.type, 'create_node');
        const extension = resolved.operation.source?.extensions?.[
          'https://known.example/extensions/sync-conflict-resolution'
        ] as { readonly createdNodeId: string };
        assert.notEqual(extension.createdNodeId, opened.node.id);
        const duplicate = (await isolated.runtime.pool.query(`select id,parent_id,position_token,title
          from nodes where id=$1`, [extension.createdNodeId])).rows[0];
        assert.equal(duplicate.parent_id, ROOT);
        assert.equal(duplicate.title, 'P3-18 incoming');
        assert.equal(typeof duplicate.position_token, 'string');
        assert.equal((await isolated.runtime.pool.query(`select resource_type from resource_id_ledger
          where resource_id=$1`, [duplicate.id])).rows[0].resource_type, 'node');
      } else {
        assert.equal(resolved.operation.type, 'update_node_content');
      }
    }
  }, 30_000);

  test('P3-18 blocks conflict both-creation under managed-bookmarks ancestry unless the deployment capability allows', async () => {
    const opened = await openConflict();
    const managedParent = await seedNode('folder', { title: 'Managed both parent' });
    await isolated.runtime.pool.query('update nodes set payload_json=$2 where id=$1',
      [managedParent.id, { ...managedParent.payload, folderRole: 'managed-bookmarks' }]);
    await isolated.runtime.pool.query('update nodes set parent_id=$2,payload_json=$3 where id=$1',
      [opened.node.id, managedParent.id, { ...opened.node.payload, parentId: managedParent.id }]);

    const before = await facts(opened.value.replica.replicaId, opened.node.id);
    const childCount = (await isolated.runtime.pool.query(`select count(*)::int count from nodes
      where parent_id=$1`, [managedParent.id])).rows[0].count;
    await assert.rejects(
      resolver(opened.value).resolve(resolveInput(opened, {
        resolution: 'both', baseConflictRevision: opened.revision,
      })),
      (error: unknown) => error instanceof SyncConflictResolutionError && error.code === 'node_read_only',
    );
    assert.deepEqual(await facts(opened.value.replica.replicaId, opened.node.id), before);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from nodes
      where parent_id=$1`, [managedParent.id])).rows[0].count, childCount);
    assert.equal((await isolated.runtime.pool.query(`select status from sync_conflicts where conflict_id=$1`,
      [opened.conflictId])).rows[0].status, 'open');
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflict_resolution_receipts where conflict_id=$1`, [opened.conflictId])).rows[0].count, 0);

    const enabled = resolver(opened.value, undefined, true);
    const resolved = await enabled.resolve(resolveInput(opened, {
      resolution: 'both', baseConflictRevision: opened.revision,
    }));
    assert.equal(resolved.conflict.status, 'resolved');
    assert.equal(resolved.operation.type, 'create_node');
    const extension = resolved.operation.source?.extensions?.[
      'https://known.example/extensions/sync-conflict-resolution'
    ] as { readonly createdNodeId: string };
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from nodes
      where parent_id=$1`, [managedParent.id])).rows[0].count, childCount + 1);
    assert.equal((await isolated.runtime.pool.query('select parent_id from nodes where id=$1',
      [extension.createdNodeId])).rows[0].parent_id, managedParent.id);
  }, 30_000);

  test('P3-19 discovers the conflict URI Template and resolves every variant over real HTTP', async () => {
    for (const item of [
      { resolution: 'server' as const },
      { resolution: 'incoming' as const },
      { resolution: 'custom' as const, value: 'P3-19 custom' },
      { resolution: 'both' as const },
    ]) {
      const opened = await openConflict();
      const server = await start(opened.value);
      const before = await facts(opened.value.replica.replicaId, opened.node.id);
      const request: ConflictResolutionRequest = item.resolution === 'custom'
        ? { resolution: item.resolution, value: item.value, baseConflictRevision: opened.revision }
        : { resolution: item.resolution, baseConflictRevision: opened.revision };
      const input = { conflictId: opened.conflictId, sessionId: opened.value.session.sessionId,
        replicaId: opened.value.replica.replicaId, collectionId: COLLECTION,
        conflictRevision: opened.revision, idempotencyKey: `p3-19-${item.resolution}`, request };
      const first = await blackBox(server.origin).resolveConflict(input);
      assert.equal(first.status, 200);
      assert.ok('conflict' in first.body);
      const result = first.body as ConflictResolutionResult;
      assert.equal(result.conflict.id, opened.conflictId);
      assert.equal(result.conflict.status, 'resolved');
      assert.equal(createValidatorRegistry().validate('conflictResolutionResult', result).valid, true);
      const after = await facts(opened.value.replica.replicaId, opened.node.id);
      assert.equal(after.operations, before.operations + 1);
      assert.equal(after.history, before.history + (item.resolution === 'both' ? 0 : 1));
      assert.equal(result.operation.collectionId, COLLECTION);
      assert.equal(typeof result.cursor, 'string');
      const streamFact = (await isolated.runtime.pool.query(`select o.operation_id,o.commit_ordinal,
        c.resolved_by_operation_id,c.commit_ordinal conflict_commit_ordinal
        from operations o join sync_conflicts c on c.resolved_by_operation_id=o.operation_id
        where c.conflict_id=$1`, [opened.conflictId])).rows[0];
      assert.equal(streamFact.operation_id, result.operation.opId);
      assert.equal(streamFact.resolved_by_operation_id, result.operation.opId);
      assert.ok(BigInt(streamFact.commit_ordinal) > BigInt(streamFact.conflict_commit_ordinal));
      assert.deepEqual(await blackBox(server.origin).resolveConflict(input), first);
      assert.deepEqual(await facts(opened.value.replica.replicaId, opened.node.id), after);
      const loser = await blackBox(server.origin).resolveConflict({
        ...input, idempotencyKey: `${input.idempotencyKey}-loser`,
      });
      assert.equal(loser.status, 412);
      assert.ok('code' in loser.body);
      assert.equal(loser.body.code, 'precondition_failed');
      assert.deepEqual(await facts(opened.value.replica.replicaId, opened.node.id), after);
      await server.app.close();
      const restarted = await start(opened.value);
      assert.deepEqual(await blackBox(restarted.origin).resolveConflict(input), first);
      assert.deepEqual(await facts(opened.value.replica.replicaId, opened.node.id), after);
    }
  }, 45_000);

  test('P3-21 traverses real Push Operation and Conflict streams with retry and restart stability', async () => {
    const opened = await openConflict();
    const server = await start(opened.value);
    const negotiated = await blackBox(server.origin).create({ idempotencyKey: `p3-21-session-${randomUUID()}`,
      request: pullSessionRequest(opened.value) });
    const initialKeys = createSyncPullCursorKeyring({
      active: { id: 'p3-21-http-v1', secret: Buffer.alloc(32, 83).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const initialCursor = initialKeys.sign({
      replicaId: opened.value.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: negotiated.body.replicaLease.generation, sessionId: negotiated.body.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1',
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' }, limit: 1,
      tuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
    });
    initialKeys.destroy();
    const first = await blackBox(server.origin).pull({
      sessionId: negotiated.body.sessionId, cursor: initialCursor, limit: 1,
    });
    assert.equal(first.events.length, 1);
    assert.equal(first.hasMore, true);
    assert.deepEqual(await blackBox(server.origin).pull({
      sessionId: negotiated.body.sessionId, cursor: initialCursor, limit: 1,
    }), first);
    const seen = [...first.events];
    let page = first;
    while (page.hasMore) {
      page = await blackBox(server.origin).pull({
        sessionId: negotiated.body.sessionId, cursor: page.nextCursor, limit: 1,
      });
      seen.push(...page.events);
    }
    const expected = (await isolated.runtime.pool.query(`select stable_id from (
      select commit_ordinal,sync_stream_kind stream_kind,operation_id stable_id from operations
      where collection_id=$1 and sync_wire_present
      union all
      select commit_ordinal,sync_stream_kind stream_kind,conflict_id stable_id from sync_conflicts
      where collection_id=$1
    ) stream order by commit_ordinal,stream_kind,stable_id collate "C"`, [COLLECTION])).rows
      .map((row) => row.stable_id);
    assert.deepEqual(seen.map((event) => event.kind === 'operation'
      ? event.operation?.opId : event.conflict?.id), expected);
    assert.equal(new Set(seen.map((event) => event.cursor)).size, seen.length);
    assert.ok(seen.some((event) => event.kind === 'operation'));
    assert.ok(seen.some((event) => event.kind === 'conflict' && event.conflict?.id === opened.conflictId));
    await server.app.close();
    const restarted = await start(opened.value);
    assert.deepEqual(await blackBox(restarted.origin).pull({
      sessionId: negotiated.body.sessionId, cursor: initialCursor, limit: 1,
    }), first);
  }, 30_000);

  test('P3-32B binds one stable delete effect to two receiver-specific Pull cursors', async () => {
    const node = await seedNode('bookmark', { title: 'Two receiver delete' });
    const source = await context('owner', '0.2');
    const receiver = await context('owner', '0.2');
    const server = await start(source);
    const request = syncNodeDeletePushRequest({ sessionId: source.session.sessionId,
      replicaId: source.replica.replicaId, collectionId: COLLECTION, targetId: node.id,
      baseRevision: node.revision, sequence: 1, opId: `p3-32b-delete-${randomUUID()}` });
    const pushed = await blackBox(server.origin).push({ idempotencyKey: `p3-32b-${randomUUID()}`, request });
    assert.equal(pushed.status, 200);

    const targetOrdinal = (await isolated.runtime.pool.query<{ commit_ordinal: string }>(
      'select commit_ordinal::text from operations where collection_id=$1 and operation_id=$2',
      [COLLECTION, request.operations[0]!.opId],
    )).rows[0]?.commit_ordinal;
    assert.ok(targetOrdinal);
    const predecessor = (await isolated.runtime.pool.query<{
      commit_ordinal: string; stream_kind: number; stable_id: string;
    }>(`select commit_ordinal::text, stream_kind, stable_id from (
      select commit_ordinal,sync_stream_kind stream_kind,operation_id stable_id from operations
      where collection_id=$1 and sync_wire_present
      union all
      select commit_ordinal,sync_stream_kind stream_kind,conflict_id stable_id from sync_conflicts
      where collection_id=$1
    ) stream where commit_ordinal < $2
      order by stream.commit_ordinal desc,stream_kind desc,stable_id collate "C" desc limit 1`,
    [COLLECTION, targetOrdinal])).rows[0];
    const predecessorTuple = predecessor ? {
      commitOrdinal: predecessor.commit_ordinal,
      streamKind: predecessor.stream_kind === 0 ? 'operation' as const : 'conflict' as const,
      stableId: predecessor.stable_id,
    } : { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' };
    const persisted = (await isolated.runtime.pool.query<{
      operation_id: string; operation_replica_id: string; operation_sequence: string;
      operation_commit_ordinal: string; effect_operation_id: string; effect_replica_id: string;
      effect_sequence: string; effect_commit_ordinal: string; protocol_version: string;
      terminal_status: string;
    }>(`select operation.operation_id, payload.sync_wire_json->>'replicaId' operation_replica_id,
      payload.sync_wire_json->>'sequence' operation_sequence,
      operation.commit_ordinal::text operation_commit_ordinal,
      effect.operation_id effect_operation_id, effect.origin_replica_id effect_replica_id,
      effect.origin_sequence::text effect_sequence, effect.commit_ordinal::text effect_commit_ordinal,
      effect.protocol_version, effect.terminal_status
      from operations operation
      join operation_payloads payload on payload.operation_id=operation.operation_id
      join sync_operation_effects effect
        on effect.collection_id=operation.collection_id and effect.operation_id=operation.operation_id
      where operation.collection_id=$1 and operation.operation_id=$2`,
    [COLLECTION, request.operations[0]!.opId])).rows[0];
    assert.ok(persisted);
    assert.equal(persisted.operation_id, request.operations[0]!.opId);
    assert.equal(persisted.effect_operation_id, persisted.operation_id);
    assert.equal(persisted.effect_replica_id, persisted.operation_replica_id);
    assert.equal(persisted.effect_sequence, persisted.operation_sequence);
    assert.equal(persisted.effect_commit_ordinal, persisted.operation_commit_ordinal);
    assert.equal(persisted.protocol_version, '0.2');
    assert.ok(persisted.terminal_status === 'applied' || persisted.terminal_status === 'rebased');

    const keys = createSyncPullCursorKeyring({
      active: { id: 'p3-32b-two-receivers', secret: Buffer.alloc(32, 91).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    try {
      const reader = createPostgresSyncPullReadPort(isolated.runtime.db, keys);
      const pages = await Promise.all([source, receiver].map((value) => {
        const cursor = keys.sign({
          replicaId: value.replica.replicaId, collectionId: COLLECTION,
          leaseGeneration: BigInt(value.replica.leaseGeneration).toString(),
          sessionId: value.session.sessionId,
          principalId: ACCOUNT, protocolVersion: '0.2', policyRevision: 'policy-r1',
          purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' }, limit: 1,
          tuple: predecessorTuple,
        });
        return reader.read({ credential: value.credential, sessionId: value.session.sessionId,
          collectionId: COLLECTION, replicaId: value.replica.replicaId, cursor, limit: 1 });
      }));
      const events = pages.map((page) => {
        assert.equal('recoveryRequired' in page, false);
        const event = !('recoveryRequired' in page)
          ? page.events.find((candidate) => candidate.kind === 'operation'
            && candidate.operation.opId === request.operations[0]!.opId) : undefined;
        assert.ok(event && event.kind === 'operation' && 'effect' in event);
        return event;
      });
      assert.notEqual(events[0].cursor, events[1].cursor);
      assert.deepEqual(events[0].effect, events[1].effect);
      assert.equal(events[0].effect.kind, 'node_deleted');
      if (events[0].effect.kind !== 'node_deleted' || events[1].effect.kind !== 'node_deleted') {
        throw new Error('expected delete effects');
      }
      assert.equal(events[0].effect.tombstone.deleteCursor, events[1].effect.tombstone.deleteCursor);
      assert.notEqual(events[0].effect.tombstone.deleteCursor, events[0].cursor);
      assert.notEqual(events[1].effect.tombstone.deleteCursor, events[1].cursor);
      for (const event of events) {
        assert.doesNotThrow(() => validateAuthoritativePullEvent(event as never, '0.2'));
        assert.throws(() => validateAuthoritativePullEvent({ ...event,
          effect: { ...event.effect, opId: 'forged-operation-binding' } } as never, '0.2'));
        assert.throws(() => validateAuthoritativePullEvent({ ...event,
          effect: { ...event.effect, sequence: event.effect.sequence + 1 } } as never, '0.2'));
      }
    } finally {
      keys.destroy();
    }
  }, 30_000);

  test('P3-19 conceals wrong Session, Replica and Collection and redacts conflict secrets', async () => {
    const secret = `P3-19-SECRET-${randomUUID()}`;
    const opened = await openConflict({
      base: { url: 'https://example.test/base' },
      current: { url: 'https://example.test/server' },
      incoming: { url: `https://example.test/incoming?secret=${secret}` },
    });
    const server = await start(opened.value);
    const base = { conflictId: opened.conflictId, sessionId: opened.value.session.sessionId,
      replicaId: opened.value.replica.replicaId, collectionId: COLLECTION,
      conflictRevision: opened.revision, idempotencyKey: 'p3-19-conceal',
      request: { resolution: 'incoming', baseConflictRevision: opened.revision } as const };
    const stale = await blackBox(server.origin).resolveConflict({
      ...base, conflictRevision: 'stale-conflict-r0', idempotencyKey: 'p3-19-stale',
      request: { resolution: 'incoming', baseConflictRevision: 'stale-conflict-r0' },
    });
    assert.equal(stale.status, 412);
    assert.ok('code' in stale.body);
    assert.equal(stale.body.code, 'precondition_failed');
    for (const changed of [
      { ...base, sessionId: 'wrong-session' },
      { ...base, replicaId: 'wrong-replica' },
      { ...base, collectionId: 'wrong-collection' },
      { ...base, conflictId: 'concealed-conflict' },
    ]) {
      const response = await blackBox(server.origin).resolveConflict(changed);
      assert.equal(response.status, 404);
      assert.ok('code' in response.body);
      assert.equal(response.body.code, 'resource_not_found');
      assert.equal(JSON.stringify(response.body).includes(secret), false);
    }
    await isolated.runtime.pool.query(`update sync_extension_credentials set revoked_at=current_timestamp
      where credential_id=$1`, [opened.value.credential.credentialId]);
    const revoked = await blackBox(server.origin).resolveConflict({
      ...base, idempotencyKey: 'p3-19-revoked',
    });
    assert.equal(revoked.status, 404);
    assert.ok('code' in revoked.body);
    assert.equal(revoked.body.code, 'resource_not_found');
  });

  test('P3-19 has one HTTP winner across concurrent resolvers', async () => {
    const opened = await openConflict();
    const server = await start(opened.value);
    const before = await facts(opened.value.replica.replicaId, opened.node.id);
    const common = { conflictId: opened.conflictId, sessionId: opened.value.session.sessionId,
      replicaId: opened.value.replica.replicaId, collectionId: COLLECTION,
      conflictRevision: opened.revision };
    const settled = await Promise.all([
      blackBox(server.origin).resolveConflict({ ...common, idempotencyKey: 'p3-19-racer-a',
        request: { resolution: 'incoming', baseConflictRevision: opened.revision } }),
      blackBox(server.origin).resolveConflict({ ...common, idempotencyKey: 'p3-19-racer-b',
        request: { resolution: 'custom', value: 'P3-19 racer', baseConflictRevision: opened.revision } }),
    ]);
    assert.deepEqual(settled.map((response) => response.status).sort(), [200, 412]);
    const after = await facts(opened.value.replica.replicaId, opened.node.id);
    assert.equal(after.operations, before.operations + 1);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflict_resolution_receipts where conflict_id=$1`, [opened.conflictId])).rows[0].count, 1);
  });

  test('P3-18 enforces allowed resolution, custom schema, strong revision and exact receipt replay', async () => {
    const folder = await openConflict({ kind: 'folder' });
    await assert.rejects(
      resolver(folder.value).resolve(resolveInput(folder, {
        resolution: 'both', baseConflictRevision: folder.revision,
      })),
      (error: unknown) => error instanceof SyncConflictResolutionError && error.code === 'unsupported_operation',
    );
    await assert.rejects(
      resolver(folder.value).resolve(resolveInput(folder, {
        resolution: 'custom', value: { title: 'wrong shape' }, baseConflictRevision: folder.revision,
      })),
      (error: unknown) => error instanceof SyncConflictResolutionError && error.code === 'invalid_document',
    );
    const urlConflict = await openConflict({
      base: { url: 'https://example.test/p3-18-base' },
      current: { url: 'https://example.test/p3-18-server' },
      incoming: { url: 'https://example.test/p3-18-incoming' },
    });
    await assert.rejects(resolver(urlConflict.value).resolve(resolveInput(urlConflict, {
      resolution: 'custom', value: 'javascript:alert(1)', baseConflictRevision: urlConflict.revision,
    })), (error: unknown) => error instanceof SyncConflictResolutionError
      && error.code === 'invalid_document');

    const opened = await openConflict();
    const app = resolver(opened.value);
    const valid = resolveInput(opened, {
      resolution: 'incoming', baseConflictRevision: opened.revision,
    }, 'p3-18-exact-replay');
    for (const ifMatch of [[], ['W/"conflict-r1"'], ['*'], ['"conflict-r1", "other"'],
      ['"conflict-r1"', '"conflict-r1"'], ['"stale"']]) {
      await assert.rejects(app.resolve({ ...valid, ifMatch }),
        (error: unknown) => error instanceof SyncConflictResolutionError
          && (error.code === 'precondition_required' || error.code === 'invalid_document'
            || error.code === 'precondition_failed'));
    }
    const first = await app.resolve(valid);
    const counts = await facts(opened.value.replica.replicaId, opened.node.id);
    const resolutionReceiptCount = (await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflict_resolution_receipts where conflict_id=$1`, [opened.conflictId])).rows[0].count;
    assert.deepEqual(await app.resolve(valid), first);
    assert.deepEqual(await facts(opened.value.replica.replicaId, opened.node.id), counts);
    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count
      from sync_conflict_resolution_receipts where conflict_id=$1`, [opened.conflictId])).rows[0].count,
      resolutionReceiptCount);
    await assert.rejects(app.resolve({ ...valid, request: {
      resolution: 'server', baseConflictRevision: opened.revision,
    } }), (error: unknown) => error instanceof SyncConflictResolutionError
      && error.code === 'idempotency_key_reused');
    await assert.rejects(app.resolve({ ...valid, idempotencyKey: 'p3-18-loser' }),
      (error: unknown) => error instanceof SyncConflictResolutionError
        && error.code === 'precondition_failed');
    const persisted = (await isolated.runtime.pool.query(`select resolved_by_operation_id from sync_conflicts
      where conflict_id=$1`, [opened.conflictId])).rows[0];
    assert.equal(persisted.resolved_by_operation_id, first.operation.opId);
  }, 20_000);

  test('P3-18 has one winner across two connections and preserves moved target placement', async () => {
    const opened = await openConflict();
    const targetParent = await seedNode('folder', { title: 'P3-18 target parent' });
    const rootRevision = (await isolated.runtime.pool.query('select children_revision from nodes where id=$1', [ROOT]))
      .rows[0].children_revision as string;
    const moveServer = await start(opened.value);
    const moved = await blackBox(moveServer.origin).push({ idempotencyKey: 'p3-18-move-target',
      request: syncNodeMovePushRequest({ sessionId: opened.value.session.sessionId,
        replicaId: opened.value.replica.replicaId, collectionId: COLLECTION, targetId: opened.node.id,
        baseRevision: (await isolated.runtime.pool.query('select resource_revision from nodes where id=$1', [opened.node.id]))
          .rows[0].resource_revision,
        baseSourceParentRevision: rootRevision,
        baseTargetParentRevision: targetParent.payload.childrenRevision as string,
        newParentId: targetParent.id, sequence: 2, opId: `p3-18-move-${randomUUID()}` }) });
    assert.equal(moved.status, 200);

    const first = resolver(opened.value).resolve(resolveInput(opened, {
      resolution: 'incoming', baseConflictRevision: opened.revision,
    }, 'p3-18-racer-a'));
    const second = resolver(opened.value).resolve(resolveInput(opened, {
      resolution: 'custom', value: 'racer custom', baseConflictRevision: opened.revision,
    }, 'p3-18-racer-b'));
    const settled = await Promise.allSettled([first, second]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    const loser = settled.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    assert.ok(loser.reason instanceof SyncConflictResolutionError);
    assert.equal(loser.reason.code, 'precondition_failed');
    const winner = (settled.find((item) => item.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<typeof first>
    >).value;
    const row = (await isolated.runtime.pool.query(`select parent_id,count(*) over() operation_count
      from nodes where id=$1`, [opened.node.id])).rows[0];
    assert.equal(row.parent_id, targetParent.id);
    const authority = (await isolated.runtime.pool.query(`select count(*)::int count,
      min(c.resolved_by_operation_id) resolved_by_operation_id from operations o
      join sync_conflicts c on c.resolved_by_operation_id=o.operation_id
      where c.conflict_id=$1`, [opened.conflictId])).rows[0];
    assert.equal(authority.count, 1);
    assert.equal(authority.resolved_by_operation_id, winner.operation.opId);
  }, 20_000);

  test('R05 rejects malformed multi-field custom conflict values and rolls back resolution attempts', async () => {
    const opened = await openMultiFieldConflict();
    const legal = legalMultiFieldCustomValue(opened);

    const resolved = await resolver(opened.value).resolve(resolveInput(opened, {
      resolution: 'custom',
      value: legal,
      baseConflictRevision: opened.revision,
    }, 'r05-multi-valid'));
    assert.equal(resolved.conflict.status, 'resolved');
    assert.equal((await isolated.runtime.pool.query(
      'select title from nodes where id=$1', [opened.node.id])).rows[0].title, legal.title);

    const fresh = await openMultiFieldConflict();
    const missingUrl = { title: legal.title, extensions: legal.extensions };
    await assertInvalidMultiFieldCustom(fresh, missingUrl, 'r05-multi-missing-url');

    const extraField = { ...legal, description: 'unexpected' };
    await assertInvalidMultiFieldCustom(fresh, extraField, 'r05-multi-extra-field');

    for (const [label, value] of [
      ['empty title', { ...legal, title: '' }],
      ['unsafe url', { ...legal, url: 'javascript:alert(1)' }],
      ['non-object extensions', { ...legal, extensions: 'not-an-object' }],
    ] as const) {
      await assertInvalidMultiFieldCustom(fresh, value, `r05-multi-illegal-${label}`);
    }

    const nullPrototype = Object.assign(Object.create(null), legal);
    await assertInvalidMultiFieldCustom(fresh, nullPrototype, 'r05-multi-null-prototype');

    const accessor = { ...legal };
    Object.defineProperty(accessor, 'title', {
      enumerable: true,
      get() {
        return 'Accessor title';
      },
    });
    await assertInvalidMultiFieldCustom(fresh, accessor, 'r05-multi-accessor');

    for (const phase of ['mutation', 'effect_built', 'effect_persisted', 'effect_pages_persisted',
      'conflict_update', 'before_receipt_finalize'] as const) {
      const faulted = await openMultiFieldConflict();
      const before = await facts(faulted.value.replica.replicaId, faulted.node.id);
      await assert.rejects(
        resolver(faulted.value, phase).resolve(resolveInput(faulted, {
          resolution: 'custom',
          value: legalMultiFieldCustomValue(faulted),
          baseConflictRevision: faulted.revision,
        }, `r05-multi-fault-${phase}`)),
      );
      assert.deepEqual(await facts(faulted.value.replica.replicaId, faulted.node.id), before, phase);
      assert.equal((await isolated.runtime.pool.query(
        'select status from sync_conflicts where conflict_id=$1', [faulted.conflictId])).rows[0].status, 'open');
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

function pullSessionRequest(value: {
  readonly replica: { readonly replicaId: string; readonly binding: {
    readonly browserProfileId: string; readonly browserGeneration: string;
  } };
}): SyncSessionRequest {
  return {
    protocolVersion: '0.1', scope: 'collection', clientTime: '2026-07-26T08:00:00Z',
    replica: { replicaId: value.replica.replicaId, name: 'P3-21 Chrome', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: value.replica.binding.browserProfileId,
        mountMode: 'whole-profile',
        mountNativeId: 'p3-21-native-root',
        generation: value.replica.binding.browserGeneration }, extensions: {} },
    collection: { collectionId: COLLECTION, lastCursor: null, lastRevision: null, bootstrapMode: 'download' },
  };
}
