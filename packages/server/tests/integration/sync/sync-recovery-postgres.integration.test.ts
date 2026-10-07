import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, test } from 'vitest';
import Fastify from 'fastify';
import { sql } from 'kysely';
import type { PoolClient } from 'pg';
import type { Manifest, Snapshot, SyncSessionRequestV02, SyncSnapshotV02 } from '@know-n/colp/types';
import { assembleSnapshotPages } from '@know-n/colp/semantic';
import { createSyncSessionRuntime } from '../../../src/bootstrap/api.js';
import type { SyncSessionConfig } from '../../../src/bootstrap/config.js';
import { createPostgresSharedExposureFactsPort, runMigrations, createAttachmentExposurePolicyAdapter } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresSyncAckApplication,
  createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncPullReadPort,
  createPostgresSyncSessionIssuer,
  createPostgresSyncRecoveryApplication,
  PostgresSyncEvidenceMaintenanceCoordinator,
  createSyncPullCursorLineageKeyring,
  createSyncPullCursorKeyring,
  type SyncRecoveryFaultPhase,
} from '../../../src/infrastructure/sync/index.js';
import { mintExtensionCredentialHttpFixture } from '../../support/extension-credential.js';
import { SyncAckError, SyncBootstrapSnapshotError, type SyncPullReadPort } from '../../../src/modules/sync/index.js';
import { registerSyncAckRoutes } from '../../../src/transport/colp-sync/sync-ack-routes.js';
import { registerSyncPullRoutes } from '../../../src/transport/colp-sync/sync-pull-routes.js';
import { registerSyncSnapshotRoutes } from '../../../src/transport/colp-sync/sync-snapshot-routes.js';
import { registerSyncSessionRoutes } from '../../../src/transport/colp-sync/sync-session-routes.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import { classifySessionAuthority, credentialAuthorityDigest,
  parseSyncSessionResult } from '../../../../Known-Extension/src/session-client.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedRecoveryFixture } from '../../support/sync-recovery-fixture.js';

