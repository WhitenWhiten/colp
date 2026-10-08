import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { Operation, SyncAckResult } from '@know-n/colp/types';
import { sql } from 'kysely';
import {
  createPostgresReplicaStore,
  createPostgresReplicaRetirementApplication,
  createPostgresSyncAckApplication,
  createPostgresSyncPullReadPort,
  createPostgresSyncSessionIssuer,
  createSyncPullCursorKeyring,
} from '../../../src/infrastructure/sync/index.js';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import { SyncAckError, SyncPullReadError } from '../../../src/modules/sync/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ACCOUNT = 'ack-account';
const SUBJECT = 'ack-subject';
const COLLECTION = 'ack-collection';

describeWithPostgres('P3-22 PostgreSQL monotonic Sync Ack', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sync_ack', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('ack-identity',$1,$2,'ack-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into profile_handles(handle,account_id) values ('sync_ack',$1)", [ACCOUNT]);
      await client.query(`insert into resource_id_ledger(resource_id,resource_type) values
        ($1,'collection'),('ack-root','node')`, [COLLECTION]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'Ack collection','bookmarks','ack-root','collection-r1','content-r1','policy-r1')`,
      [COLLECTION, SUBJECT]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ('ack-root',$1,'folder',true,'Root','root-r1','children-r1')`, [COLLECTION]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }, 20_000);
  afterAll(async () => isolated?.close());

  test('migrates both an empty database and the P3-21 stable predecessor', async () => {
    const upgrade = await createIsolatedPostgresRuntime('p3_sync_ack_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const predecessor = await migrator.migrateTo('202607252200_sync_pull_stream');
      assert.equal(predecessor.error, undefined);
      const latest = await migrator.migrateToLatest();
      assert.equal(latest.error, undefined);
      const tables = await upgrade.runtime.pool.query<{ table_name: string }>(`select table_name
        from information_schema.tables where table_schema=current_schema()
          and table_name in ('sync_pull_cursor_evidence','sync_ack_receipts') order by table_name`);
      assert.deepEqual(tables.rows.map((row) => row.table_name),
        ['sync_ack_receipts', 'sync_pull_cursor_evidence']);
    } finally { await upgrade.close(); }
  }, 20_000);

  async function context(label = randomUUID(), protocolVersion: '0.1' | '0.2' = '0.1') {
    const credential = await mintVerifiedExtensionCredentialFixture({ issuer: ISSUER, audience: 'known-api',
      clientId: 'known-extension', subject: 'ack-oidc', credentialId: `ack-credential-${label}` });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `ack-device-${label}`, replicaId: () => `ack-replica-${label}`,
      leaseId: () => `ack-lease-${label}`,
    } }).create({ accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Ack device',
      replicaName: 'Ack replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `ack-profile-${label}`, mountMode: 'whole-profile',
        browserGeneration: `ack-generation-${label}` }, leaseDurationSeconds: 3_600 },
    { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, { issuer: ISSUER,
      audience: 'known-api', clientId: 'known-extension', replayEncryptionKey: Buffer.alloc(32, 51),
      replayEncryptionKeyVersion: 1, sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] });
    const issued = await issuer.issue({ credential, idempotencyKey: `ack-session-key-${label}`,
      requestFingerprint: `ack-session-fingerprint-${label}`, collectionId: COLLECTION,
      replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN, protocolVersion });
    const keyring = createSyncPullCursorKeyring({ active: { id: 'ack-pull-key', secret: Buffer.alloc(32, 61).toString('base64') },
      retained: [], ttlMs: 300_000 });
    const reader = createPostgresSyncPullReadPort(isolated.runtime.db, keyring);
    return { credential, replica, session: issued.session, keyring, reader, issuer };
  }

  async function addOperation(index: number): Promise<Operation> {
    const operation: Operation = { opId: `ack-operation-${index}`, replicaId: `source-replica-${index}`,
      sequence: index, collectionId: COLLECTION, type: 'update_node_content', targetId: 'ack-root',
      baseRevision: `root-r${index}`, occurredAt: '2026-07-26T10:00:00.000Z',
      payload: { base: { title: `Before ${index}` }, value: { title: `After ${index}` } } };
    await isolated.runtime.db.insertInto('resource_id_ledger').values({ resource_id: operation.opId,
      resource_type: 'operation' }).execute();
    await insertTestOperation(isolated.runtime.db, {
      operationId: operation.opId, collectionId: COLLECTION, commitOrdinal: BigInt(10_000 + index),
      operationType: operation.type, payloadJson: {},
      syncWireJson: operation as unknown as Record<string, unknown>,
      actorPrincipalId: ACCOUNT, createdAt: new Date('2026-07-26T10:00:00.000Z'),
    });
    return operation;
  }

  function input(value: Awaited<ReturnType<typeof context>>, cursor: string, idempotencyKey: string) {
    return { credential: value.credential, idempotencyKey, origin: ORIGIN,
      mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: value.session.sessionId, cursor, warnings: [] } } as const;
  }

  test('Pull persists immutable cursor evidence without advancing the checkpoint', async () => {
    const value = await context('pull-evidence');
    const page = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: null, limit: 10 });
    const retry = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: page.nextCursor, limit: 10 });
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').selectAll()
      .where('replica_id', '=', value.replica.replicaId).where('cursor', '=', page.nextCursor).execute();
    assert.equal(replica.checkpoint_cursor, null);
    assert.equal(retry.nextCursor, page.nextCursor);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.session_id, value.session.sessionId);
    assert.equal(BigInt(evidence[0]!.upper_commit_ordinal), 0n);
  });

  test('Ack accepts cursor evidence bound to a negotiated COLP 0.2 Session', async () => {
    const value = await context('protocol-v02', '0.2');
    const page = await value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 10 });
    const application = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    const result = await application.acknowledge(input(value, page.nextCursor, 'ack-protocol-v02'));
    assert.equal(result.ackedCursor, page.nextCursor);
  });

  test('rejects an arbitrary equal-tuple cursor without a Session handoff proof', async () => {
    const value = await context('equal-tuple-without-handoff-proof', '0.2');
    const page = await value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 10 });
    const application = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    await application.acknowledge(input(value, page.nextCursor, 'ack-equal-tuple-original'));
    const source = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').selectAll()
      .where('replica_id', '=', value.replica.replicaId).where('cursor', '=', page.nextCursor)
      .executeTakeFirstOrThrow();
    const arbitraryCursor = 'spc2.arbitrary-equal-tuple-cursor';
    await isolated.runtime.db.insertInto('sync_pull_cursor_evidence').values({
      cursor: arbitraryCursor,
      cursor_digest: createHash('sha256').update(arbitraryCursor, 'utf8').digest('hex'),
      session_id: source.session_id, account_id: source.account_id, collection_id: source.collection_id,
      replica_id: source.replica_id, lease_generation: source.lease_generation,
      policy_revision: source.policy_revision, protocol_version: source.protocol_version,
      tuple_commit_ordinal: source.tuple_commit_ordinal, tuple_stream_kind: source.tuple_stream_kind,
      tuple_stable_id: source.tuple_stable_id, cursor_expires_at: source.cursor_expires_at,
      upper_commit_ordinal: source.upper_commit_ordinal, upper_stream_kind: source.upper_stream_kind,
      upper_stable_id: source.upper_stable_id, collection_revision: source.collection_revision,
      page_limit: source.page_limit, purge_commit_ordinal: source.purge_commit_ordinal,
      purge_stream_kind: source.purge_stream_kind, purge_stable_id: source.purge_stable_id,
    }).execute();
    await assert.rejects(application.acknowledge(input(value, arbitraryCursor, 'ack-equal-tuple-arbitrary')),
      (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica');
    const checkpoint = await isolated.runtime.db.selectFrom('sync_replicas').select('checkpoint_cursor')
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(checkpoint.checkpoint_cursor, page.nextCursor);
  });

  test('denies a dead-Session Ack permanently and accepts the cross-Session reissued cursor instead', async () => {
    const value = await context('dead-session-handoff', '0.2');
    const page = await value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 10 });
    const application = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    // The Ack commits server-side, but the client never observes the response.
    await application.acknowledge(input(value, page.nextCursor, 'ack-dead-session-original'));
    await isolated.runtime.db.updateTable('sync_sessions')
      .set({ status: 'terminated', termination_reason: 'lease_expired', terminated_at: new Date() })
      .where('session_id', '=', value.session.sessionId).execute();
    // The durable client retry under the dead Session is a permanent denial, not a transient one:
    // receipt replay is also gated on live Session authority, so the client must abandon the intent.
    await assert.rejects(application.acknowledge(input(value, page.nextCursor, 'ack-dead-session-original')),
      (error: unknown) => error instanceof SyncAckError && error.code === 'resource_not_found');
    const current = (await isolated.runtime.pool.query<{
      lease_generation: string; lifecycle_revision: string;
    }>('select lease_generation::text,lifecycle_revision::text from sync_replicas where replica_id=$1',
    [value.replica.replicaId])).rows[0]!;
    const renewed = await value.issuer.issue({ credential: value.credential,
      idempotencyKey: 'ack-dead-session-renewal', requestFingerprint: 'ack-dead-session-renewal-fingerprint',
      collectionId: COLLECTION, replicaId: value.replica.replicaId,
      expectedLeaseGeneration: current.lease_generation,
      expectedLifecycleRevision: current.lifecycle_revision, binding: value.replica.binding,
      requestedScopes: ['sync:pull'], origin: ORIGIN, protocolVersion: '0.2' });
    // Pull under the renewed Session hands the acknowledged cursor off to a re-issued token.
    const restored = await value.reader.read({ credential: value.credential,
      sessionId: renewed.session.sessionId, cursor: page.nextCursor, limit: 10 });
    assert.deepEqual(restored.events, []);
    assert.equal(restored.cursorReissued, true);
    assert.notEqual(restored.nextCursor, page.nextCursor);
    // Acking the re-issued equal-tuple cursor under the new Session consumes the handoff proof.
    const acked = await application.acknowledge({ credential: value.credential,
      idempotencyKey: 'ack-dead-session-reissued', origin: ORIGIN,
      mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: renewed.session.sessionId, cursor: restored.nextCursor, warnings: [] } });
    assert.equal(acked.ackedCursor, restored.nextCursor);
    const checkpoint = await isolated.runtime.db.selectFrom('sync_replicas').select('checkpoint_cursor')
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(checkpoint.checkpoint_cursor, restored.nextCursor);
  });

  test('retries a previously published partial page after the stream grows', async () => {
    const value = await context('pull-evidence-growing-stream');
    const firstOperation = await addOperation(8_001);
    const firstPage = await value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 10 });
    assert.equal(firstPage.events.some((event) => event.kind === 'operation'
      && event.operation.opId === firstOperation.opId), true);

    const laterOperation = await addOperation(8_002);
    const retry = await value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 10 });
    assert.equal(retry.events.some((event) => event.kind === 'operation'
      && event.operation.opId === firstOperation.opId), true);
    assert.equal(retry.events.some((event) => event.kind === 'operation'
      && event.operation.opId === laterOperation.opId), true);
    const firstCursorEvidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').selectAll()
      .where('replica_id', '=', value.replica.replicaId)
      .where('cursor', '=', firstPage.events.find((event) => event.kind === 'operation'
        && event.operation.opId === firstOperation.opId)!.cursor)
      .execute();
    assert.equal(firstCursorEvidence.length, 1);
  });

  test('first Ack, exact replay and restart preserve one receipt/audit and do not renew twice', async () => {
    const value = await context('replay');
    const page = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: null, limit: 10 });
    const application = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    const first = await application.acknowledge(input(value, page.nextCursor, 'ack-replay-key'));
    const afterFirst = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    const restarted = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    const replay = await restarted.acknowledge(input(value, page.nextCursor, 'ack-replay-key'));
    const afterReplay = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.deepEqual(replay, first); assert.equal(afterReplay.lease_expires_at.getTime(), afterFirst.lease_expires_at.getTime());
    assert.equal(await isolated.runtime.db.selectFrom('sync_ack_receipts').selectAll()
      .where('replica_id', '=', value.replica.replicaId).execute().then((rows) => rows.length), 1);
    assert.equal(await isolated.runtime.db.selectFrom('audit_events')
      .innerJoin('audit_event_payloads', 'audit_event_payloads.event_id', 'audit_events.id')
      .selectAll('audit_events')
      .where('audit_events.event_type', '=', 'sync.replica.acknowledged')
      .where(sql<boolean>`audit_event_payloads.details_json ->> 'replicaId' = ${value.replica.replicaId}`)
      .execute().then((rows) => rows.length), 1);
  });

  test('two connections Ack in reverse order and retain the legal maximum tuple', async () => {
    await addOperation(1); await addOperation(2);
    const value = await context('concurrent');
    const firstPage = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: null, limit: 1 });
    const secondPage = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: firstPage.nextCursor, limit: 1 });
    let releaseOld!: () => void;
    const oldPaused = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldVerified!: () => void;
    const oldReachedEvidence = new Promise<void>((resolve) => { oldVerified = resolve; });
    const application = createPostgresSyncAckApplication(isolated.runtime.db, { leaseExtensionSeconds: 600,
      maxLeaseLifetimeSeconds: 3_600, faultInjector: { async afterEvidenceVerified(cursor) {
        if (cursor === firstPage.nextCursor) { oldVerified(); await oldPaused; }
      } } });
    const old = application.acknowledge(input(value, firstPage.nextCursor, 'ack-old-key'));
    await oldReachedEvidence;
    const newer = await application.acknowledge(input(value, secondPage.nextCursor, 'ack-new-key'));
    releaseOld();
    await assert.rejects(old, (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica');
    const checkpoint = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(checkpoint.checkpoint_cursor, newer.ackedCursor);
    assert.equal(BigInt(checkpoint.checkpoint_commit_ordinal!), BigInt(secondPage.nextTuple.commitOrdinal));
    assert.deepEqual((checkpoint.wire_json as { checkpoint?: unknown }).checkpoint, {
      acknowledgedCursor: newer.ackedCursor,
      acknowledgedCommitOrdinal: secondPage.nextTuple.commitOrdinal,
    });
  });

  test('a renewal that lands before the Ack read denies the Ack instead of applying a stale revision', async () => {
    // The checkpoint UPDATE fences on `lease_generation` and on the checkpoint
    // tuple, but not on `lifecycle_revision`, while the Replica's lifecycle is
    // what `loadAuthority(lock=true)` validated against the Session. This is the
    // shape that makes that omission safe: the Session/replica revision equality
    // is re-read under the Replica row lock AFTER the preliminary read, so a
    // renewal that lands in between — the ordinary renewal path that bumps
    // `lifecycle_revision` without touching `lease_generation` — turns the Ack
    // into `stale_replica` rather than letting it commit against authority it no
    // longer matches. Removing that check, or the locked re-read, fails here.
    await addOperation(901);
    const value = await context('revision-fence');
    const page = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: null, limit: 1 });
    const prior = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atEvidence = new Promise<void>((resolve) => { reached = resolve; });
    const application = createPostgresSyncAckApplication(isolated.runtime.db, { leaseExtensionSeconds: 600,
      maxLeaseLifetimeSeconds: 3_600, faultInjector: { async afterEvidenceVerified() { reached(); await held; } } });
    const ack = application.acknowledge(input(value, page.nextCursor, 'ack-revision-fence-key'));
    await atEvidence;
    await isolated.runtime.pool.query(
      'update sync_replicas set lifecycle_revision = lifecycle_revision + 1 where replica_id = $1',
      [value.replica.replicaId]);
    release();
    await assert.rejects(ack, (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica');
    const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(replica.checkpoint_cursor, prior.checkpoint_cursor,
      'a denied Ack must not move the checkpoint');
    // Strictly greater, not exactly +1: a denied Ack on a baseline-less Replica
    // also migrates it to recovery_required, which advances the revision once
    // more (sync-ack-postgres `migrateBaselineLessReplicaToRecovery`). What this
    // asserts is that the renewal itself stood and was never rolled back.
    assert.ok(BigInt(replica.lifecycle_revision) > BigInt(prior.lifecycle_revision),
      'the renewal itself stands');
  });

  test('a denied Ack on a baseline-less Replica hands it recovery authority', async () => {
    // The client rejects an Ack intent on four codes and then needs fresh
    // recovery authority. The server issues a recovery Capability only for
    // `replicaState === 'recovery_required'`, so a denial that leaves a
    // baseline-less Replica `active` is a deadlock the client cannot leave:
    // every wake re-enters recovery and the plain bootstrap Snapshot it is
    // offered must be refused (P3-33). Both reachable codes are covered here;
    // the migration must fire for each and must not touch a Replica that has a
    // checkpoint.
    const application = createPostgresSyncAckApplication(isolated.runtime.db, { leaseExtensionSeconds: 600,
      maxLeaseLifetimeSeconds: 3_600 });
    const cases = [
      // A cursor whose evidence row does not exist (pruned by retention, or
      // minted for another scope) is reported as `invalid_cursor_scope`.
      ['invalid_cursor_scope', 'cursor-never-issued-for-this-replica'],
      // A Session superseded by a renewal is `stale_replica` before any
      // checkpoint comparison happens.
      ['stale_replica', null],
    ] as const;
    for (const [code, bogusCursor] of cases) {
      const value = await context(`recovery-migration-${code}`);
      const before = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
        .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
      assert.equal(before.checkpoint_commit_ordinal, null, 'the Replica must start without a baseline');
      let cursor = bogusCursor;
      if (cursor === null) {
        const page = await value.reader.read({ credential: value.credential,
          sessionId: value.session.sessionId, cursor: null, limit: 1 });
        cursor = page.nextCursor;
        await isolated.runtime.pool.query(
          'update sync_replicas set lifecycle_revision = lifecycle_revision + 1 where replica_id = $1',
          [value.replica.replicaId]);
      }
      await assert.rejects(
        application.acknowledge(input(value, cursor, `ack-recovery-migration-${code}`)),
        (error: unknown) => error instanceof SyncAckError && error.code === code);
      const replica = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
        .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
      assert.equal(replica.status, 'recovery_required', `${code} must migrate the Replica`);
      assert.equal(replica.checkpoint_commit_ordinal, null);
      const audits = await isolated.runtime.db.selectFrom('audit_events')
        .innerJoin('audit_event_payloads', 'audit_event_payloads.event_id', 'audit_events.id')
        .select(['audit_events.id', 'audit_event_payloads.details_json'])
        .where('audit_events.event_type', '=', 'sync.replica.lifecycle.recovery_required')
        .where(sql<boolean>`audit_event_payloads.details_json ->> 'replicaId' = ${value.replica.replicaId}`)
        .execute();
      assert.equal(audits.length, 1, `${code} must write exactly one recovery audit event`);
      assert.equal((audits[0]?.details_json as { code?: string }).code, code);
    }

    // A Replica with a baseline keeps the Session-refresh exit: the CAS requires
    // a null checkpoint, so the migration is not a blanket state change.
    const withBaseline = await context('recovery-migration-with-baseline');
    const firstPage = await withBaseline.reader.read({ credential: withBaseline.credential,
      sessionId: withBaseline.session.sessionId, cursor: null, limit: 1 });
    const firstAck = await application.acknowledge(input(withBaseline, firstPage.nextCursor, 'ack-baseline-key'));
    assert.equal(firstAck.ackedCursor, firstPage.nextCursor);
    await isolated.runtime.pool.query(
      'update sync_replicas set lifecycle_revision = lifecycle_revision + 1 where replica_id = $1',
      [withBaseline.replica.replicaId]);
    await assert.rejects(
      application.acknowledge(input(withBaseline, firstPage.nextCursor, 'ack-baseline-denied-key')),
      (error: unknown) => error instanceof SyncAckError && error.code === 'stale_replica');
    const unaffected = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', withBaseline.replica.replicaId).executeTakeFirstOrThrow();
    assert.notEqual(unaffected.status, 'recovery_required',
      'a Replica with an acknowledged baseline must not be migrated');
  });

  test('unpublished/tampered/cross-scope/reused keys fail without checkpoint, lease, receipt or audit changes', async () => {
    const left = await context('left'); const right = await context('right');
    const page = await left.reader.read({ credential: left.credential, sessionId: left.session.sessionId,
      cursor: null, limit: 10 });
    const application = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
    // Both Replicas acknowledge a real baseline FIRST, on purpose: a denial for a
    // baseline-less Replica now migrates it to recovery_required (the deadlock
    // exit — see 'a denied Ack on a baseline-less Replica hands it recovery
    // authority'). This case is about the CAS-protected shape, where a denial
    // must leave checkpoint, lease and receipts untouched.
    // The baselines use an EARLIER page than the cursors this case acks later:
    // re-acking an already acknowledged tuple is itself `stale_replica` without
    // a rebind proof, which is a different case.
    const leftBaseline = await left.reader.read({ credential: left.credential,
      sessionId: left.session.sessionId, cursor: null, limit: 1 });
    const rightPage = await right.reader.read({ credential: right.credential,
      sessionId: right.session.sessionId, cursor: null, limit: 10 });
    for (const [value, cursor, key] of [[left, leftBaseline.nextCursor, 'ack-left-baseline'],
      [right, rightPage.nextCursor, 'ack-right-baseline']] as const) {
      assert.ok((await application.acknowledge(input(value, cursor, key))).ackedAt);
    }
    const beforeRight = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', right.replica.replicaId).executeTakeFirstOrThrow();
    const unpublished = left.keyring.sign({ replicaId: left.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: left.replica.leaseGeneration, sessionId: left.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 10,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: '999999', streamKind: 'operation', stableId: 'future-unpublished' } });
    await assert.rejects(application.acknowledge(input(left, unpublished, 'ack-unpublished')),
      (error: unknown) => error instanceof SyncAckError && error.code === 'invalid_cursor_scope');
    for (const cursor of [`${rightPage.nextCursor}x`, rightPage.nextCursor]) {
      await assert.rejects(application.acknowledge(input(right, cursor, `ack-denied-${cursor.length}`)));
    }
    const after = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', right.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(after.checkpoint_cursor, beforeRight.checkpoint_cursor);
    assert.equal(after.lease_expires_at.getTime(), beforeRight.lease_expires_at.getTime());
    assert.equal(after.status, 'active', 'a Replica with a baseline keeps the Session-refresh exit');
    const accepted = await application.acknowledge(input(left, page.nextCursor, 'ack-reuse-key'));
    assert.ok(accepted.ackedAt);
    await assert.rejects(application.acknowledge(input(left, `${page.nextCursor}x`, 'ack-reuse-key')),
      (error: unknown) => error instanceof SyncAckError && error.code === 'idempotency_key_reused');
  });

  test('fault after checkpoint rolls checkpoint, receipt, audit and lease back together', async () => {
    const value = await context('rollback');
    const page = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: null, limit: 10 });
    const before = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    const application = createPostgresSyncAckApplication(isolated.runtime.db, { leaseExtensionSeconds: 600,
      maxLeaseLifetimeSeconds: 3_600, faultInjector: { afterCheckpointUpdated() { throw new Error('rollback'); } } });
    await assert.rejects(application.acknowledge(input(value, page.nextCursor, 'ack-rollback-key')));
    const after = await isolated.runtime.db.selectFrom('sync_replicas').selectAll()
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(after.checkpoint_cursor, before.checkpoint_cursor);
    assert.equal(after.lease_expires_at.getTime(), before.lease_expires_at.getTime());
    assert.equal(await isolated.runtime.db.selectFrom('sync_ack_receipts').selectAll()
      .where('idempotency_key', '=', 'ack-rollback-key').execute().then((rows) => rows.length), 0);
  });

  test('production Ack retries a proven serialization rollback without duplicating the receipt', async () => {
    const value = await context('retry-serialization');
    const page = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: null, limit: 10 });
    let attempts = 0;
    const application = createPostgresSyncAckApplication(isolated.runtime.db, { leaseExtensionSeconds: 600,
      maxLeaseLifetimeSeconds: 3600, faultInjector: { afterCheckpointUpdated() {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('serialization fixture'), { code: '40001' });
      } } });
    await application.acknowledge(input(value, page.nextCursor, 'ack-serialization-retry'));
    assert.equal(attempts, 2);
    const receipts = await isolated.runtime.db.selectFrom('sync_ack_receipts').selectAll()
      .where('idempotency_key', '=', 'ack-serialization-retry').execute();
    assert.equal(receipts.length, 1);
  });

  test('uses database time and never renews beyond the generation lifetime ceiling', async () => {
    const value = await context('lease-bound');
    const page = await value.reader.read({ credential: value.credential, sessionId: value.session.sessionId,
      cursor: null, limit: 10 });
    const generation = await isolated.runtime.db.selectFrom('sync_replica_generations').select('issued_at')
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    const application = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 3_600, maxLeaseLifetimeSeconds: 3_601 });
    await application.acknowledge(input(value, page.nextCursor, 'ack-lease-bound'));
    const after = await isolated.runtime.db.selectFrom('sync_replicas').select('lease_expires_at')
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.ok(after.lease_expires_at.getTime() <= generation.issued_at.getTime() + 3_601_000);
  });

  test('Pull binds the live purge boundary and rejects a previously issued cursor as recovery-required', async () => {
    const value = await context('purge-boundary');
    const operation = await addOperation(90_001);
    const page = await value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 1_000 });
    assert.equal(page.events.some((event) => event.kind === 'operation'
      && event.operation.opId === operation.opId), true);
    await isolated.runtime.db.updateTable('sync_collection_purge_state').set({
      purged_through_commit_ordinal: 200_000n,
      purged_through_stream_kind: 0,
      purged_through_stable_id: 'purged-operation',
      state_revision: 1n,
    }).where('collection_id', '=', COLLECTION).execute();
    const beforeRecovery = await isolated.runtime.db.selectFrom('sync_replicas')
      .select('lifecycle_revision').where('replica_id', '=', value.replica.replicaId)
      .executeTakeFirstOrThrow();
    await assert.rejects(value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: page.nextCursor, limit: 1_000 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    await assert.rejects(value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: page.nextCursor, limit: 1_000 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    await assert.rejects(value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 1_000 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    const replica = await isolated.runtime.db.selectFrom('sync_replicas')
      .select(['status', 'lifecycle_revision']).where('replica_id', '=', value.replica.replicaId)
      .executeTakeFirstOrThrow();
    // Scoped to this Replica on purpose: the count used to span the whole
    // table, so any other test whose denial migrates a baseline-less Replica
    // (the Ack path does exactly that) broke it from a distance.
    const audits = await isolated.runtime.db.selectFrom('audit_events')
      .innerJoin('audit_event_payloads', 'audit_event_payloads.event_id', 'audit_events.id')
      .select('audit_events.id')
      .where('audit_events.event_type', '=', 'sync.replica.lifecycle.recovery_required')
      .where(sql<boolean>`audit_event_payloads.details_json ->> 'replicaId' = ${value.replica.replicaId}`)
      .execute();
    assert.equal(replica.status, 'recovery_required');
    assert.equal(BigInt(replica.lifecycle_revision), BigInt(beforeRecovery.lifecycle_revision) + 1n);
    assert.equal(audits.length, 1);
  });

  test('retirement fences concurrent real Pull and ordinary Ack on separate connections', async () => {
    const value = await context('retire-race');
    const page = await value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 10 });
    let entered!: () => void;
    let release!: () => void;
    const atReplicaWrite = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const retirement = createPostgresReplicaRetirementApplication(isolated.runtime.db, {
      faultInjector: { async afterPhase(phase) {
        if (phase === 'replica') { entered(); await blocked; }
      } },
    }).retireExtension({ credential: value.credential, sessionId: value.session.sessionId,
      idempotencyKey: 'retire-race-key', requestFingerprint: 'retire-race' });
    await atReplicaWrite;
    const pull = value.reader.read({ credential: value.credential,
      sessionId: value.session.sessionId, cursor: null, limit: 10 });
    const ack = createPostgresSyncAckApplication(isolated.runtime.db,
      { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 })
      .acknowledge(input(value, page.nextCursor, 'ack-during-retire'));
    const pullRejected = assert.rejects(pull, /retired|stale|not_found|authorization/iu);
    const ackRejected = assert.rejects(ack, /retired|stale|not_found|authorization/iu);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await retirement;
    await Promise.all([pullRejected, ackRejected]);
    const stored = await isolated.runtime.db.selectFrom('sync_replicas').select('status')
      .where('replica_id', '=', value.replica.replicaId).executeTakeFirstOrThrow();
    assert.equal(stored.status, 'retired');
    value.keyring.destroy();
  });
});
