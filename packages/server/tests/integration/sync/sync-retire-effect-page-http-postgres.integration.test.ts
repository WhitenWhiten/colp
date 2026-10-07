import { problemOf } from '../../support/http-problem-response.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { canonicalAuthoritativeMemberDigest } from '@know-n/colp/sync';
import type { AuthoritativeEffectPage } from '@know-n/colp/types';
import { appendOperationWithPayload, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresReplicaRetirementApplication,
  createPostgresSyncEffectPageReadPort,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { buildAuthoritativeEffectPages } from '../../../src/modules/sync/index.js';
import { registerSyncRetireRoutes } from '../../../src/transport/colp-sync/sync-retire-routes.js';
import { registerSyncEffectPageRoutes } from '../../../src/transport/colp-sync/sync-effect-page-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { isFetchForbiddenPort } from '../../support/fetch-port.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const FOREIGN_ORIGIN = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ACCOUNT = 'retire-effect-account';
const SUBJECT = 'retire-effect-subject';
const OIDC_SUBJECT = 'retire-effect-oidc';
const COLLECTION = 'retire-effect-collection';
const ROOT = 'retire-effect-root';
const READER_TOKEN = 'postgres-EFFECT-PAGE-TOKEN-MARKER';
const RETIREE_TOKEN = 'postgres-RETIRE-TOKEN-MARKER';
const RETIRE_PATH = '/extension-internal/sync/replica';
const EFFECT_PAGE_TEMPLATE = '/private/effects/{effectId}/{pageNumber}';
const DIGEST = `sha-256=:${'A'.repeat(43)}=:`;
const schema = createValidatorRegistry();
type CreatedReplica = Awaited<ReturnType<ReturnType<typeof createPostgresReplicaStore>['create']>>;

describeWithPostgres('FIX-L-028 production HTTP/PostgreSQL Retire and Effect-page composition', () => {
  let isolated: IsolatedPostgresRuntime;
  let readerCredential: Awaited<ReturnType<typeof mintVerifiedExtensionCredentialFixture>>;
  let retireeCredential: Awaited<ReturnType<typeof mintVerifiedExtensionCredentialFixture>>;
  let readerReplica: CreatedReplica;
  let readerSession: { readonly sessionId: string };
  let pages: readonly AuthoritativeEffectPage[];
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_retire_effect_http', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('retire-effect-identity',$1,$2,$3)`, [ACCOUNT, ISSUER, OIDC_SUBJECT]);
      await client.query("insert into profile_handles(handle,account_id) values ('retire_effect',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),($2,'node')`, [COLLECTION, ROOT]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'Retire/Effect pages','bookmarks',$3,'collection-r1','content-r1','policy-r1')`,
      [COLLECTION, SUBJECT, ROOT]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ($1,$2,'folder',true,'Root','root-r1','children-r1')`, [ROOT, COLLECTION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }

    readerCredential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: OIDC_SUBJECT, credentialId: 'retire-effect-reader-credential', evidenceTtlSeconds: 600,
    });
    retireeCredential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: OIDC_SUBJECT, credentialId: 'retire-effect-retiree-credential', evidenceTtlSeconds: 600,
    });
    readerReplica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => 'retire-effect-reader-device',
      replicaId: () => 'retire-effect-reader-replica',
      leaseId: () => 'retire-effect-reader-lease',
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Reader device',
      replicaName: 'Reader replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'retire-effect-reader-profile', mountMode: 'whole-profile',
        browserGeneration: 'reader-generation-1' },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 3_600, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential: readerCredential, idempotencyKey: 'retire-effect-reader-session',
      requestFingerprint: 'retire-effect-reader-fingerprint', collectionId: COLLECTION,
      replicaId: readerReplica.replicaId, expectedLeaseGeneration: readerReplica.leaseGeneration,
      expectedLifecycleRevision: readerReplica.lifecycleRevision, binding: readerReplica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN, protocolVersion: '0.2',
    });
    readerSession = issued.session;
    await seedEffectRows();
  }, 30_000);

  afterEach(async () => Promise.all(apps.splice(0).map(async (app) => {
    try { await app.close(); } catch { /* restart evidence may already close it */ }
  })));
  afterAll(async () => isolated?.close());

  async function seedEffectRows(): Promise<void> {
    const members = Array.from({ length: 130 }, (_, index) => `fx-member-${String(index).padStart(3, '0')}`);
    pages = buildAuthoritativeEffectPages('effect-subtree', members, { maxMembersPerPage: 64 });
    const memberDigest = canonicalAuthoritativeMemberDigest(members);
    const deletedAt = '2026-07-26T06:00:00.000Z';
    const subtreeEffect = {
      effectId: 'effect-subtree', opId: 'op-subtree-1', replicaId: readerReplica.replicaId,
      sequence: 1, collectionId: COLLECTION, status: 'applied', operationDigest: DIGEST,
      effectDigest: DIGEST, kind: 'subtree_deleted',
      rootTombstone: { resourceType: 'node', targetId: 'fx-subtree-root',
        collectionId: COLLECTION, scope: 'subtree', deletedAt, deleteRevision: 'fx-subtree-r2',
        operationId: 'op-subtree-1', deleteCursor: 'cursor-1', affectedCount: members.length,
        purgeAfter: '2026-08-25T06:00:00.000Z' },
      memberCount: members.length, memberDigest,
      parentRevision: { parentId: ROOT, childrenRevision: 'children-r2' },
      effectRef: { pageCount: pages.length, memberCount: members.length, memberDigest,
        firstPageDigest: pages[0]!.pageDigest },
    };
    const corruptMembers = Array.from({ length: 64 }, (_, index) => `fx-corrupt-${String(index).padStart(3, '0')}`);
    const corruptPages = buildAuthoritativeEffectPages('effect-corrupt', corruptMembers, { maxMembersPerPage: 64 });
    const corruptMemberDigest = canonicalAuthoritativeMemberDigest(corruptMembers);
    const corruptEffect = {
      effectId: 'effect-corrupt', opId: 'op-corrupt-1', replicaId: readerReplica.replicaId,
      sequence: 2, collectionId: COLLECTION, status: 'applied', operationDigest: DIGEST,
      effectDigest: DIGEST, kind: 'subtree_deleted',
      rootTombstone: { resourceType: 'node', targetId: 'fx-corrupt-root',
        collectionId: COLLECTION, scope: 'subtree', deletedAt, deleteRevision: 'fx-corrupt-r2',
        operationId: 'op-corrupt-1', deleteCursor: 'cursor-2', affectedCount: corruptMembers.length,
        purgeAfter: '2026-08-25T06:00:00.000Z' },
      memberCount: corruptMembers.length, memberDigest: corruptMemberDigest,
      parentRevision: { parentId: ROOT, childrenRevision: 'children-r3' },
      effectRef: { pageCount: 1, memberCount: corruptMembers.length,
        memberDigest: corruptMemberDigest, firstPageDigest: corruptPages[0]!.pageDigest },
    };
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('known.sync_authority','server',true)");
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ('op-subtree-1','operation'),('op-corrupt-1','operation')`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
    await isolated.runtime.db.transaction().execute(async (transaction) => {
      await appendOperationWithPayload(transaction, {
        operationId: 'op-subtree-1', collectionId: COLLECTION, commitOrdinal: 10n,
        operationType: 'delete_subtree', payloadJson: {}, syncWireJson: {}, actorPrincipalId: null,
      });
      await appendOperationWithPayload(transaction, {
        operationId: 'op-corrupt-1', collectionId: COLLECTION, commitOrdinal: 11n,
        operationType: 'delete_subtree', payloadJson: {}, syncWireJson: {}, actorPrincipalId: null,
      });
    });
    const effectClient = await isolated.runtime.pool.connect();
    try {
      await effectClient.query('begin');
      await effectClient.query("select set_config('known.sync_authority','server',true)");
      await effectClient.query(`insert into sync_operation_effects
        (effect_id,collection_id,operation_id,origin_replica_id,origin_sequence,commit_ordinal,
         protocol_version,terminal_status,operation_digest,effect_json,effect_digest)
        values ('effect-subtree',$1,'op-subtree-1',$2,1,10,'0.2','applied',$3,$4,$3),
               ('effect-corrupt',$1,'op-corrupt-1',$2,2,11,'0.2','applied',$3,$5,$3)`,
      [COLLECTION, readerReplica.replicaId, DIGEST, subtreeEffect, corruptEffect]);
      for (const page of pages) {
        await effectClient.query(`insert into sync_operation_effect_pages
          (effect_id,page_number,page_count,member_count,page_json,page_digest,previous_page_digest)
          values ('effect-subtree',$1,$2,$3,$4,$5,$6)`,
        [page.pageNumber, page.pageCount, page.memberCount, page, page.pageDigest,
          page.previousPageDigest]);
      }
      // A stored page whose member list no longer matches its memberCount must
      // fail the production reader's integrity validation instead of being served.
      const tampered = { ...corruptPages[0]!, members: ['fx-tampered-member'] };
      await effectClient.query(`insert into sync_operation_effect_pages
        (effect_id,page_number,page_count,member_count,page_json,page_digest,previous_page_digest)
        values ('effect-corrupt',1,1,64,$1,$2,null)`,
      [tampered, corruptPages[0]!.pageDigest]);
      await effectClient.query('commit');
    } catch (error) {
      await effectClient.query('rollback');
      throw error;
    } finally { effectClient.release(); }
  }

  /**
   * One fresh Replica with two Sessions. Issuing the second advances the
   * replica lifecycle, so only session B is still allowed to retire it.
   * Session A exists to probe idempotency-key reuse from a different session.
   */
  async function createRetireeScope(): Promise<{
    readonly replica: CreatedReplica;
    readonly sessionA: { readonly sessionId: string };
    readonly sessionB: { readonly sessionId: string };
  }> {
    const suffix = randomUUID();
    const store = createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `retiree-device-${suffix}`,
      replicaId: () => `retiree-replica-${suffix}`,
      leaseId: () => `retiree-lease-${suffix}`,
    } });
    const replica = await store.create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Retiree device',
      replicaName: 'Retiree replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `retiree-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `retiree-generation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 3_600, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const sessionA = await issuer.issue({
      credential: retireeCredential, idempotencyKey: `retiree-session-a-${suffix}`,
      requestFingerprint: `retiree-fingerprint-a-${suffix}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN,
    });
    // Session issuance advances the Replica lifecycle revision (production
    // semantics), so a second Session must be issued against the refreshed
    // replica fence, exactly as a real client would re-read replica state.
    const refreshed = await store.load({
      accountId: ACCOUNT, collectionId: COLLECTION, replicaId: replica.replicaId,
    });
    if (!refreshed) throw new Error('retiree replica vanished after session issue');
    const sessionB = await issuer.issue({
      credential: retireeCredential, idempotencyKey: `retiree-session-b-${suffix}`,
      requestFingerprint: `retiree-fingerprint-b-${suffix}`, collectionId: COLLECTION,
      replicaId: refreshed.replicaId, expectedLeaseGeneration: refreshed.leaseGeneration,
      expectedLifecycleRevision: refreshed.lifecycleRevision, binding: refreshed.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN,
    });
    return { replica: refreshed, sessionA: sessionA.session, sessionB: sessionB.session };
  }

  async function seedRetireeEvidence(replicaId: string, sessionId: string): Promise<void> {
    const cursorDigest = createHash('sha256').update('retiree-cursor-1', 'utf8').digest('hex');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into sync_pull_cursor_evidence
        (cursor,cursor_digest,session_id,account_id,collection_id,replica_id,lease_generation,
         policy_revision,protocol_version,tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,
         cursor_expires_at,issued_at,upper_commit_ordinal,upper_stream_kind,upper_stable_id,
         collection_revision,page_limit,purge_commit_ordinal,purge_stream_kind,purge_stable_id)
        values ('retiree-cursor-1',$1,$2,$3,$4,$5,1,'policy-r1','0.1',0,0,'',
          current_timestamp + interval '1 hour',current_timestamp,0,0,'','content-r1',100,0,0,'')`,
      [cursorDigest, sessionId, ACCOUNT, COLLECTION, replicaId]);
      await client.query(`insert into sync_pull_cursor_recovery_proofs
        (cursor_digest,authority_session_id,authority_lifecycle_revision,account_id,collection_id,
         replica_id,lease_generation,policy_revision,protocol_version,page_limit,
         tuple_commit_ordinal,tuple_stream_kind,tuple_stable_id,upper_commit_ordinal,
         upper_stream_kind,upper_stable_id,purge_commit_ordinal,purge_stream_kind,purge_stable_id,
         cursor_expires_at,proof_expires_at,issued_at)
        values ($1,$2,1,$3,$4,$5,1,'policy-r1','0.1',100,0,0,'',1,0,'tuple-stable-1',0,0,'',
          current_timestamp + interval '1 hour',current_timestamp + interval '2 hours',
          current_timestamp)`,
      [cursorDigest, sessionId, ACCOUNT, COLLECTION, replicaId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async function start(allowedOrigins: readonly string[] = [ORIGIN]): Promise<{
    readonly origin: string; readonly app: FastifyInstance;
  }> {
    const app = Fastify({ logger: false });
    const credentialVerifier = {
      async verify({ authorization }: { readonly authorization: string | readonly string[] | undefined }) {
        if (authorization === `Bearer ${READER_TOKEN}`) return readerCredential;
        if (authorization === `Bearer ${RETIREE_TOKEN}`) return retireeCredential;
        throw new Error('invalid credential');
      },
    };
    registerSyncRetireRoutes(app, {
      path: RETIRE_PATH, allowedOrigins, allowInsecureLoopback: true,
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, credentialVerifier,
      application: createPostgresReplicaRetirementApplication(isolated.runtime.db),
    });
    registerSyncEffectPageRoutes(app, {
      pathTemplate: EFFECT_PAGE_TEMPLATE, allowedOrigins, allowInsecureLoopback: true,
      responseBudgetBytes: 16_384,
      rateLimit: { subjectMaxRequests: 1_000, effectMaxRequests: 1_000,
        ipMaxRequests: 1_000, windowMs: 60_000 },
      credentialVerifier, reader: createPostgresSyncEffectPageReadPort(isolated.runtime.db),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    if (isFetchForbiddenPort(address.port)) {
      await app.close();
      return start();
    }
    apps.push(app);
    return { app, origin: `http://127.0.0.1:${address.port}` };
  }

  function retire(origin: string, init: {
    readonly token: string; readonly sessionId: string; readonly key: string;
    readonly originHeader?: string;
  }): Promise<Response> {
    return fetch(`${origin}${RETIRE_PATH}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/problem+json',
        Authorization: `Bearer ${init.token}`,
        Origin: init.originHeader ?? ORIGIN,
        'Idempotency-Key': init.key,
        'Known-Sync-Session': init.sessionId,
      },
    });
  }

  function fetchEffectPage(origin: string, effectId: string, pageNumber: number, options: {
    readonly sessionId?: string; readonly token?: string; readonly originHeader?: string;
    readonly omitAuthorization?: boolean; readonly query?: string;
  } = {}): Promise<Response> {
    const url = new URL(`/private/effects/${effectId}/${pageNumber}`, origin);
    if (options.query) url.search = options.query;
    const headers: Record<string, string> = { Origin: options.originHeader ?? ORIGIN,
      'Known-Sync-Session': options.sessionId ?? readerSession.sessionId };
    if (!options.omitAuthorization) headers.Authorization = `Bearer ${options.token ?? READER_TOKEN}`;
    return fetch(url, { headers });
  }

  async function retirementState(replicaId: string, sessionId: string) {
    const rows = await isolated.runtime.pool.query(`select
      (select status from sync_replicas where replica_id=$1) replica_status,
      (select retired_at is not null from sync_replicas where replica_id=$1) has_retired_at,
      (select status from sync_sessions where session_id=$2) session_status,
      (select count(*)::text from sync_replica_retirement_receipts where replica_id=$1) receipts,
      (select count(*)::text from audit_events event
        join audit_event_payloads payload on payload.event_id=event.id
        where event.event_type like 'sync.replica.lifecycle.%_to_retired'
        and payload.details_json->>'replicaId'=$1) audits,
      (select cursor from sync_pull_cursor_evidence where replica_id=$1) evidence_cursor,
      (select count(*)::text from sync_pull_cursor_recovery_proofs where replica_id=$1) proofs`,
    [replicaId, sessionId]);
    return rows.rows[0];
  }

  test('rejects wrong credentials and foreign origins before any retirement application work', async () => {
    const scope = await createRetireeScope();
    const server = await start();
    const denied = await retire(server.origin, {
      token: 'RETIRE-ATTACKER-TOKEN', sessionId: scope.sessionA.sessionId, key: 'attacker-key',
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('cache-control'), 'private, no-store');
    const deniedProblem = await problemOf(denied);
    assert.equal(schema.validate('problem', deniedProblem.body).valid, true);
    assert.equal(deniedProblem.body.code, 'authentication_required');
    assert.doesNotMatch(deniedProblem.text, /RETIRE-ATTACKER-TOKEN|RETIRE-TOKEN-MARKER/u);

    const foreign = await retire(server.origin, {
      token: RETIREE_TOKEN, sessionId: scope.sessionA.sessionId, key: 'attacker-key',
      originHeader: FOREIGN_ORIGIN,
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('cache-control'), 'private, no-store');
    const foreignProblem = await problemOf(foreign);
    assert.equal(schema.validate('problem', foreignProblem.body).valid, true);
    assert.equal(foreignProblem.body.code, 'origin_not_allowed');
    assert.doesNotMatch(foreignProblem.text, /FOREIGN|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|RETIRE-TOKEN-MARKER/u);

    const rows = await isolated.runtime.pool.query(`select
      (select status from sync_replicas where replica_id=$1) replica_status,
      (select count(*)::int from sync_replica_retirement_receipts where replica_id=$1) receipts,
      (select status from sync_sessions where session_id=$2) session_status`,
    [scope.replica.replicaId, scope.sessionA.sessionId]);
    assert.deepEqual(rows.rows[0], { replica_status: 'active', receipts: 0, session_status: 'active' });
  });

  test('retires through the production route with 204, committed lifecycle, idempotent replay and stable Problems', async () => {
    const scope = await createRetireeScope();
    await seedRetireeEvidence(scope.replica.replicaId, scope.sessionA.sessionId);
    const server = await start();
    const revisionBefore = await isolated.runtime.pool.query(
      'select lifecycle_revision::text from sync_replicas where replica_id=$1', [scope.replica.replicaId],
    );
    const before = await retirementState(scope.replica.replicaId, scope.sessionA.sessionId);
    assert.deepEqual(before, { replica_status: 'active', has_retired_at: false,
      session_status: 'active', receipts: '0', audits: '0', evidence_cursor: 'retiree-cursor-1',
      proofs: '1' });

    // Issuing session B advances the replica lifecycle, so only B may retire it.
    const first = await retire(server.origin, {
      token: RETIREE_TOKEN, sessionId: scope.sessionB.sessionId, key: 'retiree-key-1',
    });
    assert.equal(first.status, 204);
    assert.equal(first.body, null);
    assert.equal(first.headers.get('cache-control'), 'private, no-store');
    const retired = await retirementState(scope.replica.replicaId, scope.sessionA.sessionId);
    assert.deepEqual(retired, { replica_status: 'retired', has_retired_at: true,
      session_status: 'terminated', receipts: '1', audits: '1', evidence_cursor: null, proofs: '0' });
    const revisionAfter = await isolated.runtime.pool.query(
      'select lifecycle_revision::text from sync_replicas where replica_id=$1', [scope.replica.replicaId],
    );
    assert.equal(revisionAfter.rows[0]?.lifecycle_revision,
      String(BigInt(revisionBefore.rows[0]?.lifecycle_revision ?? 0) + 1n));

    // Exact replay is idempotent: the same key returns 204 and commits no second receipt.
    const replay = await retire(server.origin, {
      token: RETIREE_TOKEN, sessionId: scope.sessionB.sessionId, key: 'retiree-key-1',
    });
    assert.equal(replay.status, 204);
    assert.equal(replay.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await retirementState(scope.replica.replicaId, scope.sessionA.sessionId), retired);

    // The same key under a different Session is a reuse attempt, not a replay.
    const reused = await retire(server.origin, {
      token: RETIREE_TOKEN, sessionId: scope.sessionA.sessionId, key: 'retiree-key-1',
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.headers.get('cache-control'), 'private, no-store');
    const reusedProblem = await problemOf(reused);
    assert.equal(schema.validate('problem', reusedProblem.body).valid, true);
    assert.equal(reusedProblem.body.code, 'idempotency_key_reused');
    assert.equal(reusedProblem.body.status, 409);
    assert.doesNotMatch(reusedProblem.text, /RETIRE-TOKEN-MARKER|SECRET/u);

    // A fresh key for an already-retired Replica is a lifecycle denial.
    const retiredDenial = await retire(server.origin, {
      token: RETIREE_TOKEN, sessionId: scope.sessionA.sessionId, key: 'retiree-key-2',
    });
    assert.equal(retiredDenial.status, 410);
    const retiredProblem = await problemOf(retiredDenial);
    assert.equal(schema.validate('problem', retiredProblem.body).valid, true);
    assert.equal(retiredProblem.body.code, 'replica_retired');
    assert.equal(retiredProblem.body.status, 410);

    // An unknown Session conceals existence with resource_not_found.
    const unknown = await retire(server.origin, {
      token: RETIREE_TOKEN, sessionId: 'no-such-retiree-session', key: 'retiree-key-3',
    });
    assert.equal(unknown.status, 404);
    const unknownProblem = await problemOf(unknown);
    assert.equal(schema.validate('problem', unknownProblem.body).valid, true);
    assert.equal(unknownProblem.body.code, 'resource_not_found');
    assert.equal(unknownProblem.body.status, 404);
    assert.doesNotMatch(unknownProblem.text, /no-such-retiree-session|RETIRE-TOKEN-MARKER/u);

    // No further retirement facts were committed by the denial paths.
    assert.deepEqual(await retirementState(scope.replica.replicaId, scope.sessionA.sessionId), retired);
  });

  test('serves one private effect page through the production route, reader and PostgreSQL', async () => {
    const server = await start();
    const response = await fetchEffectPage(server.origin, 'effect-subtree', 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(String(response.headers.get('content-type')), /^application\/json/u);
    const body = await response.json() as AuthoritativeEffectPage;
    assert.deepEqual(body, pages[0]);
    assert.equal(body.previousPageDigest, null);
    assert.equal(body.pageDigest, pages[0]!.pageDigest);
    assert.equal(body.memberCount, 64);
    assert.equal(body.pageCount, 3);
    assert.doesNotMatch(JSON.stringify(body), /EFFECT-PAGE-TOKEN-MARKER/u);
    const legacy = await fetchEffectPage(server.origin, 'effect-subtree', 1, {
      query: `collectionId=${COLLECTION}&replicaId=${readerReplica.replicaId}&sessionId=${readerSession.sessionId}`,
    });
    assert.equal(legacy.status, 200);
  });

  test('rejects an effect page request whose Origin does not match the durable Session binding', async () => {
    const server = await start([ORIGIN, FOREIGN_ORIGIN]);
    const response = await fetchEffectPage(server.origin, 'effect-subtree', 1, {
      originHeader: FOREIGN_ORIGIN,
    });
    assert.equal(response.status, 404);
  });

  test('returns the complete previous-page digest chain for a multi-page effect and rejects the page past the end', async () => {
    const server = await start();
    const first = await fetchEffectPage(server.origin, 'effect-subtree', 1);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as AuthoritativeEffectPage;
    const second = await fetchEffectPage(server.origin, 'effect-subtree', 2);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('cache-control'), 'private, no-store');
    const secondBody = await second.json() as AuthoritativeEffectPage;
    assert.equal(secondBody.pageNumber, 2);
    assert.equal(secondBody.previousPageDigest, firstBody.pageDigest);
    assert.deepEqual(secondBody.members, pages[1]!.members);
    const third = await fetchEffectPage(server.origin, 'effect-subtree', 3);
    assert.equal(third.status, 200);
    const thirdBody = await third.json() as AuthoritativeEffectPage;
    assert.equal(thirdBody.previousPageDigest, secondBody.pageDigest);
    assert.equal(thirdBody.memberCount, 2);
    assert.deepEqual(thirdBody.members, pages[2]!.members);
    assert.equal(thirdBody.pageCount, 3);

    const beyond = await fetchEffectPage(server.origin, 'effect-subtree', 4);
    assert.equal(beyond.status, 404);
    assert.equal(beyond.headers.get('cache-control'), 'private, no-store');
    const beyondProblem = await problemOf(beyond);
    assert.equal(beyondProblem.body.code, 'resource_not_found');
    assert.equal(beyondProblem.body.status, 404);
  });

  test('fails closed with a redacted 500 internal_error when the stored page fails integrity validation', async () => {
    const server = await start();
    const response = await fetchEffectPage(server.origin, 'effect-corrupt', 1);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(String(response.headers.get('content-type')), /^application\/problem\+json/u);
    const problem = await problemOf(response);
    assert.equal(problem.body.code, 'internal_error');
    assert.equal(problem.body.status, 500);
    assert.doesNotMatch(problem.text, /EFFECT-PAGE-TOKEN-MARKER|fx-corrupt|fx-tampered/u);
  });

  test('maps unknown effect, session and query to redacted resource_not_found 404 responses', async () => {
    const server = await start();
    const cases: { readonly effectId: string; readonly pageNumber: number;
      readonly sessionId?: string; readonly query?: string }[] = [
      { effectId: 'effect-missing', pageNumber: 1 },
      { effectId: 'effect-subtree', pageNumber: 1, sessionId: 'no-such-reader-session' },
      { effectId: 'effect-subtree', pageNumber: 1,
        query: `collectionId=${COLLECTION}&replicaId=${readerReplica.replicaId}&sessionId=other-session` },
      { effectId: 'effect-subtree', pageNumber: 1,
        query: `collectionId=${COLLECTION}&replicaId=${readerReplica.replicaId}&sessionId=${readerSession.sessionId}&extra=1` },
    ];
    for (const item of cases) {
      const response = await fetchEffectPage(server.origin, item.effectId, item.pageNumber, {
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
        ...(item.query ? { query: item.query } : {}),
      });
      assert.equal(response.status, 404, item.effectId);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(String(response.headers.get('content-type')), /^application\/problem\+json/u);
      const problem = await problemOf(response);
      assert.equal(problem.body.code, 'resource_not_found', item.effectId);
      assert.equal(problem.body.status, 404, item.effectId);
      assert.doesNotMatch(problem.text, /no-such-reader-session|EFFECT-PAGE-TOKEN-MARKER/u);
    }
  });

  test('denies foreign origins with the sibling 403 origin_not_allowed before any reader work', async () => {
    const server = await start();
    const response = await fetchEffectPage(server.origin, 'effect-subtree', 1,
      { originHeader: 'https://wrong.example' });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(String(response.headers.get('content-type')), /^application\/problem\+json/u);
    const problem = await problemOf(response);
    assert.equal(problem.body.code, 'origin_not_allowed');
    assert.equal(problem.body.status, 403);
    assert.doesNotMatch(problem.text, /wrong\.example|EFFECT-PAGE-TOKEN-MARKER/u);
  });

  test('enforces extension authentication with 401 before any reader work and never leaks the bearer marker', async () => {
    const server = await start();
    const missing = await fetchEffectPage(server.origin, 'effect-subtree', 1, { omitAuthorization: true });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('cache-control'), 'private, no-store');
    const missingProblem = await problemOf(missing);
    assert.equal(missingProblem.body.code, 'authentication_required');
    assert.equal(missingProblem.body.status, 401);
    assert.doesNotMatch(missingProblem.text, /EFFECT-PAGE-TOKEN-MARKER/u);

    const wrong = await fetchEffectPage(server.origin, 'effect-subtree', 1, { token: 'ATTACKER-TOKEN' });
    assert.equal(wrong.status, 401);
    const wrongProblem = await problemOf(wrong);
    assert.equal(wrongProblem.body.code, 'authentication_required');
    assert.doesNotMatch(wrongProblem.text, /ATTACKER-TOKEN|EFFECT-PAGE-TOKEN-MARKER/u);
  });
});