describeWithPostgres('P3-24 stale Replica Snapshot recovery', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_recovery', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 20_000);
  afterAll(async () => isolated?.close());

  test('marks a cursor at the full purge tuple recovery_required and invalidates incremental authority atomically', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'boundary');
    const result = await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorAtBoundary });
    assert.equal(result.state, 'recovery_required');
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
    assert.equal(replica.status, 'recovery_required');
    assert.equal(await isolated.runtime.db.selectFrom('sync_sessions').select('status')
      .where('session_id', '=', fixture.sessionId).executeTakeFirstOrThrow().then((row) => row.status), 'active');
  });

  test('keeps a cursor beyond the full purge tuple active without a recovery side effect', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'beyond-boundary');
    await assert.rejects(fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeyondBoundary }), /scope/iu);
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').select(['status', 'lifecycle_revision'])
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
    assert.equal(replica.status, 'active');
    assert.equal(await isolated.runtime.db.selectFrom('audit_events')
      .innerJoin('audit_event_payloads', 'audit_event_payloads.event_id', 'audit_events.id')
      .select('audit_events.id')
      .where('audit_events.event_type', '=', 'sync.replica.lifecycle.recovery_required')
      .where(sql<boolean>`audit_event_payloads.details_json ->> 'replicaId' = ${fixture.replicaId}`).execute()
      .then((rows) => rows.length), 0);
  });

  test('requires server-observed contiguous frozen Snapshot pages and exact identity/revision', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'pages');
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await assert.rejects(fixture.application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId }), /scope|snapshot|page/iu);
    await fixture.recordPage(1, 0, 200, false);
    await fixture.recordPage(3, 400, 401, true);
    await assert.rejects(fixture.application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId }), /scope|snapshot|page/iu);
    await fixture.recordPage(2, 200, 400, false);
    await isolated.runtime.pool.query(`update sync_bootstrap_snapshots
      set completed_at=GREATEST(generated_at, current_timestamp)
      where snapshot_id=$1 and completed_at is null
        and GREATEST(generated_at, current_timestamp)<expires_at`, [fixture.snapshotId]);
    await assert.rejects(fixture.application.bootstrapAcknowledge({ credential: fixture.credential,
      idempotencyKey: 'wrong-revision', sessionId: fixture.sessionId,
      capability: fixture.capabilityFor({ snapshotRevision: 'wrong-revision' }),
      requestFingerprint: 'wrong-revision' }), /scope|snapshot|recovery/iu);
  });

  test('commits one fresh generation, checkpoint, receipt and audit; exact retry survives response loss', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'success');
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const capability = await fixture.application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    const request = { credential: fixture.credential, idempotencyKey: `recover-${randomUUID()}`,
      sessionId: fixture.sessionId, capability, requestFingerprint: 'exact-request' };
    const first = await fixture.application.bootstrapAcknowledge(request);
    const replay = await createPostgresSyncRecoveryApplication(isolated.runtime.db, fixture.options)
      .bootstrapAcknowledge(request);
    assert.deepEqual(replay, first);
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
    assert.equal(replica.status, 'active');
    assert.equal(replica.checkpoint_cursor, fixture.snapshotCursor);
    assert.equal(BigInt(replica.checkpoint_commit_ordinal), 43n);
    assert.notEqual(replica.lease_generation.toString(), fixture.oldGeneration);
    assert.notEqual(replica.lease_id, fixture.oldLeaseId);
    assert.equal(await isolated.runtime.db.selectFrom('sync_recovery_ack_receipts').selectAll()
      .where('replica_id', '=', fixture.replicaId).execute().then((rows) => rows.length), 1);
    assert.equal(await isolated.runtime.db.selectFrom('sync_replica_generations').selectAll()
      .where('replica_id', '=', fixture.replicaId).execute().then((rows) => rows.length), 2);
    assert.equal(await isolated.runtime.db.selectFrom('audit_events')
      .innerJoin('audit_event_payloads', 'audit_event_payloads.event_id', 'audit_events.id')
      .selectAll('audit_events')
      .where('audit_events.event_type', '=', 'sync.replica.snapshot_recovered')
      .where(sql<boolean>`audit_event_payloads.details_json ->> 'replicaId' = ${fixture.replicaId}`).execute()
      .then((rows) => rows.length), 1);
    const newSession = await createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 91), replayEncryptionKeyVersion: 1, sessionDurationSeconds: 900,
      replicaLeaseExtensionSeconds: 3_600, tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    }).issue({ credential: fixture.credential, idempotencyKey: `new-session-${randomUUID()}`,
      requestFingerprint: `new-session-${randomUUID()}`, collectionId: replica.collection_id,
      replicaId: replica.replica_id, expectedLeaseGeneration: replica.lease_generation.toString(),
      expectedLifecycleRevision: replica.lifecycle_revision.toString(), binding: {
        browserProfileId: replica.browser_profile_id, mountMode: replica.binding_mode,
        browserGeneration: replica.browser_generation }, requestedScopes: ['sync:bootstrap', 'sync:pull', 'sync:push'],
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
    assert.equal(newSession.state, 'issued');
    if (newSession.state !== 'issued') throw new Error('recovered generation could not issue a Session');
    const firstPull = await createPostgresSyncPullReadPort(isolated.runtime.db,
      createSyncPullCursorKeyring({ active: { id: 'new-generation-pull',
        secret: Buffer.alloc(32, 95).toString('base64') }, retained: [], ttlMs: 300_000 }))
      .read({ credential: fixture.credential, sessionId: newSession.envelope.sessionId,
        cursor: fixture.snapshotCursor, limit: 100 });
    assert.deepEqual(firstPull.events, []);
    assert.equal(firstPull.nextCursor, fixture.snapshotCursor);
  });

  test('activates a staged recovery Pull cursor at the purge boundary when the visible stream is empty', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'empty-stream-cursor', undefined, false);
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    const pullCursorKeyring = createSyncPullCursorKeyring({ active: { id: 'empty-stream-pull',
      secret: Buffer.alloc(32, 96).toString('base64') }, retained: [], ttlMs: 300_000 });
    const recovery = createPostgresSyncRecoveryApplication(isolated.runtime.db, {
      ...fixture.optionsWithoutFault, pullCursorKeyring, recoveryProofRetentionMs: 60_000,
    });
    const snapshotApplication = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      pullCursorKeyring, recoveryProofRetentionMs: 60_000, recovery,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const snapshot = await snapshotApplication.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } });
    assert.match(snapshot.syncCursor, /^src1\./u);
    const ack = await recovery.bootstrapAcknowledge({ credential: fixture.credential,
      idempotencyKey: `empty-stream-ack-${randomUUID()}`, sessionId: fixture.sessionId,
      capability: snapshot.syncCursor, requestFingerprint: 'empty-stream-exact-request' });
    assert.equal(ack.ackedCursor, snapshot.syncCursor);
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence')
      .select(['tuple_commit_ordinal', 'tuple_stream_kind', 'tuple_stable_id'])
      .where('replica_id', '=', fixture.replicaId).where('cursor', 'is not', null).executeTakeFirstOrThrow();
    assert.deepEqual({ commitOrdinal: BigInt(evidence.tuple_commit_ordinal).toString(),
      streamKind: evidence.tuple_stream_kind, stableId: evidence.tuple_stable_id },
    { commitOrdinal: '42', streamKind: 1, stableId: 'conflict-42' });
  });

  test('activates a staged cursor whose frozen anchor remains visible behind a later no-op operation', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'interior-stream-cursor', undefined, false);
    const insertVisibleOperation = async (operationId: string, ordinal: number) => {
      await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')",
        [operationId]);
      await insertTestOperation(isolated.runtime.db, {
        operationId, collectionId: `recovery-collection-interior-stream-cursor`,
        commitOrdinal: BigInt(ordinal), operationType: 'sync.node.update', payloadJson: {},
        actorPrincipalId: fixture.accountId,
        syncWireJson: { opId: operationId, replicaId: fixture.replicaId, sequence: ordinal,
          collectionId: `recovery-collection-interior-stream-cursor`, type: 'update_node_content',
          targetId: 'recovery-root-interior-stream-cursor', baseRevision: 'root-r1',
          occurredAt: '2026-07-26T12:00:00.000Z', payload: { base: { title: 'Root' }, value: { title: 'Root' } } },
      });
    };
    await insertVisibleOperation('interior-anchor-operation', 43);
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    const pullCursorKeyring = createSyncPullCursorKeyring({ active: { id: 'interior-stream-pull',
      secret: Buffer.alloc(32, 97).toString('base64') }, retained: [], ttlMs: 300_000 });
    const recovery = createPostgresSyncRecoveryApplication(isolated.runtime.db, {
      ...fixture.optionsWithoutFault, pullCursorKeyring, recoveryProofRetentionMs: 60_000,
    });
    const snapshotApplication = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      pullCursorKeyring, recoveryProofRetentionMs: 60_000, recovery,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const snapshot = await snapshotApplication.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } });
    await insertVisibleOperation('later-no-op-operation', 44);
    const ack = await recovery.bootstrapAcknowledge({ credential: fixture.credential,
      idempotencyKey: `interior-stream-ack-${randomUUID()}`, sessionId: fixture.sessionId,
      capability: snapshot.syncCursor, requestFingerprint: 'interior-stream-exact-request' });
    assert.equal(ack.ackedCursor, snapshot.syncCursor);
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence')
      .select(['tuple_commit_ordinal', 'tuple_stream_kind', 'tuple_stable_id'])
      .where('replica_id', '=', fixture.replicaId).where('cursor', 'is not', null).executeTakeFirstOrThrow();
    assert.deepEqual({ commitOrdinal: BigInt(evidence.tuple_commit_ordinal).toString(),
      streamKind: evidence.tuple_stream_kind, stableId: evidence.tuple_stable_id },
    { commitOrdinal: '43', streamKind: 0, stableId: 'interior-anchor-operation' });
  });

  test('denies recovery Ack when the staged Pull cursor page limit is unset, with zero durable writes', async () => {
    // Seed the snapshot with an spc2 bootstrap cursor from the start while
    // recovery_pull_page_limit stays NULL (the fixture omits the column), so
    // activateRecoveryPullCursor reaches its page-limit guard.
    const fixture = await seedRecoveryFixture(isolated, 'page-limit-deny', undefined, true, 'spc2.placeholder');
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const pullCursorKeyring = createSyncPullCursorKeyring({ active: { id: 'page-limit-deny-pull',
      secret: Buffer.alloc(32, 98).toString('base64') }, retained: [], ttlMs: 300_000 });
    const recovery = createPostgresSyncRecoveryApplication(isolated.runtime.db, {
      ...fixture.optionsWithoutFault, pullCursorKeyring, recoveryProofRetentionMs: 60_000,
    });
    const capability = await fixture.application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    await assert.rejects(recovery.bootstrapAcknowledge({ credential: fixture.credential,
      idempotencyKey: `page-limit-ack-${randomUUID()}`, sessionId: fixture.sessionId,
      capability, requestFingerprint: 'page-limit-exact-request' }),
    (error: unknown) => error instanceof SyncAckError && error.code === 'invalid_cursor_scope'
      && (error as { readonly authorityGuard?: string }).authorityGuard === 'recovery_ack_pull_page_limit');

    const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
    assert.equal(replica.status, 'recovery_required', 'the denied Ack must not activate the replica');
    assert.equal(replica.lease_generation.toString(), fixture.oldGeneration,
      'the denied Ack must not advance the lease generation');
    const generations = await isolated.runtime.db.selectFrom('sync_replica_generations').selectAll()
      .where('replica_id', '=', fixture.replicaId).execute();
    assert.equal(generations.length, 1, 'the generation insert must roll back with the denied transaction');
    const receipts = await isolated.runtime.db.selectFrom('sync_recovery_ack_receipts').selectAll()
      .where('replica_id', '=', fixture.replicaId).execute();
    assert.equal(receipts.length, 0, 'no Ack receipt may be written for a denied recovery');
    const audits = await isolated.runtime.db.selectFrom('audit_events')
      .innerJoin('audit_event_payloads', 'audit_event_payloads.event_id', 'audit_events.id')
      .select('audit_events.id')
      .where('audit_events.event_type', '=', 'sync.replica.snapshot_recovered')
      .where(sql<boolean>`audit_event_payloads.details_json ->> 'replicaId' = ${fixture.replicaId}`).execute();
    assert.equal(audits.length, 0, 'no snapshot_recovered audit may be written for a denied recovery');
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').selectAll()
      .where('replica_id', '=', fixture.replicaId).execute();
    assert.equal(evidence.length, 3, 'the seeded evidence rows must survive untouched (no redaction, no activation)');
    const proofs = await isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').selectAll()
      .where('replica_id', '=', fixture.replicaId).execute();
    assert.equal(proofs.length, 0, 'no recovery proof may be written for a denied recovery');
  });

  test('uses Manifest HTTP to traverse every frozen Snapshot page and Bootstrap Ack through production routes', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'http-black-box', undefined, true, undefined, '0.2');
    const app = Fastify({ logger: false });
    const authorization = 'Bearer P3-24-HTTP-SECRET';
    const originHeader = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const verifier = { async verify({ authorization: supplied }: { readonly authorization: string | readonly string[] | undefined }) {
      if (supplied !== authorization) throw new Error('denied'); return fixture.credential;
    } };
    const ordinaryAck = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    registerSyncSnapshotRoutes(app, { path: '/runtime/snapshot', credentialVerifier: verifier,
      application: createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
        cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
        recovery: fixture.application,
        attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
      }), allowedOrigins: [originHeader], rateLimit: { maxRequests: 100, windowMs: 60_000 },
      allowInsecureLoopback: true });
    registerSyncPullRoutes(app, { path: '/runtime/pull', credentialVerifier: verifier,
      reader: createPostgresSyncPullReadPort(isolated.runtime.db, createSyncPullCursorKeyring({ active: {
        id: 'pull-v1', secret: Buffer.alloc(32, 94).toString('base64'), }, retained: [], ttlMs: 300_000 })),
      allowedOrigins: [originHeader], rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 200,
      responseBudgetBytes: 1_048_576, requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 30,
      allowInsecureLoopback: true });
    registerSyncAckRoutes(app, { path: '/runtime/ack', credentialVerifier: verifier,
      application: { acknowledge(input) { return input.request.recoveryCapability !== undefined
        ? fixture.application.acknowledge(input) : ordinaryAck.acknowledge(input); } },
      allowedOrigins: [originHeader], rateLimit: { maxRequests: 100, windowMs: 60_000 },
      maxBodyBytes: 16_384, maxWarnings: 8, maxWarningBytes: 2_048, allowInsecureLoopback: true });
    app.get('/.well-known/collection-protocol', async () => recoveryManifest(app.server.address()));
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
      const origin = `http://127.0.0.1:${address.port}`;
      const client = createSyncSessionBlackBoxClient({ manifestUrl: `${origin}/.well-known/collection-protocol`,
        mountId: 'root', authorization, origin: originHeader });
      await assert.rejects(client.pull({ sessionId: fixture.sessionId,
        cursor: fixture.cursorBeforeBoundary, limit: 100 }), /recovery_required|unexpected status/iu);
      const staleAck = await client.ack({ idempotencyKey: `ordinary-stale-${randomUUID()}`,
        request: { sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary, warnings: [] } });
      assert.equal(staleAck.status, 410);
      assert.equal('code' in staleAck.body ? staleAck.body.code : undefined, 'stale_replica');
      const snapshots: Array<Snapshot | SyncSnapshotV02> = []; let pageCursor: string | undefined;
      do { const page = await client.snapshot({ sessionId: fixture.sessionId, limit: 200,
        ...(pageCursor ? { pageCursor } : {}) }); snapshots.push(page);
        pageCursor = page.page.nextCursor ?? undefined; } while (pageCursor);
      assert.deepEqual(snapshots.map((page) => page.page.sequence), [1, 2, 3]);
      assert.equal(snapshots.flatMap((page) => page.nodes).length, 401);
      assert.equal(new Set(snapshots.map((page) => page.syncCursor)).size, 1,
        'every recovery page must carry the identical syncCursor');
      assert.equal(snapshots.slice(0, -1).every((page) => page.recoveryCapability === undefined), true,
        'the capability must only appear on the complete page');
      const capability = snapshots.at(-1)!.recoveryCapability;
      if (typeof capability !== 'string') throw new Error('Recovery Snapshot omitted its Ack capability');
      assert.match(capability, /^src1\./u);
      const ack = await client.ack({ idempotencyKey: `http-recovery-${randomUUID()}`,
        request: { sessionId: fixture.sessionId, cursor: snapshots.at(-1)!.syncCursor,
          recoveryCapability: capability, warnings: [] } });
      assert.equal(ack.status, 200);
      await assert.rejects(client.pull({ sessionId: fixture.sessionId,
        cursor: fixture.cursorBeforeBoundary, limit: 100 }), /resource_not_found|unexpected status/iu);
    } finally { await app.close(); }
  }, 20_000);

  test('production composition migrates an expired acknowledged cursor through recovery to an active Pull authority', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'production-composition');
    let cursorNow = Date.now();
    const authorization = fixture.authorization;
    const originHeader = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const foreignCredential = await mintExtensionCredentialHttpFixture({ issuer: 'https://issuer.example',
      audience: 'known-api', clientId: 'known-extension', subject: 'foreign-recovery-subject',
      credentialId: `foreign-recovery-${randomUUID()}` });
    const credentialVerifier = { async verify(input: { readonly authorization: string | readonly string[] | undefined }) {
      try { return await fixture.credentialVerifier.verify(input); }
      catch { return foreignCredential.verifier.verify(input); }
    } };
    const runtime = createSyncSessionRuntime(isolated.runtime, productionSyncConfig(originHeader),
      new InMemoryMetrics(), undefined, { credentialVerifier,
        pullCursorNow: () => cursorNow,
        attachmentExposure: createAttachmentExposurePolicyAdapter({ async listBlobFacts() { return []; } }) }, []);
    const app = Fastify({ logger: false });
    const observedSnapshotRequests: Array<{ readonly query: readonly string[];
      readonly querySessionId: string | null; readonly headerSessionId: string | undefined;
      readonly credentialSubject: string | null; readonly credentialId: string | null }> = [];
    app.addHook('onRequest', async (request) => {
      if ((request.raw.url ?? '').startsWith('/runtime/snapshot?')) {
        const url = new URL(request.raw.url!, 'https://sync.invalid');
        const authorizationHeader = request.headers.authorization;
        const bearer = typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')
          ? authorizationHeader.slice('Bearer '.length) : '';
        let claims: { readonly sub?: unknown; readonly jti?: unknown } = {};
        try { claims = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString('utf8')) as typeof claims; }
        catch { claims = {}; }
        observedSnapshotRequests.push({ query: [...url.searchParams.keys()],
          querySessionId: url.searchParams.get('sessionId'),
          headerSessionId: request.headers['known-sync-session'] as string | undefined,
          credentialSubject: typeof claims.sub === 'string' ? claims.sub : null,
          credentialId: typeof claims.jti === 'string' ? claims.jti : null });
      }
    });
    registerSyncSessionRoutes(app, runtime.session);
    registerSyncSnapshotRoutes(app, runtime.snapshot);
    registerSyncPullRoutes(app, runtime.pull);
    registerSyncAckRoutes(app, runtime.ack);
    app.get('/.well-known/collection-protocol', async () => productionRecoveryManifest(app.server.address()));
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
      const origin = `http://127.0.0.1:${address.port}`;
      const client = createSyncSessionBlackBoxClient({ manifestUrl: `${origin}/.well-known/collection-protocol`,
        mountId: 'root', authorization, origin: originHeader });
      const request = await productionSessionRequest(isolated, fixture.replicaId);
      const initialSession = await client.create({ idempotencyKey: `initial-${randomUUID()}`, request });
      assert.equal(initialSession.body.collection.snapshotRequired, true);
      const initialSnapshot = await client.snapshot({ sessionId: initialSession.body.sessionId, limit: 100 });
      assert.match(initialSnapshot.syncCursor, /^spc2\./u);
      const initialAck = await client.ack({ idempotencyKey: `initial-ack-${randomUUID()}`,
        request: { sessionId: initialSession.body.sessionId, cursor: initialSnapshot.syncCursor, warnings: [] } });
      assert.equal(initialAck.status, 200);

      const handoffSession = await client.create({ idempotencyKey: `handoff-${randomUUID()}`, request });
      assert.equal(handoffSession.body.collection.snapshotRequired, false);
      assert.equal(handoffSession.body.collection.serverCursor, initialSnapshot.syncCursor);
      const historyIds = Array.from({ length: 13 }, (_, index) =>
        `production-recovery-history-${String(index + 1).padStart(2, '0')}`);
      for (const [index, operationId] of historyIds.entries()) {
        await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')",
          [operationId]);
        const type = index === 0 ? 'move_node' : index === historyIds.length - 1 ? 'delete_node' : 'create_node';
        await insertTestOperation(isolated.runtime.db, {
          operationId, collectionId: request.collection.collectionId,
          commitOrdinal: BigInt(90 + index), operationType: 'sync.node.update', payloadJson: {},
          actorPrincipalId: fixture.accountId,
          syncWireJson: { opId: operationId, replicaId: fixture.replicaId, sequence: 90 + index,
            collectionId: request.collection.collectionId, type,
            targetId: 'recovery-root-production-composition', baseRevision: 'root-r1',
            occurredAt: '2026-07-30T12:00:00.000Z', payload: {} },
        });
      }
      cursorNow += 2_000;
      await assert.rejects(client.pull({ sessionId: handoffSession.body.sessionId,
        cursor: initialSnapshot.syncCursor, limit: 100 }), /recovery_required|unexpected status/iu);

      const extensionResponse = await client.create({ idempotencyKey: `extension-recovery-${randomUUID()}`, request });
      const extensionSession = parseSyncSessionResult(extensionResponse.body, request,
        await credentialAuthorityDigest(authorization.slice('Bearer '.length)));
      assert.equal(extensionSession.replicaLease.state, 'active');
      assert.equal(classifySessionAuthority(extensionSession, {
        authorityRefreshRequired: true, bootstrapped: true,
      }), 'recovery');

      const recoverySession = await client.create({ idempotencyKey: `recovery-${randomUUID()}`, request });
      assert.equal(recoverySession.status, 201);
      assert.equal(recoverySession.body.collection.snapshotRequired, true);
      const beforeWrongSession = await isolated.runtime.db.selectFrom('sync_replicas')
        .select(['status', 'lease_generation', 'lifecycle_revision', 'checkpoint_cursor'])
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
      const wrongSession = await fetch(`${origin}/runtime/snapshot?sessionId=${encodeURIComponent(
        recoverySession.body.sessionId)}&limit=100`, { headers: { Accept: 'application/json',
        Authorization: authorization, Origin: originHeader, 'Known-Sync-Session': 'wrong-session' } });
      assert.equal(wrongSession.status, 400);
      assert.equal((await wrongSession.json() as { readonly code?: unknown }).code, 'invalid_cursor_scope');
      assert.deepEqual(await isolated.runtime.db.selectFrom('sync_replicas')
        .select(['status', 'lease_generation', 'lifecycle_revision', 'checkpoint_cursor'])
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow(), beforeWrongSession);
      const wrongQuery = await fetch(`${origin}/runtime/snapshot?sessionId=wrong-session&limit=100`, {
        headers: { Accept: 'application/json', Authorization: authorization, Origin: originHeader,
          'Known-Sync-Session': recoverySession.body.sessionId } });
      assert.equal(wrongQuery.status, 400);
      assert.equal((await wrongQuery.json() as { readonly code?: unknown }).code, 'invalid_cursor_scope');
      const wrongCredential = await fetch(`${origin}/runtime/snapshot?sessionId=${encodeURIComponent(
        recoverySession.body.sessionId)}&limit=100`, { headers: { Accept: 'application/json',
        Authorization: foreignCredential.authorization, Origin: originHeader,
        'Known-Sync-Session': recoverySession.body.sessionId } });
      assert.equal(wrongCredential.status, 404);
      assert.deepEqual(await isolated.runtime.db.selectFrom('sync_replicas')
        .select(['status', 'lease_generation', 'lifecycle_revision', 'checkpoint_cursor'])
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow(), beforeWrongSession);
      const snapshot = await client.snapshot({ sessionId: recoverySession.body.sessionId, limit: 100 });
      assert.match(snapshot.syncCursor, /^spc2\./u);
      assert.match(snapshot.recoveryCapability, /^src1\./u);
      const stagedSnapshot = await isolated.runtime.db.selectFrom('sync_bootstrap_snapshots')
        .select(['bootstrap_cursor']).where('session_id', '=', recoverySession.body.sessionId)
        .executeTakeFirstOrThrow();
      const sessionAuthority = await isolated.runtime.db.selectFrom('sync_sessions')
        .select(['principal_subject_id', 'credential_id']).where('session_id', '=', recoverySession.body.sessionId)
        .executeTakeFirstOrThrow();
      assert.deepEqual(observedSnapshotRequests.at(-1), { query: ['sessionId', 'limit'],
        querySessionId: recoverySession.body.sessionId, headerSessionId: recoverySession.body.sessionId,
        credentialSubject: fixture.credential.subject, credentialId: sessionAuthority.credential_id });
      const recoveryAckKey = `recovery-ack-${randomUUID()}`;
      const recoveryRequest = { sessionId: recoverySession.body.sessionId,
        cursor: snapshot.syncCursor, recoveryCapability: snapshot.recoveryCapability, warnings: [] };
      const [recoveryAck, exactReplay] = await Promise.all([
        client.ack({ idempotencyKey: recoveryAckKey, request: recoveryRequest }),
        client.ack({ idempotencyKey: recoveryAckKey, request: recoveryRequest }),
      ]);
      assert.equal(recoveryAck.status, 200);
      assert.deepEqual(exactReplay.body, recoveryAck.body);
      const recoveredCheckpoint = await isolated.runtime.db.selectFrom('sync_replicas')
        .select(['checkpoint_cursor', 'checkpoint_commit_ordinal', 'checkpoint_stream_kind', 'checkpoint_stable_id'])
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
      assert.equal(recoveredCheckpoint.checkpoint_cursor, stagedSnapshot.bootstrap_cursor);
      assert.deepEqual({ commitOrdinal: BigInt(recoveredCheckpoint.checkpoint_commit_ordinal!).toString(),
        streamKind: recoveredCheckpoint.checkpoint_stream_kind, stableId: recoveredCheckpoint.checkpoint_stable_id },
      { commitOrdinal: '102', streamKind: 0, stableId: historyIds.at(-1) });

      const activeSession = await client.create({ idempotencyKey: `active-${randomUUID()}`, request });
      assert.equal(activeSession.body.collection.snapshotRequired, false);
      assert.equal(activeSession.body.collection.serverCursor, snapshot.syncCursor);
      assert.match(activeSession.body.collection.serverCursor, /^spc2\./u);
      const activeEvidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence')
        .select(['tuple_commit_ordinal', 'tuple_stream_kind', 'tuple_stable_id'])
        .where('replica_id', '=', fixture.replicaId)
        .where('cursor', '=', activeSession.body.collection.serverCursor).executeTakeFirstOrThrow();
      assert.deepEqual({ commitOrdinal: BigInt(activeEvidence.tuple_commit_ordinal).toString(),
        streamKind: activeEvidence.tuple_stream_kind, stableId: activeEvidence.tuple_stable_id },
      { commitOrdinal: '102', streamKind: 0, stableId: historyIds.at(-1) });
      const activePull = await client.pull({ sessionId: activeSession.body.sessionId,
        cursor: activeSession.body.collection.serverCursor, limit: 100 });
      assert.equal(activePull.events.length, 0);
      assert.equal(activePull.recommendedPullAfterSeconds, 10,
        'production composition must surface the configured pull pacing interval');
      assert.match(activePull.nextCursor, /^spc2\./u);
      assert.notEqual(activePull.nextCursor, activeSession.body.collection.serverCursor);
      const activePullAck = await client.ack({ idempotencyKey: `active-pull-ack-${randomUUID()}`,
        request: { sessionId: activeSession.body.sessionId, cursor: activePull.nextCursor, warnings: [] } });
      assert.equal(activePullAck.status, 200);
      const reboundCheckpoint = await isolated.runtime.db.selectFrom('sync_replicas')
        .select('checkpoint_cursor').where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
      assert.equal(reboundCheckpoint.checkpoint_cursor, activePull.nextCursor);
      const authorityRows = await isolated.runtime.pool.query(`select s.session_id,s.account_id,s.collection_id,
          s.replica_id,s.lease_generation::text,s.lifecycle_revision::text,s.policy_revision,s.protocol_version,
          s.expires_at,r.status as replica_status,r.checkpoint_cursor,e.page_limit,e.cursor_expires_at
        from sync_sessions s join sync_replicas r on r.replica_id=s.replica_id
        join sync_pull_cursor_evidence e on e.replica_id=r.replica_id and e.cursor=r.checkpoint_cursor
        where s.session_id=$1`, [activeSession.body.sessionId]);
      assert.deepEqual(authorityRows.rows.map((row) => ({
        accountId: row.account_id, collectionId: row.collection_id, replicaId: row.replica_id,
        sessionId: row.session_id, generation: row.lease_generation,
        lifecycleRevision: row.lifecycle_revision, policyRevision: row.policy_revision,
        protocolVersion: row.protocol_version, replicaState: row.replica_status,
        pageLimit: row.page_limit, sessionExpires: row.expires_at > new Date(),
        cursorExpires: row.cursor_expires_at > new Date(),
        cursorDigest: createHash('sha256').update(row.checkpoint_cursor).digest('hex'),
      })), [{ accountId: fixture.accountId,
        collectionId: request.collection.collectionId, replicaId: fixture.replicaId,
        sessionId: activeSession.body.sessionId, generation: activeSession.body.replicaLease.generation,
        lifecycleRevision: '6', policyRevision: authorityRows.rows[0]?.policy_revision,
        protocolVersion: '0.2', replicaState: 'active', pageLimit: 100,
        sessionExpires: true, cursorExpires: true,
        cursorDigest: createHash('sha256').update(activePull.nextCursor).digest('hex') }]);
      await assert.rejects(client.pull({ sessionId: activeSession.body.sessionId,
        cursor: initialSnapshot.syncCursor, limit: 100 }), /invalid_cursor_scope|unexpected status 400/iu);
      await assert.rejects(client.pull({ sessionId: activeSession.body.sessionId,
        cursor: activeSession.body.collection.serverCursor, limit: 99 }), /invalid_cursor_scope|unexpected status 400/iu);

      const facts = await isolated.runtime.pool.query(`select replica.status,replica.lease_generation::text,
          replica.checkpoint_cursor,replica.lifecycle_revision::text,
          (select count(*)::int from sync_recovery_ack_receipts receipt where receipt.replica_id=replica.replica_id) as receipts,
          (select count(*)::int from audit_events audit join audit_event_payloads payload
            on payload.event_id=audit.id where audit.event_type='sync.replica.snapshot_recovered'
            and payload.details_json->>'replicaId'=replica.replica_id) as audits,
          (select count(*)::int from sync_pull_cursor_recovery_proofs proof
            where proof.replica_id=replica.replica_id and proof.consumed_at is null) as live_proofs,
          (select count(*)::int from sync_pull_cursor_evidence evidence
            where evidence.replica_id=replica.replica_id and evidence.cursor is not null) as raw_evidence
        from sync_replicas replica where replica.replica_id=$1`, [fixture.replicaId]);
      assert.deepEqual(facts.rows[0], { status: 'active', lease_generation: '2',
        checkpoint_cursor: activePull.nextCursor, lifecycle_revision: '6',
        receipts: 1, audits: 1, live_proofs: 1, raw_evidence: 2 });
      assert.equal(JSON.stringify(facts.rows[0]).includes(snapshot.syncCursor), false);
      const beforeReplay = structuredClone(facts.rows[0]);
      const stale = await client.ack({ idempotencyKey: `stale-recovery-${randomUUID()}`,
        request: { sessionId: recoverySession.body.sessionId, cursor: snapshot.syncCursor,
          recoveryCapability: snapshot.recoveryCapability, warnings: [] } });
      assert.equal(stale.status, 410);
      const afterReplay = await isolated.runtime.pool.query(`select status,lease_generation::text,
        checkpoint_cursor,lifecycle_revision::text from sync_replicas where replica_id=$1`, [fixture.replicaId]);
      assert.deepEqual(afterReplay.rows[0], { status: beforeReplay.status,
        lease_generation: beforeReplay.lease_generation, checkpoint_cursor: beforeReplay.checkpoint_cursor,
        lifecycle_revision: beforeReplay.lifecycle_revision });
    } finally { runtime.destroy(); await app.close(); }
  }, 20_000);

  test('serves 410 + snapshot recovery for a provably old cursor through signed lineage after cleanup and key rotation', async () => {
    // FIX-L-035: a long-offline cursor whose evidence and recovery proof were both
    // cleaned, and whose signing key was rotated out, must still be distinguishable
    // from a random/tampered cursor: provably old cursors get 410 + snapshot recovery,
    // while random or bit-tampered cursors keep the 400 invalid_cursor_scope contract.
    const fixture = await seedRecoveryFixture(isolated, 'lineage-expiry');
    let cursorNow = Date.now();
    const cursorKeysV1 = createSyncPullCursorKeyring({ active: { id: 'lineage-pull-v1',
      secret: Buffer.alloc(32, 90).toString('base64') }, retained: [], ttlMs: 500,
      now: () => cursorNow });
    const lineageKeys = createSyncPullCursorLineageKeyring({ active: { id: 'lineage-key-v1',
      secret: Buffer.alloc(32, 89).toString('base64') }, retained: [] });
    const portOptions = { recoveryProofRetentionMs: 1_000, lineageKeyring: lineageKeys,
      lineageRetentionMs: 120_000, cursorNow: () => cursorNow };
    let currentReader = createPostgresSyncPullReadPort(isolated.runtime.db, cursorKeysV1, portOptions);
    const reader: SyncPullReadPort = { async read(input) { return currentReader.read(input); } };
    const app = Fastify({ logger: false });
    const originHeader = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const authorization = `Bearer lineage-expiry-${fixture.replicaId}`;
    const verifier = { async verify({ authorization: supplied }: { readonly authorization: string | readonly string[] | undefined }) {
      if (supplied !== authorization) throw new Error('denied'); return fixture.credential;
    } };
    registerSyncPullRoutes(app, { path: '/runtime/pull', credentialVerifier: verifier, reader,
      allowedOrigins: [originHeader], rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 200,
      responseBudgetBytes: 1_048_576, requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 10,
      snapshotUrl: 'https://snapshot.example/runtime/snapshot', allowInsecureLoopback: true });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
      const origin = `http://127.0.0.1:${address.port}`;
      const headers = { Accept: 'application/json', Authorization: authorization, Origin: originHeader,
        'Known-Sync-Session': fixture.sessionId };
      const pull = async (cursor: string | null) => fetch(`${origin}/runtime/pull?sessionId=${
        encodeURIComponent(fixture.sessionId)}&limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      { headers });
      const first = await pull(null);
      assert.equal(first.status, 200);
      const body = await first.json() as { readonly nextCursor: string;
        readonly recommendedPullAfterSeconds: number };
      assert.equal(body.recommendedPullAfterSeconds, 10,
        'the Pull response must surface the configured pacing interval');
      const issuedCursor = body.nextCursor;
      assert.match(issuedCursor, /^spc2\./u);
      const digest = createHash('sha256').update(issuedCursor, 'utf8').digest('hex');
      const lineageRow = await isolated.runtime.db.selectFrom('sync_pull_cursor_lineage').selectAll()
        .where('replica_id', '=', fixture.replicaId).where('cursor_digest', '=', digest)
        .executeTakeFirstOrThrow();
      assert.equal(lineageRow.receipt.startsWith('spl1.'), true);
      assert.equal(lineageRow.key_version, 'lineage-key-v1');
      assert.ok(lineageRow.lineage_expires_at.getTime() > lineageRow.cursor_expires_at.getTime(),
        'the signed lineage must outlive the cursor expiry it proves');

      // Random and bit-tampered cursors keep the 400 invalid_cursor_scope contract.
      const random = await pull('spc2.forged-cursor-not-issued');
      assert.equal(random.status, 400);
      assert.equal((await random.json() as { readonly code?: unknown }).code, 'invalid_cursor_scope');
      const tampered = `${issuedCursor.slice(0, -1)}${issuedCursor.endsWith('A') ? 'B' : 'A'}`;
      const tamperedResponse = await pull(tampered);
      assert.equal(tamperedResponse.status, 400);
      assert.equal((await tamperedResponse.json() as { readonly code?: unknown }).code, 'invalid_cursor_scope');
      assert.equal(await isolated.runtime.db.selectFrom('sync_replicas').select('status')
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow().then((row) => row.status),
      'active', 'a 400 must never transition the replica');

      // Let the cursor and its recovery proof actually expire while the lineage
      // survives, then rotate the cursor signing key out so only the signed lineage
      // can authenticate the cursor. The evidence/proof cleanup runs against the
      // database clock, so wait on the DB clock past both retention windows instead
      // of sleeping a fixed interval (deterministic under load).
      const evidenceExpiry = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').select('cursor_expires_at')
        .where('replica_id', '=', fixture.replicaId).where('cursor_digest', '=', digest)
        .executeTakeFirstOrThrow().then((row) => row.cursor_expires_at);
      const proofExpiry = await isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs').select('proof_expires_at')
        .where('replica_id', '=', fixture.replicaId).where('cursor_digest', '=', digest)
        .executeTakeFirstOrThrow().then((row) => row.proof_expires_at);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const check = await isolated.runtime.pool.query<{ ready: boolean }>(
          `select (clock_timestamp() > greatest($1::timestamptz, $2::timestamptz)
             + interval '250 milliseconds') as ready`, [evidenceExpiry, proofExpiry]);
        if (check.rows[0]?.ready) break;
        if (Date.now() > deadline) throw new Error('cursor evidence and recovery proof retention windows did not elapse in time');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await new PostgresSyncEvidenceMaintenanceCoordinator(isolated.runtime.db, {
        workerId: 'q011-lineage-expiry', batchSize: 100, leaseDurationMs: 30_000,
      }).runBatch();
      cursorNow += 61_000;
      currentReader = createPostgresSyncPullReadPort(isolated.runtime.db,
        createSyncPullCursorKeyring({ active: { id: 'lineage-pull-v2',
          secret: Buffer.alloc(32, 99).toString('base64') }, retained: [], ttlMs: 500,
          now: () => cursorNow }), portOptions);
      const expired = await pull(issuedCursor);
      assert.equal(expired.status, 410);
      const problem = await expired.json() as { readonly code?: unknown; readonly snapshotUrl?: unknown };
      assert.equal(problem.code, 'stale_replica');
      assert.equal(problem.snapshotUrl, 'https://snapshot.example/runtime/snapshot',
        'the 410 must carry the snapshot recovery guidance');
      const replica = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
      assert.equal(replica.status, 'recovery_required');
      assert.equal(await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence')
        .where('replica_id', '=', fixture.replicaId).where('cursor_digest', '=', digest).execute()
        .then((rows) => rows.length), 0, 'expired evidence must be cleaned');
      assert.equal(await isolated.runtime.db.selectFrom('sync_pull_cursor_recovery_proofs')
        .where('replica_id', '=', fixture.replicaId).where('cursor_digest', '=', digest).execute()
        .then((rows) => rows.length), 0, 'expired recovery proofs must be cleaned');
      assert.equal(await isolated.runtime.db.selectFrom('sync_pull_cursor_lineage')
        .where('replica_id', '=', fixture.replicaId).where('cursor_digest', '=', digest).execute()
        .then((rows) => rows.length), 1, 'the signed lineage must survive for the provably old cursor');
    } finally { await app.close(); }
  }, 20_000);

  test('materializes versioned paged storage and serves every frozen page through bounded reads', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'v2-paged', undefined, false, undefined, '0.1', 250);
    const snapshotApplication = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      recovery: fixture.application,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const instrumented = instrumentSnapshotNodeReads(isolated.runtime.pool);
    try {
      const first = await snapshotApplication.query({ credential: fixture.credential,
        request: { sessionId: fixture.sessionId, limit: 100 } });
      assert.equal(first.nodes.length, 100, 'materialise path serves the first page');
      assert.equal(instrumented.reads(), 0, 'a fresh materialise must not re-read its own node rows');
      const row = await isolated.runtime.pool.query<{ storage_version: number; node_count: number | null }>(
        `select storage_version,node_count from sync_bootstrap_snapshots where snapshot_id=$1`,
        [first.snapshotId]);
      assert.equal(row.rowCount, 1);
      assert.equal(row.rows[0]!.storage_version, 2);
      assert.equal(row.rows[0]!.node_count, 250);
      const nodeRows = await isolated.runtime.pool.query<{ count: number; lo: number; hi: number }>(
        `select count(*)::int as count,min(node_index)::int as lo,max(node_index)::int as hi
         from sync_bootstrap_snapshot_nodes where snapshot_id=$1`, [first.snapshotId]);
      assert.deepEqual(nodeRows.rows[0], { count: 250, lo: 0, hi: 249 });

      const pages: Array<Snapshot | SyncSnapshotV02> = [first];
      let pageCursor = first.page.nextCursor ?? undefined;
      while (pageCursor) {
        instrumented.reset();
        const offset = pages.length * 100;
        const page = await snapshotApplication.query({ credential: fixture.credential,
          request: { sessionId: fixture.sessionId, limit: 100, pageCursor } });
        assert.equal(instrumented.reads(), Math.min(101, 250 - offset),
          `page ${page.page.sequence} read exactly its bounded node rows`);
        pages.push(page);
        pageCursor = page.page.nextCursor ?? undefined;
      }
      assert.deepEqual(pages.map((page) => page.page.sequence), [1, 2, 3]);
      assert.equal(pages.flatMap((page) => page.nodes).length, 250);
      assert.equal(assembleSnapshotPages(pages as Snapshot[]).valid, true);
      assert.equal(pages.every((page) => page.syncCursor === first.syncCursor), true);
    } finally {
      instrumented.restore();
    }
  }, 20_000);

  test('keeps versioned reads of an in-progress legacy v1 Snapshot until it expires', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'v1-versioned', undefined, true);
    const snapshotApplication = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const pages: Array<Snapshot | SyncSnapshotV02> = [];
    let pageCursor: string | undefined;
    do {
      const page = await snapshotApplication.query({ credential: fixture.credential,
        request: { sessionId: fixture.sessionId, limit: 100, ...(pageCursor ? { pageCursor } : {}) } });
      pages.push(page);
      pageCursor = page.page.nextCursor ?? undefined;
    } while (pageCursor);
    assert.deepEqual(pages.map((page) => page.page.sequence), [1, 2, 3, 4, 5]);
    assert.equal(pages.flatMap((page) => page.nodes).length, 401);
    assert.equal(pages[0]!.nodes[1]!.title, 'Bookmark 0',
      'the frozen legacy document is served, not a rebuild from live nodes');
    assert.equal(pages.at(-1)!.nodes.length, 1);
    const row = await isolated.runtime.pool.query<{ storage_version: number }>(
      `select storage_version from sync_bootstrap_snapshots where snapshot_id=$1`, [fixture.snapshotId]);
    assert.equal(row.rows[0]!.storage_version, 1, 'the legacy row is read but never rewritten');
    const nodeRows = await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int as count from sync_bootstrap_snapshot_nodes where snapshot_id=$1`, [fixture.snapshotId]);
    assert.equal(nodeRows.rows[0]!.count, 0, 'no v2 node rows are fabricated for a v1 Snapshot');
    assert.equal(assembleSnapshotPages(pages as Snapshot[]).valid, true);
  }, 20_000);

  test('fails closed on Snapshot node and byte caps with zero durable rows', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'snapshot-caps', undefined, false, undefined, '0.1', 60);
    const nodeCapped = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      maxSnapshotNodes: 50, attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    await assert.rejects(nodeCapped.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } }),
    (error: unknown) => error instanceof SyncBootstrapSnapshotError && error.code === 'payload_too_large');
    const byteCapped = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      maxSnapshotNodes: 10_000, maxSnapshotBytes: 512,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    await assert.rejects(byteCapped.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } }),
    (error: unknown) => error instanceof SyncBootstrapSnapshotError && error.code === 'payload_too_large');
    const rows = await isolated.runtime.pool.query('select 1 from sync_bootstrap_snapshots where session_id=$1',
      [fixture.sessionId]);
    assert.equal(rows.rowCount, 0, 'a capped materialisation must not persist a Snapshot');
  }, 20_000);

  test('cleanup deletes expired unreferenced Snapshots with their node rows and replaces them on demand', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'snapshot-cleanup', undefined, false);
    const shortLived = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 250,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const first = await shortLived.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } });
    assert.equal(first.nodes.length, 1);
    assert.equal(first.page.nextCursor, null);
    // Wait on the DB clock until the short-lived Snapshot row is actually
    // expired instead of sleeping a fixed interval (deterministic under load).
    const waitForExpiry = async (snapshotId: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const check = await isolated.runtime.pool.query<{ expired: boolean }>(
          `select (expires_at <= current_timestamp) as expired
             from sync_bootstrap_snapshots where snapshot_id=$1`, [snapshotId]);
        if (check.rows[0]?.expired) return;
        if (Date.now() > deadline) throw new Error('short-lived Snapshot did not expire in time');
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    await waitForExpiry(first.snapshotId);
    const second = await shortLived.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } });
    assert.equal(second.snapshotId, first.snapshotId);
    const rows = await isolated.runtime.pool.query<{ storage_version: number }>(
      `select storage_version from sync_bootstrap_snapshots where snapshot_id=$1`, [first.snapshotId]);
    assert.equal(rows.rowCount, 1, 'the expired row must be replaced, not duplicated');
    assert.equal(rows.rows[0]!.storage_version, 2);
    const nodeRows = await isolated.runtime.pool.query<{ count: number }>(
      `select count(*)::int as count from sync_bootstrap_snapshot_nodes where snapshot_id=$1`, [first.snapshotId]);
    assert.equal(nodeRows.rows[0]!.count, 1, 'node rows are recreated for the replacement Snapshot');
  }, 20_000);

  test('cleanup never removes an expired Snapshot that still carries recovery evidence', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'cleanup-protected', undefined, false);
    const protectedId = `cleanup-protected-snapshot-${randomUUID()}`;
    const root = await isolated.runtime.pool.query<{ root_node_id: string }>(
      `select root_node_id from collections where id=$1`, [fixture.collectionId]);
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'sync_bootstrap_snapshot')`, [protectedId]);
    await isolated.runtime.pool.query(`insert into sync_bootstrap_snapshots(snapshot_id,session_id,account_id,collection_id,replica_id,
        lease_generation,policy_revision,content_revision,binding_mode,binding_root_node_id,snapshot_json,
        bootstrap_cursor,cursor_key_id,generated_at,expires_at)
      values ($1,$2,$3,$4,$5,$6,'policy-r1','protected-c1','whole-profile',$7,'{}'::jsonb,'protected-cursor','snapshot-v1',
        current_timestamp - interval '5 minutes',current_timestamp - interval '1 minute')`,
    [protectedId, fixture.sessionId, fixture.accountId, fixture.collectionId, fixture.replicaId,
      BigInt(fixture.oldGeneration), root.rows[0]!.root_node_id]);
    await isolated.runtime.pool.query(`insert into sync_bootstrap_snapshot_pages(snapshot_id,session_id,replica_id,old_lease_generation,
        page_sequence,page_start_offset,page_end_offset,complete,response_digest)
      values ($1,$2,$3,$4,1,0,1,true,'cleanup-protected-page')`,
    [protectedId, fixture.sessionId, fixture.replicaId, BigInt(fixture.oldGeneration)]);
    const snapshotApplication = createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), cursorKeyId: 'snapshot-v1', cursorTtlMs: 300_000,
      attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    });
    const snapshot = await snapshotApplication.query({ credential: fixture.credential,
      request: { sessionId: fixture.sessionId, limit: 100 } });
    assert.equal(snapshot.nodes.length, 1);
    const still = await isolated.runtime.pool.query('select 1 from sync_bootstrap_snapshots where snapshot_id=$1',
      [protectedId]);
    assert.equal(still.rowCount, 1, 'evidence-protected expired Snapshots must survive cleanup');
  }, 20_000);

  test('two recovery Acks and retire port race with at most one legal winner', async () => {
    const fixture = await seedRecoveryFixture(isolated, 'race');
    await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
      sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
    await fixture.recordAllPages();
    const capability = await fixture.application.issueCapability({ credential: fixture.credential,
      sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
    const ordinaryAck = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    const outcomes = await Promise.allSettled([
      fixture.application.bootstrapAcknowledge({ credential: fixture.credential, idempotencyKey: 'race-a',
        sessionId: fixture.sessionId, capability, requestFingerprint: 'race-a' }),
      fixture.application.bootstrapAcknowledge({ credential: fixture.credential, idempotencyKey: 'race-b',
        sessionId: fixture.sessionId, capability, requestFingerprint: 'race-b' }),
      fixture.retire(),
      ordinaryAck.acknowledge({ credential: fixture.credential, idempotencyKey: 'race-ordinary',
        requestFingerprint: 'race-ordinary', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        mediaType: 'application/json', endpointIdentity: '/runtime/ack', request: {
          sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary, warnings: [],
        } }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const status = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow();
    assert.ok(status.status === 'active' || status.status === 'retired');
  });

  for (const phase of ['capability', 'snapshot_evidence', 'generation', 'checkpoint', 'receipt', 'audit',
    'commit_outcome'] as const satisfies readonly SyncRecoveryFaultPhase[]) {
    test(`rolls back or exact-replays crash at ${phase}`, async () => {
      const fixture = await seedRecoveryFixture(isolated, `fault-${phase}`, phase);
      await fixture.application.requireRecoveryForStaleCursor({ credential: fixture.credential,
        sessionId: fixture.sessionId, cursor: fixture.cursorBeforeBoundary });
      await fixture.recordAllPages();
      const capability = await fixture.application.issueCapability({ credential: fixture.credential,
        sessionId: fixture.sessionId, snapshotId: fixture.snapshotId });
      const request = { credential: fixture.credential, idempotencyKey: `fault-${phase}`,
        sessionId: fixture.sessionId, capability, requestFingerprint: `fault-${phase}` };
      await assert.rejects(fixture.application.bootstrapAcknowledge(request));
      const restarted = createPostgresSyncRecoveryApplication(isolated.runtime.db, fixture.optionsWithoutFault);
      if (phase === 'commit_outcome') assert.deepEqual(await restarted.bootstrapAcknowledge(request),
        await restarted.bootstrapAcknowledge(request));
      else assert.equal((await isolated.runtime.db.selectFrom('sync_replicas').select('status')
        .where('replica_id', '=', fixture.replicaId).executeTakeFirstOrThrow()).status, 'recovery_required');
    });
  }
});

function recoveryManifest(address: AddressInfo | string | null): Manifest {
  if (!address || typeof address === 'string') throw new Error('not listening');
  const origin = `http://127.0.0.1:${address.port}`;
  return { protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019f9d33-2424-7242-8242-242424242424', title: 'Known', mounts: [{
      id: 'root', baseUrl: `${origin}/`, profiles: ['core'], endpoints: { directory: `${origin}/directory`,
        collection: `${origin}/collections/{collectionId}`, snapshot: `${origin}/collections/{collectionId}/snapshot`,
        syncSnapshot: `${origin}/runtime/snapshot`, syncPull: `${origin}/runtime/pull`,
        syncAck: `${origin}/runtime/ack` }, features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 200, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 },
    }] } as Manifest;
}

