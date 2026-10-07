import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SyncSessionRequest } from '@know-n/colp/types';
import { assembleSnapshotPages } from '@know-n/colp/semantic';
import {
  encodeSyncTransportBudgetHeader,
  SYNC_TRANSPORT_BUDGET_EXTENSION,
  SYNC_TRANSPORT_BUDGET_HEADER,
} from '@know-n/colp/sync';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
} from '../../../src/infrastructure/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

import { createSyncSessionHttpTestServer, client, ISSUER, ORIGIN, TOKEN } from '../../support/sync-session-http-test-server.js';

const NATIVE_MARKER = 'native-SYNC-HTTP-BINDING-MARKER';
const sessionAuthorityContract = JSON.parse(readFileSync(new URL(
  '../../fixtures/phase3/session-authority-contract.json', import.meta.url), 'utf8')) as {
  successfulLeaseStates: string[]; authorities: { recovery: { snapshotRequired: boolean } };
  snapshotQueryFields: string[];
};

describeWithPostgres('P3-08 Sync Session real HTTP/PostgreSQL black box', () => {
  let isolated: IsolatedPostgresRuntime;
  let credential: Awaited<ReturnType<typeof mintVerifiedExtensionCredentialFixture>>;
  const apps: FastifyInstance[] = [];
  let start: ReturnType<typeof createSyncSessionHttpTestServer>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_session_http', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ('http-account','http-subject','active')");
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('http-identity','http-account',$1,'http-oidc')`, [ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('sync_http','http-account')");
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ('http-collection','collection'),('http-root','node'),('http-folder','node'),
        ('http-folder-special','node'),('http-bookmark','node'),('http-separator','node')`);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ('http-collection','http-subject','HTTP Sync','bookmarks','http-root','r1','c1','p1')`);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('http-root','http-collection','folder',true,'Root','r1','ch1')`);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,title,url,description,tags,visibility,position_token,resource_revision,children_revision,
         payload_json,payload_schema_version,payload_authority_status)
        values
        ('http-folder','http-collection','http-root','folder','Private folder',null,'stale column',
          '["stale-column-tag"]'::jsonb,'private','A','r2','ch2',
          '{"description":"Canonical description","tags":["canonical-tag"],"extensions":{"https://unknown.example/nested":{"bytes":["raw",{"keep":true}]}}}'::jsonb,1,'backfilled'),
        ('http-folder-special','http-collection','http-root','folder','Bookmarks bar',null,null,null,'inherit','B','r3','ch3','{"folderRole":"bookmarks-bar"}'::jsonb,1,'backfilled'),
        ('http-bookmark','http-collection','http-root','bookmark','Secret bookmark','https://private.example/path',null,null,'inherit','C','r4','ch4','{}'::jsonb,1,'backfilled'),
        ('http-separator','http-collection','http-root','separator',null,null,null,null,'inherit','D','r5','ch5','{}'::jsonb,1,'backfilled')`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
    await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => 'http-device', replicaId: () => 'http-replica', leaseId: () => 'http-lease',
    } }).create({
      accountId: 'http-account', collectionId: 'http-collection', deviceName: 'Laptop',
      replicaName: 'Chrome', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: false,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'http-profile', mountMode: 'mounted-folder',
        browserGeneration: 'http-installation' },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: 'http-account' });
    for (const state of ['expired', 'recovery', 'retired'] as const) {
      await createPostgresReplicaStore(isolated.runtime.db, { ids: {
        deviceId: () => `http-device-${state}`,
        replicaId: () => `http-replica-${state}`,
        leaseId: () => `http-lease-${state}`,
      } }).create({
        accountId: 'http-account', collectionId: 'http-collection', deviceName: `Laptop ${state}`,
        replicaName: `Chrome ${state}`, kind: 'browser_extension',
        adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
        capabilities: { read: true, write: true, events: true, separator: false,
          alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
        binding: { browserProfileId: `http-profile-${state}`, mountMode: 'mounted-folder',
          browserGeneration: `http-installation-${state}` },
        leaseDurationSeconds: 3_600,
      }, { actorAccountId: 'http-account' });
    }
    credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: 'http-oidc', credentialId: 'http-credential', evidenceTtlSeconds: 3_600,
    });
    start = createSyncSessionHttpTestServer(isolated, credential, apps);
  }, 20_000);

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => {
      try { await app.close(); } catch { /* already closed by restart evidence */ }
    }));
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test('creates, exact-replays after server restart, and leaves Manifest sync Profile unclaimed', async () => {
    const firstServer = await start();
    const first = await client(firstServer.origin).create({ idempotencyKey: 'restart-key', request: wireRequest() });
    assert.equal(first.status, 201);
    assert.equal(first.body.collection.snapshotRequired, true);
    const snapshot = await client(firstServer.origin).snapshot({ sessionId: first.body.sessionId, limit: 100 });
    assert.equal(snapshot.mode, 'sync');
    assert.equal(snapshot.collection.id, 'http-collection');
    assert.deepEqual(snapshot.collection.extensions?.['https://known.example/extensions/sync-binding'], {
      mode: 'mounted-folder', rootNodeId: 'http-root',
    });
    assert.equal(snapshot.nodes[0]?.kind, 'root');
    assert.deepEqual(snapshot.nodes.map((node) => node.kind), ['root', 'folder', 'folder', 'bookmark', 'separator']);
    assert.equal(snapshot.nodes[0]?.folderRole, 'root');
    assert.equal(snapshot.nodes[1]?.folderRole, undefined);
    assert.equal(snapshot.nodes[2]?.folderRole, 'bookmarks-bar');
    assert.deepEqual(snapshot.nodes[1]?.extensions?.['https://unknown.example/nested'], {
      bytes: ['raw', { keep: true }],
    });
    assert.equal(snapshot.nodes[1]?.description, 'Canonical description');
    assert.deepEqual(snapshot.nodes[1]?.tags, ['canonical-tag']);
    assert.equal(snapshot.nodes[1]?.visibility, 'private');
    assert.equal(snapshot.page.hasMore, false);
    assert.equal(typeof snapshot.syncCursor, 'string');
    const roleFacts = await isolated.runtime.pool.query(`select id,payload_json->>'folderRole' as payload_role,
      folder_role as generated_folder_role from nodes where id in ('http-root','http-folder','http-folder-special') order by id`);
    assert.deepEqual(roleFacts.rows, [
      { id: 'http-folder', payload_role: null, generated_folder_role: null },
      { id: 'http-folder-special', payload_role: 'bookmarks-bar', generated_folder_role: 'bookmarks-bar' },
      { id: 'http-root', payload_role: null, generated_folder_role: null },
    ]);
    const persisted = await isolated.runtime.pool.query('select completed_at from sync_bootstrap_snapshots where snapshot_id=$1', [snapshot.snapshotId]);
    assert.equal(persisted.rowCount, 1);
    assert.notEqual(persisted.rows[0].completed_at, null);
    const cursorEvidence = await isolated.runtime.pool.query(
      'select cursor from sync_pull_cursor_evidence where replica_id=$1 and cursor=$2',
      [wireRequest().replica.replicaId, snapshot.syncCursor]);
    assert.equal(cursorEvidence.rowCount, 1);
    await firstServer.app.close();
    const secondServer = await start();
    const replay = await client(secondServer.origin).create({ idempotencyKey: 'restart-key', request: wireRequest() });
    assert.deepEqual(replay.body, first.body);
    assert.equal(replay.body.collection.serverRevision, 'c1');
    assert.deepEqual(secondServer.app.hasRoute({ method: 'POST', url: '/private-entry/session-negotiation' }), true);
    const rows = await isolated.runtime.pool.query(
      "select session_id from sync_sessions where replica_id='http-replica'",
    );
    assert.equal(rows.rowCount, 1);
  }, 20_000);

  test('preserves Folder roles on a stored Snapshot continuation and rejects an invalid role', async () => {
    const server = await start();
    const session = await client(server.origin).create({ idempotencyKey: 'snapshot-folder-role-session', request: wireRequest() });
    assert.equal(session.status, 201);
    const first = await client(server.origin).snapshot({ sessionId: session.body.sessionId, limit: 2 });
    assert.deepEqual(first.nodes.map((node) => node.id), ['http-root', 'http-folder']);
    assert.equal(first.nodes[0]?.folderRole, 'root');
    assert.equal(first.nodes[1]?.folderRole, undefined);
    const continuation = await client(server.origin).snapshot({ sessionId: session.body.sessionId, limit: 2,
      pageCursor: first.page.nextCursor! });
    assert.deepEqual(continuation.nodes.map((node) => node.id), ['http-folder-special', 'http-bookmark']);
    assert.equal(continuation.nodes[0]?.folderRole, 'bookmarks-bar');
    assert.equal(continuation.nodes[1]?.folderRole, undefined);
    await isolated.runtime.pool.query(`update nodes set payload_json=jsonb_set(payload_json,'{folderRole}',
      '"invalid-role"'::jsonb,true) where id='http-folder-special'`);
    try {
      const invalid = await fetch(`${server.origin}/private-entry/snapshot-download?sessionId=${encodeURIComponent(session.body.sessionId)}&limit=2`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN,
          'Known-Sync-Session': session.body.sessionId },
      });
      assert.equal(invalid.status, 500, await invalid.clone().text());
      assert.equal((await invalid.json() as { readonly code?: unknown }).code, 'internal_error');
    } finally {
      await isolated.runtime.pool.query(`update nodes set payload_json=jsonb_set(payload_json,'{folderRole}',
        '"bookmarks-bar"'::jsonb,true) where id='http-folder-special'`);
    }
  }, 20_000);

  test('binds the negotiated transport budget once and keeps it immutable', async () => {
    const server = await start();
    const budget = {
      pullResponseBytes: 64 * 1024,
      snapshotPageBytes: 64 * 1024,
      effectPageBytes: 32 * 1024,
      effectAggregateBytes: 64 * 1024,
    };
    const request: SyncSessionRequest = {
      ...wireRequest(),
      replica: {
        ...wireRequest().replica,
        extensions: { [SYNC_TRANSPORT_BUDGET_EXTENSION]: budget },
      },
    };
    const response = await postWire(server.origin, 'transport-budget-binding', request);
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal(response.headers.get(SYNC_TRANSPORT_BUDGET_HEADER), encodeSyncTransportBudgetHeader(budget));
    const body = await response.json() as { readonly sessionId: string };
    const stored = await isolated.runtime.pool.query(
      "select binding_json->'transportBudget' as budget from sync_sessions where session_id=$1",
      [body.sessionId],
    );
    assert.deepEqual(stored.rows[0]?.budget, budget);
    await assert.rejects(isolated.runtime.pool.query(`update sync_sessions
      set binding_json=jsonb_set(binding_json,'{transportBudget,pullResponseBytes}','131072'::jsonb)
      where session_id=$1`, [body.sessionId]), /immutable/iu);
    await assert.rejects(isolated.runtime.pool.query(`update sync_sessions
      set binding_json=binding_json || '{"extra":"tampered"}'::jsonb where session_id=$1`,
    [body.sessionId]), /immutable/iu);
  }, 20_000);

  test('concurrent real HTTP requests with one key produce one Session and one receipt', async () => {
    const server = await start();
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      client(server.origin).create({ idempotencyKey: 'concurrent-http-key', request: wireRequest() })));
    assert.equal(new Set(responses.map((item) => JSON.stringify(item.body))).size, 1);
    const receipt = await isolated.runtime.pool.query(
      "select session_id from sync_session_idempotency_receipts where idempotency_key='concurrent-http-key'",
    );
    assert.equal(receipt.rowCount, 1);
    const sessions = await isolated.runtime.pool.query(
      'select session_id from sync_sessions where session_id=$1', [receipt.rows[0].session_id],
    );
    assert.equal(sessions.rowCount, 1);
  }, 20_000);

  test('production registration option creates only a fresh generation-one Replica through Session HTTP', async () => {
    const request: SyncSessionRequest = { ...wireRequest(), replica: { ...wireRequest().replica,
      replicaId: 'http-replica-fresh-install', name: 'Fresh Chromium',
      binding: { ...wireRequest().replica.binding, browserProfileId: 'http-profile-fresh-install', generation: '1' } } };
    const closedServer = await start();
    const rejected = await fetch(`${closedServer.origin}/private-entry/session-negotiation`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'fresh-closed',
        origin: ORIGIN,
      },
      body: JSON.stringify(request),
    });
    assert.equal(rejected.status, 404);

    const productionServer = await start({ registerUnknownGenerationOneReplica: true });
    const accepted = await Promise.all(Array.from({ length: 2 }, () =>
      client(productionServer.origin).create({ idempotencyKey: 'fresh-install-key', request })));
    assert.ok(accepted.every((response) => response.status === 201));
    const replica = await isolated.runtime.pool.query(`select replica_id,lease_generation,browser_profile_id,status
      from sync_replicas where replica_id='http-replica-fresh-install'`);
    assert.equal(replica.rowCount, 1);
    assert.deepEqual(replica.rows[0], { replica_id: 'http-replica-fresh-install', lease_generation: '1',
      browser_profile_id: 'http-profile-fresh-install', status: 'active' });

    const oldGeneration: SyncSessionRequest = { ...request, replica: { ...request.replica,
      replicaId: 'http-replica-old-backup', binding: { ...request.replica.binding, generation: '2' } } };
    const oldRejected = await fetch(`${productionServer.origin}/private-entry/session-negotiation`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': 'old-backup',
        origin: ORIGIN,
      },
      body: JSON.stringify(oldGeneration),
    });
    assert.equal(oldRejected.status, 404);
  }, 20_000);

  test('FIX-L-036 first-install registration honors the shared Replica lease bounds (86400/86401/2592000, oversized rejected)', async () => {
    const accepted = [
      { leaseSeconds: 86_400, replicaId: 'http-replica-lease-86400' },
      { leaseSeconds: 86_401, replicaId: 'http-replica-lease-86401' },
      { leaseSeconds: 2_592_000, replicaId: 'http-replica-lease-2592000' },
    ] as const;
    for (const item of accepted) {
      const request: SyncSessionRequest = { ...wireRequest(), replica: { ...wireRequest().replica,
        replicaId: item.replicaId, name: `Lease ${item.leaseSeconds}`,
        binding: { ...wireRequest().replica.binding, browserProfileId: `http-profile-${item.replicaId}`, generation: '1' } } };
      const server = await start({ registerUnknownGenerationOneReplica: true,
        registrationLeaseSeconds: item.leaseSeconds });
      const response = await client(server.origin).create({
        idempotencyKey: `lease-${item.leaseSeconds}-key`, request,
      });
      assert.equal(response.status, 201, item.replicaId);
      const lease = await isolated.runtime.pool.query(`select
        extract(epoch from (lease_expires_at - current_timestamp)) as lease_seconds
        from sync_replicas where replica_id=$1`, [item.replicaId]);
      assert.equal(lease.rowCount, 1, item.replicaId);
      const seconds = Number(lease.rows[0].lease_seconds);
      assert.ok(seconds >= item.leaseSeconds - 2 && seconds <= item.leaseSeconds + 2,
        `${item.replicaId} persisted lease ${seconds}s does not match ${item.leaseSeconds}s`);
      await server.app.close();
    }

    const oversized: SyncSessionRequest = { ...wireRequest(), replica: { ...wireRequest().replica,
      replicaId: 'http-replica-lease-oversized', name: 'Oversized lease',
      binding: { ...wireRequest().replica.binding, browserProfileId: 'http-profile-lease-oversized', generation: '1' } } };
    const server = await start({ registerUnknownGenerationOneReplica: true, registrationLeaseSeconds: 2_592_001 });
    const rejected = await fetch(`${server.origin}/private-entry/session-negotiation`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        'idempotency-key': 'lease-oversized-key', origin: ORIGIN }, body: JSON.stringify(oversized),
    });
    assert.equal(rejected.status, 422, await rejected.clone().text());
    assert.equal((await rejected.json() as { code: string }).code, 'invalid_document');
    const absent = await isolated.runtime.pool.query(
      'select count(*)::int as count from sync_replicas where replica_id=$1', [oversized.replica.replicaId]);
    assert.equal(absent.rows[0].count, 0);
    await server.app.close();
  }, 20_000);

  test('rolls back generation-one registration when Session issuance fails and exact retry succeeds', async () => {
    const request: SyncSessionRequest = { ...wireRequest(), replica: { ...wireRequest().replica,
      replicaId: 'http-replica-registration-rollback', name: 'Rollback Chromium',
      binding: { ...wireRequest().replica.binding, browserProfileId: 'http-profile-registration-rollback', generation: '1' } } };
    const failedServer = await start({ registerUnknownGenerationOneReplica: true, sessionIssueFault: 'finalize' });
    const failed = await fetch(`${failedServer.origin}/private-entry/session-negotiation`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        'idempotency-key': 'registration-rollback-key', origin: ORIGIN }, body: JSON.stringify(request),
    });
    assert.equal(failed.status, 500);
    const absent = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_replicas where replica_id=$1) as replicas,
      (select count(*)::int from sync_replica_id_ledger where replica_id=$1) as lifetimes,
      (select count(*)::int from sync_sessions where replica_id=$1) as sessions`, [request.replica.replicaId]);
    assert.deepEqual(absent.rows[0], { replicas: 0, lifetimes: 0, sessions: 0 });
    await failedServer.app.close();
    const retryServer = await start({ registerUnknownGenerationOneReplica: true });
    const retry = await client(retryServer.origin).create({ idempotencyKey: 'registration-rollback-key', request });
    assert.equal(retry.status, 201);
  }, 20_000);

  test('materializes one fenced Snapshot concurrently and completes it only after restart continuation', async () => {
    const server = await start();
    const session = await client(server.origin).create({ idempotencyKey: 'snapshot-concurrency-session', request: wireRequest() });
    const beforeReplica = await isolated.runtime.pool.query(
      "select status,checkpoint_cursor,checkpoint_commit_ordinal from sync_replicas where replica_id='http-replica'",
    );
    const firstPages = await Promise.all(Array.from({ length: 8 }, () =>
      client(server.origin).snapshot({ sessionId: session.body.sessionId, limit: 2 })));
    assert.equal(new Set(firstPages.map((page) => page.snapshotId)).size, 1);
    assert.ok(firstPages.every((page) => typeof page.page.nextCursor === 'string'
      && page.page.nextCursor.length > 0));
    assert.equal(firstPages[0]?.page.hasMore, true);
    const persistedBeforeFinal = await isolated.runtime.pool.query(
      'select snapshot_id,completed_at from sync_bootstrap_snapshots where session_id=$1', [session.body.sessionId],
    );
    assert.equal(persistedBeforeFinal.rowCount, 1);
    assert.equal(persistedBeforeFinal.rows[0].completed_at, null);
    const afterFirstPageReplica = await isolated.runtime.pool.query(
      "select status,checkpoint_cursor,checkpoint_commit_ordinal from sync_replicas where replica_id='http-replica'",
    );
    assert.deepEqual(afterFirstPageReplica.rows, beforeReplica.rows);

    await isolated.runtime.pool.query("update collections set content_revision='c2' where id='http-collection'");
    await assert.rejects(
      () => client(server.origin).snapshot({ sessionId: session.body.sessionId, limit: 2, pageCursor: firstPages[0]!.page.nextCursor! }),
      /snapshot_expired/u,
    );
    await isolated.runtime.pool.query("update collections set content_revision='c1' where id='http-collection'");
    await server.app.close();

    const restarted = await start();
    const pages = [firstPages[0]!];
    let cursor = pages[0]!.page.nextCursor;
    while (cursor) {
      const page = await client(restarted.origin).snapshot({ sessionId: session.body.sessionId, limit: 2, pageCursor: cursor });
      pages.push(page);
      cursor = page.page.nextCursor;
    }
    assert.equal(assembleSnapshotPages(pages).valid, true);
    const persistedAfterFinal = await isolated.runtime.pool.query(
      'select completed_at from sync_bootstrap_snapshots where session_id=$1', [session.body.sessionId],
    );
    assert.notEqual(persistedAfterFinal.rows[0].completed_at, null);
    const afterFinalReplica = await isolated.runtime.pool.query(
      "select status,checkpoint_cursor,checkpoint_commit_ordinal from sync_replicas where replica_id='http-replica'",
    );
    assert.deepEqual(afterFinalReplica.rows, beforeReplica.rows);
  }, 20_000);

  test('replays after the committed success response is lost and process state is rebuilt', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstServer = await start({ responseGate: gate });
    const abort = new AbortController();
    const pending = postWire(firstServer.origin, 'lost-response-key', wireRequest(), TOKEN, abort.signal);
    try {
      await waitForReceipt('lost-response-key');
    } finally {
      abort.abort();
      release();
    }
    await assert.rejects(pending);
    await firstServer.app.close();
    const restarted = await start();
    const replay = await client(restarted.origin).create({
      idempotencyKey: 'lost-response-key', request: wireRequest(),
    });
    assert.equal(replay.status, 201);
    const receipt = await isolated.runtime.pool.query(
      "select count(*)::int as count from sync_session_idempotency_receipts where idempotency_key='lost-response-key'",
    );
    assert.equal(receipt.rows[0].count, 1);
  }, 20_000);

  test('authentication, concealment and retired Replica denials have no lease or Session side effects', async () => {
    const server = await start();
    const before = await sideEffectSnapshot();
    const badCredential = await postWire(server.origin, 'bad-credential', wireRequest(), 'wrong-token');
    assert.equal(badCredential.status, 401);
    const concealed = await postWire(server.origin, 'wrong-collection', {
      ...wireRequest(), collection: { ...wireRequest().collection!, collectionId: 'not-visible' },
    });
    assert.equal(concealed.status, 404);
    assert.deepEqual(await sideEffectSnapshot(), before);
    const states = [{ name: 'retired', replicaId: 'http-replica-retired', status: 'retired' }] as const;
    for (const state of states) {
      await isolated.runtime.pool.query(`update sync_replicas set status=$1,
        retired_at=case when $1='retired' then current_timestamp else null end where replica_id=$2`,
      [state.status, state.replicaId]);
      const stateBefore = await sideEffectSnapshot(state.replicaId);
      const denied = await postWire(server.origin, `state-${state.name}`, wireRequest(state.name));
      assert.equal(denied.status, 410);
      assert.deepEqual(await sideEffectSnapshot(state.replicaId), stateBefore);
    }
  }, 20_000);

  test('issues a bootstrap-only Session without renewing a recovery-required Replica lease', async () => {
    const server = await start(); const replicaId = 'http-replica-recovery';
    await isolated.runtime.pool.query(`update sync_replicas set status='recovery_required',
      wire_json=jsonb_set(wire_json,'{status}','"recovery_required"') where replica_id=$1`, [replicaId]);
    const before = await isolated.runtime.pool.query(
      'select lease_generation,lifecycle_revision,last_seen_at,lease_expires_at from sync_replicas where replica_id=$1',
      [replicaId]);
    const response = await postWire(server.origin, 'recovery-session', wireRequest('recovery'));
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json() as { sessionId: string; replicaLease: { state: string; generation: string };
      collection: { snapshotRequired: boolean } };
    // COLP activeReplicaLease remains wire-compatible; snapshotRequired is the explicit recovery authority signal.
    assert.equal(body.replicaLease.state, 'active');
    assert.equal(sessionAuthorityContract.successfulLeaseStates.includes(body.replicaLease.state), true);
    assert.equal(body.replicaLease.generation, '1');
    assert.equal(body.collection.snapshotRequired, true);
    assert.equal(body.collection.snapshotRequired, sessionAuthorityContract.authorities.recovery.snapshotRequired);
    const after = await isolated.runtime.pool.query(
      'select lease_generation,lifecycle_revision,last_seen_at,lease_expires_at from sync_replicas where replica_id=$1',
      [replicaId]);
    assert.deepEqual(after.rows, before.rows);
    const scopes = await isolated.runtime.pool.query(`select granted.scope from sync_session_scopes granted
      join sync_sessions session on session.session_id=granted.session_id
      where session.replica_id=$1 order by granted.scope`, [replicaId]);
    assert.deepEqual(scopes.rows, [{ scope: 'sync:bootstrap' }]);

    const snapshotUrl = new URL('/private-entry/snapshot-download', server.origin);
    snapshotUrl.searchParams.set('sessionId', body.sessionId);
    snapshotUrl.searchParams.set('limit', '100');
    assert.deepEqual([...snapshotUrl.searchParams.keys()], sessionAuthorityContract.snapshotQueryFields.slice(0, 2));
    const snapshot = await fetch(snapshotUrl, { headers: {
      Accept: 'application/json', Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN,
      'Known-Sync-Session': body.sessionId,
      'Collection-Protocol-Version': '0.2',
    } });
    assert.equal(snapshot.status, 200, await snapshot.clone().text());
    const document = await snapshot.json() as { syncCursor?: unknown };
    assert.equal(typeof document.syncCursor, 'string');
  }, 20_000);

  test('rejects Snapshot authority for an active Replica after its lease expires', async () => {
    const server = await start();
    const session = await postWire(server.origin, 'expired-snapshot-session', wireRequest());
    assert.equal(session.status, 201, await session.clone().text());
    const sessionId = ((await session.json()) as { sessionId: string }).sessionId;
    await isolated.runtime.pool.query(`update sync_replicas set
      last_seen_at=current_timestamp - interval '2 seconds',lease_expires_at=current_timestamp - interval '1 second'
      where replica_id='http-replica'`);
    try {
      const response = await fetch(`${server.origin}/private-entry/snapshot-download?sessionId=${encodeURIComponent(sessionId)}&limit=100`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      });
      assert.equal(response.status, 404, await response.clone().text());
    } finally {
      await isolated.runtime.pool.query("update sync_replicas set lease_expires_at=current_timestamp + interval '1 hour' where replica_id='http-replica'");
    }
  }, 20_000);

  test('does not require Snapshot for an active Replica with a durable checkpoint', async () => {
    await isolated.runtime.pool.query(`update sync_replicas set checkpoint_cursor='checkpoint-http',
      checkpoint_commit_ordinal=0,checkpoint_stream_kind=0,checkpoint_stable_id='',
      wire_json=jsonb_set(jsonb_set(wire_json,'{checkpoint,acknowledgedCursor}',
        '"checkpoint-http"'::jsonb),'{checkpoint,acknowledgedCommitOrdinal}','"0"'::jsonb)
      where replica_id='http-replica'`);
    const server = await start();
    const response = await postWire(server.origin, 'checkpoint-session', wireRequest());
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json() as { replicaLease: { state: string };
      collection: { snapshotRequired: boolean; serverCursor: string } };
    assert.equal(body.replicaLease.state, 'active');
    assert.equal(body.collection.snapshotRequired, false);
    assert.equal(body.collection.serverCursor, 'checkpoint-http');
  }, 20_000);

  test('does not expose request markers or encrypted Session secrets in HTTP or plaintext stores', async () => {
    const server = await start();
    const response = await postWire(server.origin, 'secret-scan-key', wireRequest());
    assert.equal(response.status, 201);
    const body = await response.text();
    assert.doesNotMatch(body, /SYNC-HTTP-(?:TOKEN|BINDING)-MARKER/u);
    const stored = {
      credentials: (await isolated.runtime.pool.query(
        'select credential_digest,subject,client_id,scopes_json from sync_extension_credentials',
      )).rows,
      sessions: (await isolated.runtime.pool.query(
        'select binding_json,secret_digest,capability_digest from sync_sessions',
      )).rows,
      bindings: (await isolated.runtime.pool.query(
        'select account_id,collection_id,replica_id,browser_profile_id,browser_generation from sync_session_bindings',
      )).rows,
      receipts: (await isolated.runtime.pool.query(
        "select encode(result_ciphertext,'base64') as ciphertext,result_digest from sync_session_idempotency_receipts",
      )).rows,
      audit: (await isolated.runtime.pool.query(
        `select payload.details_json from audit_events event
          join audit_event_payloads payload on payload.event_id=event.id
          where event.event_type like 'sync.session.%'`,
      )).rows,
    };
    assert.doesNotMatch(JSON.stringify(stored), /SYNC-HTTP-(?:TOKEN|BINDING)-MARKER/u);
  }, 20_000);

  async function waitForReceipt(idempotencyKey: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = await isolated.runtime.pool.query(
        'select 1 from sync_session_idempotency_receipts where idempotency_key=$1', [idempotencyKey],
      );
      if (row.rowCount === 1) return;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for committed Sync Session receipt');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async function sideEffectSnapshot(replicaId = 'http-replica') {
    const replica = await isolated.runtime.pool.query(
      'select lease_generation,lifecycle_revision,last_seen_at,lease_expires_at from sync_replicas where replica_id=$1',
      [replicaId],
    );
    const counts = await isolated.runtime.pool.query(`select
      (select count(*)::int from sync_sessions) as sessions,
      (select count(*)::int from sync_session_idempotency_receipts) as receipts,
      (select count(*)::int from audit_events where event_type='sync.session.issued') as audits`);
    return JSON.parse(JSON.stringify({ replica: replica.rows, counts: counts.rows }));
  }
});

function postWire(
  origin: string,
  idempotencyKey: string,
  request: SyncSessionRequest,
  token = TOKEN,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${origin}/private-entry/session-negotiation`, {
    method: 'POST', signal,
    headers: {
      Authorization: `Bearer ${token}`, 'Idempotency-Key': idempotencyKey,
      Origin: ORIGIN, 'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
}

function wireRequest(state?: 'expired' | 'recovery' | 'retired'): SyncSessionRequest {
  const suffix = state ? `-${state}` : '';
  return {
    protocolVersion: '0.1', scope: 'collection', clientTime: '2026-07-25T10:00:00Z',
    replica: {
      replicaId: `http-replica${suffix}`, name: 'Chrome', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: false,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `http-profile${suffix}`, mountMode: 'mounted-folder',
        mountNativeId: NATIVE_MARKER, generation: `http-installation${suffix}` },
      extensions: {},
    },
    collection: { collectionId: 'http-collection', lastCursor: null, lastRevision: null,
      bootstrapMode: 'download' },
  };
}
