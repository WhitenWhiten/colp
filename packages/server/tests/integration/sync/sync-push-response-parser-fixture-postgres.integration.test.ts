/**
 * A-16 / SR-17: shared Push-response fixture driven by *real* backend bytes.
 *
 * This suite issues real HTTP Push requests through the production Fastify route
 * (`registerSyncPushRoutes` + `createPostgresSyncPushApplication`) against an
 * isolated PostgreSQL schema, captures the response bytes and headers with a
 * wrapping `fetch`, and hands exactly those bytes to the shared fixture
 * (`tests/fixtures/sync/push-response-bytes.ts`), which runs the extension's own
 * `parseSyncPushResult` / `parseColpProblem`.
 *
 * It is the generalised form of the single pre-existing precedent
 * (`sync-sequence-cross-session-postgres.integration.test.ts:36,401`) and covers
 * the three outcomes the outbound worker must classify: `rejected`,
 * `conflicted`, `sequence_gap`. Scaffolding (isolated schema, migrations,
 * credential/replica/session, manifest client, cleanup) follows that file.
 *
 * Runs under the `postgres` project (`POSTGRES_INCLUDE =
 * ['tests/integration/**\/*.integration.test.ts']`); it is not part of the
 * default unit job.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPush, SyncPushResult } from '@know-n/colp/types';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';
import {
  CONFLICTED_PUSH_RESPONSE,
  PUSH_PROBLEM_MEDIA_TYPE,
  PUSH_RESULT_MEDIA_TYPE,
  REJECTED_PUSH_RESPONSE,
  SEQUENCE_GAP_PUSH_RESPONSE,
  mediaTypePattern,
  parseSyncPushResponseBytes,
  sequenceGapProblemResponse,
} from '../../fixtures/sync/push-response-bytes.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION_MARKER = 'SR17-PUSH-RESPONSE-PARSER-SECRET-MARKER';
const PUSH_PATH = '/private-entry/sr17-push-response';
// Collection and owner-Profile identities reach `appendSocialCollectionChangeOutbox`,
// whose `requireCanonicalOpaqueId` demands a *canonical* 16-byte base64url id
// (`/^[A-Za-z0-9_-]{21}[AQgw]$/`, `src/infrastructure/outbox/social-collection-change.ts:14`);
// a shorter/longer or non-canonical id fails the canonical mutation with 422
// `invalid_document: social collection change collectionId must be a canonical
// 16-byte base64url identity`. Both literals below are base64url of 16 ASCII bytes.
const COLLECTION = 'c3IxNy1jb2xsZWN0aW9uMQ'; // base64url('sr17-collection1')
const ACCOUNT = 'c3IxNy1hY2NvdW50LTAwMQ'; // base64url('sr17-account-001')
const SUBJECT = 'sr17-push-response-subject';
const ROOT = 'sr17-root';
const BOOKMARK = 'sr17-bookmark';
const BOOKMARK_REVISION = 'sr17-bookmark-r1';
const BASE_TITLE = 'SR-17 base title';

describeWithPostgres('A-16 shared Push-response fixture (SR-17)', () => {
  let isolated: IsolatedPostgresRuntime;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sr17_push_response_parser', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date('2026-09-12T02:00:00.000Z');
    const collectionPayload = materializeCollectionPayload({
      id: COLLECTION, ownerSubjectId: SUBJECT, title: 'SR-17', summary: null,
      kind: 'bookmarks', visibility: 'private', allowSearchIndexing: false, rootNodeId: ROOT,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
    });
    assert.equal(collectionPayload.ok, true);
    const nodePayload = (input: {
      readonly id: string; readonly parentId: string | null; readonly kind: 'folder' | 'bookmark';
      readonly isRoot: boolean; readonly title: string; readonly url: string | null;
      readonly positionToken: string | null; readonly revision: string; readonly childrenRevision: string;
    }) => {
      const materialized = materializeNodePayload({
        id: input.id, collectionId: COLLECTION, parentId: input.parentId, kind: input.kind,
        isRoot: input.isRoot, title: input.title, url: input.url, description: null, tags: [],
        visibility: 'inherit', positionToken: input.positionToken, resourceRevision: input.revision,
        childrenRevision: input.childrenRevision, createdAt: now, updatedAt: now,
        deletedAt: null, deletedCommitOrdinal: null,
      });
      assert.equal(materialized.ok, true);
      return { ...(materialized.ok ? materialized.payload : {}), extensions: {} };
    };
    // A root row must keep parentId and positionToken null (resource-payload.ts:317-326).
    const rootPayload = nodePayload({
      id: ROOT, parentId: null, kind: 'folder', isRoot: true, title: 'SR-17 root', url: null,
      positionToken: null, revision: 'sr17-root-r1', childrenRevision: 'sr17-root-children-r1',
    });
    const bookmarkPayload = nodePayload({
      id: BOOKMARK, parentId: ROOT, kind: 'bookmark', isRoot: false, title: BASE_TITLE,
      url: 'https://example.test/sr17', positionToken: 'M', revision: BOOKMARK_REVISION,
      childrenRevision: 'sr17-bookmark-children-r1',
    });
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into profiles(account_id,display_name) values ($1,'SR-17 owner')", [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('sr17-identity',$1,$2,'sr17-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('sr17_owner',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node'),($3,'node')`, [COLLECTION, ROOT, BOOKMARK]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,'SR-17','bookmarks','private',$3,'collection-r1','content-r1','policy-r1',0,$4,$4,$5,$6,'backfilled')`,
      [COLLECTION, SUBJECT, ROOT, now, collectionPayload.ok ? collectionPayload.payload : {},
        RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,null,'folder',true,'SR-17 root','inherit',null,'sr17-root-r1',
          'sr17-root-children-r1',$3,$3,$4,$5,'backfilled')`,
      [ROOT, COLLECTION, now, rootPayload, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,$3,'bookmark',false,$4,'https://example.test/sr17','inherit','M',$5,
          'sr17-bookmark-children-r1',$6,$6,$7,$8,'backfilled')`,
      [BOOKMARK, COLLECTION, ROOT, BASE_TITLE, BOOKMARK_REVISION, now, bookmarkPayload,
        RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      // The update path resolves its trusted base from this revision history row; the
      // payload-binding trigger requires payload.resourceRevision === revision.
      await client.query(`insert into sync_node_revision_history
        (collection_id,resource_id,revision,kind,payload_json,commit_ordinal,operation_id)
        values ($1,$2,$3,'bookmark',$4,0,null)`,
      [COLLECTION, BOOKMARK, BOOKMARK_REVISION, bookmarkPayload]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }, 20_000);

  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => {
    try { await app.close(); } catch { /* a fixture may already have closed it */ }
  })));
  afterAll(async () => isolated?.close());

  async function context() {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 'sr17-oidc', credentialId: `sr17-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `sr17-device-${suffix}`,
      replicaId: () => `sr17-replica-${suffix}`,
      leaseId: () => `sr17-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'SR-17 device',
      replicaName: 'SR-17 replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `sr17-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `sr17-generation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 44), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `sr17-session-${suffix}`,
      requestFingerprint: `sr17-fingerprint-${suffix}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push'], origin: ORIGIN,
    });
    return { replica, issuer, session: issued.session, credential };
  }

  async function start(
    value: Awaited<ReturnType<typeof context>>,
    options: { readonly nodeId?: () => string } = {},
  ) {
    const app = Fastify({ logger: false });
    registerSyncPushRoutes(app, {
      path: PUSH_PATH, allowedOrigins: [ORIGIN],
      credentialVerifier: { async verify({ authorization }: {
        readonly authorization: string | readonly string[] | undefined;
      }) {
        if (authorization !== `Bearer ${AUTHORIZATION_MARKER}`) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(isolated.runtime.db, value.issuer, {
        ...(options.nodeId ? { nodeId: options.nodeId } : {}),
        // Production composition injects the active conflict payload key
        // (`src/bootstrap/sync-session-runtime.ts:229`). Without it
        // `appendOpenSyncConflict` fails `assertEncryption` with
        // `SyncConflictPersistenceError('integrity_failure')`, which the update
        // evaluator folds into 500 `internal_error` — the open-Conflict path is
        // unreachable in this fixture without a 32-byte key.
        conflictPayloadEncryption: { key: Buffer.alloc(32, 45), keyVersion: 7 },
      }),
      rateLimit: { maxRequests: 400, windowMs: 60_000 }, maxBatchOperations: 1,
      allowInsecureLoopback: true,
    });
    app.get('/.well-known/collection-protocol', async () => {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('not listening');
      return testManifest(`http://127.0.0.1:${address.port}`);
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    apps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    return { app, origin: `http://127.0.0.1:${address.port}` };
  }

  interface CapturedPushBytes {
    status: number;
    contentType: string;
    /** Exact bytes the black-box client parsed, read from a clone of the response. */
    body: string;
  }

  /**
   * Wraps `fetch` so the bytes the protocol client sees are also kept verbatim;
   * `createSyncSessionBlackBoxClient` exposes the `fetch` injection point used by
   * the P3-12 response-loss fixtures.
   */
  function capturingFetch(sink: Partial<CapturedPushBytes>): typeof globalThis.fetch {
    return async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === 'POST' && url.endsWith(PUSH_PATH)) {
        sink.status = response.status;
        sink.contentType = response.headers.get('content-type') ?? '';
        sink.body = await response.clone().text();
      }
      return response;
    };
  }

  async function pushAndCapture(origin: string, input: {
    readonly idempotencyKey: string;
    readonly request: SyncPush;
  }): Promise<{ readonly response: { readonly status: number; readonly body: Problem | SyncPushResult };
    readonly bytes: CapturedPushBytes }> {
    const sink: Partial<CapturedPushBytes> = {};
    const response = await createSyncSessionBlackBoxClient({
      manifestUrl: `${origin}/.well-known/collection-protocol`, mountId: 'known-sync-entry',
      authorization: `Bearer ${AUTHORIZATION_MARKER}`, origin: ORIGIN, fetch: capturingFetch(sink),
    }).push(input);
    const { status, contentType, body } = sink;
    if (status === undefined || contentType === undefined || body === undefined) {
      assert.fail(`${PUSH_PATH} did not return a captured response`);
    }
    assert.equal(status, response.status, 'captured bytes must belong to the response the client parsed');
    assert.ok(body.length > 0, 'the push response body must not be empty');
    return { response, bytes: { status, contentType, body } };
  }

  function result(body: Problem | SyncPushResult): SyncPushResult {
    assert.ok('results' in body, `expected SyncPushResult, got ${'code' in body ? body.code : 'unknown'}`);
    return body;
  }

  test('A-16 rejected: live 200 rejection drives parseSyncPushResult as terminal', async () => {
    // A ledger row owned by another resource type makes the injected Node id
    // unreservable, which is the only in-band `rejected` result the backend emits
    // (sync-push-create-update-postgres.ts:104 → terminalNodeIdRejection).
    const historicalId = `sr17-historical-${randomUUID()}`;
    await isolated.runtime.pool.query(
      "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection')",
      [historicalId],
    );
    const value = await context();
    const server = await start(value, { nodeId: () => historicalId });
    const opId = `sr17-rejected-op-${randomUUID()}`;
    const { response, bytes } = await pushAndCapture(server.origin, {
      idempotencyKey: `sr17-rejected-key-${randomUUID()}`,
      request: syncNodeCreatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, opId, parentId: ROOT,
        node: { kind: 'folder', title: 'SR-17 rejected create' },
      }),
    });

    // HTTP-layer facts first, so the fixture is bound to a real response.
    assert.equal(response.status, 200);
    assert.equal(response.status, REJECTED_PUSH_RESPONSE.status);
    assert.equal(bytes.status, 200);
    assert.match(bytes.contentType, mediaTypePattern(PUSH_RESULT_MEDIA_TYPE));
    const denied = result(response.body).results[0]!;
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.code, REJECTED_PUSH_RESPONSE.resultCode);
    assert.equal((response.body as SyncPushResult).serverCursor, 'sync-unchanged');

    // Same bytes → plugin parser → terminal rejection classification.
    const parsed = parseSyncPushResponseBytes('rejected', bytes, { opId, sequence: 1 });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.mediaType, PUSH_RESULT_MEDIA_TYPE);
    assert.equal(parsed.pushResult?.terminal, true);
    assert.equal(parsed.pushResult?.result.status, 'rejected');
    assert.equal(parsed.pushResult?.result.code, 'resource_id_unavailable');
    assert.equal(parsed.rawBody, bytes.body);
    // The rejected row settled nothing canonical: the ledger still belongs to the Collection.
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from nodes where id=$1', [historicalId])).rows[0].count, 0);
  }, 30_000);

  test('A-16 conflicted: live persisted Conflict result drives parseSyncPushResult with conflictId', async () => {
    const value = await context();
    const server = await start(value);
    // Push 1 moves the authoritative title on the same field; push 2 (same lane,
    // next Sequence) therefore diverges from the base on both sides and must be
    // persisted as an open Conflict instead of overwriting Current.
    const applied = await pushAndCapture(server.origin, {
      idempotencyKey: `sr17-conflict-setup-${randomUUID()}`,
      request: syncNodeUpdatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, sequence: 1, opId: `sr17-conflict-setup-op-${randomUUID()}`,
        targetId: BOOKMARK, baseRevision: BOOKMARK_REVISION,
        base: { title: BASE_TITLE }, value: { title: 'SR-17 server title' },
      }),
    });
    // The setup apply must succeed: it is what makes the *next* push a Conflict
    // and what writes the new revision into `sync_node_revision_history` (the FKs
    // on `sync_conflicts.trusted_base_revision`/`current_revision` need it). A
    // Problem body here is a fixture defect, never an expected outcome.
    assert.equal(applied.response.status, 200,
      `setup update must apply, got ${JSON.stringify(applied.response.body)}`);
    assert.equal(result(applied.response.body).results[0]?.status, 'applied');

    const opId = `sr17-conflict-op-${randomUUID()}`;
    const { response, bytes } = await pushAndCapture(server.origin, {
      idempotencyKey: `sr17-conflict-key-${randomUUID()}`,
      request: syncNodeUpdatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, sequence: 2, opId,
        targetId: BOOKMARK, baseRevision: BOOKMARK_REVISION,
        base: { title: BASE_TITLE }, value: { title: 'SR-17 incoming title' },
      }),
    });

    assert.equal(response.status, 200, `conflicting update must return a result, got ${JSON.stringify(response.body)}`);
    assert.equal(response.status, CONFLICTED_PUSH_RESPONSE.status);
    assert.match(bytes.contentType, mediaTypePattern(PUSH_RESULT_MEDIA_TYPE));
    const conflict = result(response.body).results[0]!;
    assert.equal(conflict.status, 'conflicted');
    assert.equal(typeof conflict.conflictId, 'string');
    assert.equal(typeof conflict.cursor, 'string');
    assert.equal((response.body as SyncPushResult).serverCursor, conflict.cursor);

    const parsed = parseSyncPushResponseBytes('conflicted', bytes, { opId, sequence: 2, targetId: BOOKMARK });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.mediaType, PUSH_RESULT_MEDIA_TYPE);
    assert.equal(parsed.pushResult?.terminal, true);
    assert.equal(parsed.pushResult?.result.status, 'conflicted');
    assert.equal(parsed.pushResult?.result.conflictId, conflict.conflictId);
    assert.equal(parsed.pushResult?.result.cursor, conflict.cursor);
    assert.equal(parsed.rawBody, bytes.body);
    const stored = await isolated.runtime.pool.query(
      'select count(*)::int count from sync_conflicts where collection_id=$1 and conflict_id=$2',
      [COLLECTION, conflict.conflictId],
    );
    assert.equal(stored.rows[0].count, 1, 'the reported conflictId must be the persisted Conflict row');
  }, 30_000);

  test('A-16 sequence_gap: live 409 Problem drives parseColpProblem with expectedSequence', async () => {
    const value = await context();
    const server = await start(value);
    const opId = `sr17-gap-op-${randomUUID()}`;
    // A virgin lane starts at Sequence 1, so a Sequence-2 operation is a gap that
    // advertises the lane's next Sequence for realignment.
    const { response, bytes } = await pushAndCapture(server.origin, {
      idempotencyKey: `sr17-gap-key-${randomUUID()}`,
      request: syncNodeCreatePushRequest({
        sessionId: value.session.sessionId, replicaId: value.replica.replicaId,
        collectionId: COLLECTION, sequence: 2, opId, parentId: ROOT,
        node: { kind: 'folder', title: 'SR-17 gapped create' },
      }),
    });

    // HTTP-layer facts: Problem media type, registry status and recovery field.
    assert.equal(response.status, 409);
    assert.equal(response.status, SEQUENCE_GAP_PUSH_RESPONSE.status);
    assert.match(bytes.contentType, mediaTypePattern(PUSH_PROBLEM_MEDIA_TYPE));
    assert.ok('code' in response.body);
    assert.equal(response.body.code, 'sequence_gap');
    // Byte-for-byte equality with the document the production descriptor builds:
    // this binds the fixture constants to the live body instead of a hand copy.
    assert.deepEqual(
      JSON.parse(bytes.body) as Record<string, unknown>,
      JSON.parse(sequenceGapProblemResponse(1).body as string) as Record<string, unknown>,
    );

    const parsed = parseSyncPushResponseBytes('sequence_gap', bytes, { opId, sequence: 2 },
      { expectedSequence: 1 });
    assert.equal(parsed.status, 409);
    assert.equal(parsed.mediaType, PUSH_PROBLEM_MEDIA_TYPE);
    assert.equal(parsed.problem?.code, 'sequence_gap');
    assert.equal(parsed.problem?.status, 409);
    assert.equal(parsed.problem?.expectedSequence, 1);
    assert.equal(parsed.problem?.retryable, true);
    assert.equal(parsed.rawBody, bytes.body);
    // The gap left no lane progress and no canonical write behind it.
    assert.equal((await isolated.runtime.pool.query(
      `select coalesce(max(next_sequence),1)::int next from sync_sequence_lanes
        where replica_id=$1 and sequence_scope=$2`,
      [value.replica.replicaId, `collection:${COLLECTION}`],
    )).rows[0].next, 1);
  }, 30_000);

  function testManifest(origin: string): Manifest {
    return {
      protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
      serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111117', title: 'Known',
      mounts: [{
        id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
        endpoints: { syncPush: `${origin}${PUSH_PATH}` },
        features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
        auth: { anonymousRead: false, apiKeys: false, oauth: true,
          protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
        limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
          minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 },
      }],
      // `Manifest.serverId` is a branded `ServiceUrl`; the origin template below is a
      // plain string, so the assertion goes through `unknown` (same document the
      // cross-session precedent builds at sync-sequence-cross-session-postgres…:413).
    } as unknown as Manifest;
  }
});