function productionRecoveryManifest(address: AddressInfo | string | null): Manifest {
  const manifest = recoveryManifest(address); const origin = new URL(manifest.serverId).origin;
  return { ...manifest, mounts: manifest.mounts.map((mount) => ({ ...mount, endpoints: { ...mount.endpoints,
    syncSessions: `${origin}/runtime/session`, syncSnapshot: `${origin}/runtime/snapshot`,
    syncPull: `${origin}/runtime/pull`, syncAck: `${origin}/runtime/ack` } })) } as Manifest;
}

function productionSyncConfig(origin: string): SyncSessionConfig {
  const rateLimit = { maxRequests: 1_000, windowMs: 60_000 };
  return {
    path: '/runtime/session', allowedOrigins: [origin],
    extensionAuth: { flow: 'authorization_code_pkce', issuer: 'https://issuer.example',
      audience: 'known-api', clientId: 'known-extension', authorizationEndpoint: 'https://issuer.example/authorize',
      tokenEndpoint: 'https://issuer.example/token', jwksUri: 'https://issuer.example/.well-known/jwks.json',
      redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
      allowedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
      allowedRedirectOrigins: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org'],
      scopes: ['known.sync'], allowedAlgorithms: ['RS256'], clockSkewSeconds: 30, evidenceTtlSeconds: 300 },
    replayEncryptionKey: Buffer.alloc(32, 91), replayEncryptionKeyVersion: 1,
    // FIX-M-011 requires the active/retained Conflict payload keyring in the Session config.
    conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 95), keyVersion: 1 }, retained: [] },
    sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600, tombstoneRetentionSeconds: 86_400,
    rateLimit, apiInstanceCount: 1 as const, allowInsecureLoopback: true,
    snapshot: { path: '/runtime/snapshot', cursorKeyId: 'snapshot-v1', cursorSecret: Buffer.alloc(32, 93),
      cursorTtlMs: 300_000, maxBytes: 2_097_152, rateLimit },
    push: { path: '/runtime/push', maxBatchOperations: 1 as const, managedBookmarkWrites: false, rateLimit },
    conflict: { path: '/runtime/conflict/{conflictId}', rateLimit },
    pull: { path: '/runtime/pull', cursorKeys: { active: { id: 'pull-v1',
      secret: Buffer.alloc(32, 94).toString('base64') }, retained: [] }, cursorTtlMs: 1_000,
      recoveryProofRetentionMs: 60_000, lineageKeys: { active: { id: 'lineage-v1',
        secret: Buffer.alloc(32, 88).toString('base64') }, retained: [] }, lineageRetentionMs: 120_000,
      maxLimit: 200, responseBudgetBytes: 1_048_576,
      requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 10, rateLimit,
      effectPagePath: '/runtime/pull-effects/{effectId}',
      effectPageRateLimit: { subjectMaxRequests: 1_000, effectMaxRequests: 1_000,
        ipMaxRequests: 1_000, windowMs: 60_000 } },
    ack: { path: '/runtime/ack', leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
      maxBodyBytes: 16_384, maxWarnings: 8, maxWarningBytes: 2_048, rateLimit,
      recoveryCapabilityKeys: { active: { id: 'recovery-v1',
        secret: Buffer.alloc(32, 92).toString('base64') }, retained: [] }, recoveryCapabilityTtlMs: 300_000 },
    retire: { path: '/runtime/retire', rateLimit },
  };
}

async function productionSessionRequest(isolated: IsolatedPostgresRuntime,
  replicaId: string): Promise<SyncSessionRequestV02> {
  const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
    .where('replica_id', '=', replicaId).executeTakeFirstOrThrow();
  return { protocolVersion: '0.2', scope: 'collection', clientTime: new Date().toISOString(), replica: {
    replicaId, name: replica.replica_name, kind: replica.kind,
    adapter: { profile: replica.adapter_profile, version: replica.adapter_version },
    capabilities: { read: true, write: true, events: true, separator: false,
      alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
    binding: { browserProfileId: replica.browser_profile_id, mountMode: replica.binding_mode,
      mountNativeId: 'production-composition-root', generation: replica.browser_generation }, extensions: {},
  }, collection: { collectionId: replica.collection_id, lastCursor: replica.checkpoint_cursor,
    lastRevision: null, bootstrapMode: 'download' } };
}

/** Counts `sync_bootstrap_snapshot_nodes` rows read by the Snapshot application under test. */
function instrumentSnapshotNodeReads(pool: { connect(): Promise<PoolClient> }): {
  reads(): number; reset(): void; restore(): void;
} {
  const original = pool.connect.bind(pool);
  let reads = 0;
  // Pooled clients keep the counting wrapper after release, so a later
  // acquisition must not stack another wrapper layer (each layer would count
  // the same query again). Track per-instance wrapped clients to stay
  // idempotent; a client wrapped by an earlier instrumentation instance is
  // still wrapped once more here, so each instance counts exactly its own
  // window of queries.
  const wrappedClients = new WeakSet<PoolClient>();
  const wrapClient = (client: PoolClient): PoolClient => {
    if (wrappedClients.has(client)) return client;
    wrappedClients.add(client);
    const originalQuery = client.query.bind(client);
    const query = originalQuery as unknown as (text: string, values?: unknown,
      callback?: (error: Error | undefined, result: { rows: readonly unknown[] }) => void)
      => Promise<{ rows: readonly unknown[] }> | undefined;
    const counts = (text: unknown, result: { rows: readonly unknown[] }): void => {
      if (typeof text === 'string' && text.includes('sync_bootstrap_snapshot_nodes')) {
        reads += result.rows.length;
      }
    };
    client.query = ((text: unknown, values?: unknown,
      callback?: (error: Error | undefined, result: { rows: readonly unknown[] }) => void) => {
      if (typeof callback === 'function') {
        return query(text as string, values, (error: Error | undefined, result: { rows: readonly unknown[] }) => {
          if (!error) counts(text, result);
          return callback(error, result);
        });
      }
      const pending = query(text as string, values);
      if (pending) void Promise.resolve(pending).then((resolved) => counts(text, resolved));
      return pending;
    }) as unknown as typeof client.query;
    return client;
  };
  // pg-pool invokes connect() both as a promise (`await pool.connect()`) and
  // with a callback (`pool.query` internally uses `this.connect(cb)`); an
  // async-only wrapper leaves the callback form pending forever, so both
  // shapes must be forwarded.
  const wrapped = ((callback?: (error: Error | undefined, client?: PoolClient,
    done?: (error?: Error) => void) => void) => {
    if (callback) {
      return original((error: Error | undefined, client?: PoolClient,
        done?: (error?: Error) => void) => {
        if (error || !client || !done) return callback(error, client, done);
        return callback(undefined, wrapClient(client), done);
      });
    }
    return original().then((client) => wrapClient(client));
  }) as unknown as typeof pool.connect;
  pool.connect = wrapped;
  return {
    reads: () => reads,
    reset: () => { reads = 0; },
    restore: () => { pool.connect = original; },
  };
}
