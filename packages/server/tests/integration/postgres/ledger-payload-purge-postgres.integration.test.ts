import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { loadLedgerArchiveReaderRuntimeConfig } from '../../../src/bootstrap/config-ledger-archive-reader.js';
import { composeLedgerArchiveColdReaders } from '../../../src/bootstrap/ledger-archive-reader-composition.js';

import {
  appendAuditEvent,
  appendOperationWithPayload,
  createPostgresAuditPayloadReader,
  createMigrator,
  createPostgresLedgerArchiveSegmentRepository,
  runMigrations,
  readOperationPayload,
  reclaimLedgerStorage,
} from '../../../src/infrastructure/database/index.js';
import {
  applyLedgerPayloadPurgeBatch,
  type LedgerPayloadPurgeClaim,
} from '../../../src/infrastructure/database/ledger-payload-purge.js';
import { createPostgresLedgerPayloadPurgeJobRepository } from '../../../src/infrastructure/database/ledger-payload-purge-job-repository.js';
import {
  findLatestAttachmentOperationByAttachmentId,
  findLatestAttachmentOperationByCommandId,
} from '../../../src/infrastructure/database/operation-payload-lookups.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveExporter,
  createPostgresAuditPayloadLedgerArchiveSource,
  createPostgresOperationLedgerArchiveSource,
  createPostgresSocialOutboxLedgerArchiveSource,
  type LedgerArchiveSource,
} from '../../../src/infrastructure/ledger-archive/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  applyAsExecutor,
  assertReceiptAndDetached,
  enqueueAndClaim,
  hasConstraint,
  provisionRoles,
  readySegment,
  seedCollection,
  seedOutbox,
  SimulatedCrash,
  transitionReaderCutover,
} from '../../support/ledger-payload-purge-postgres.js';

describeWithPostgres('fenced ledger payload purge executor', () => {
  let isolated: IsolatedPostgresRuntime;
  let executorRole: string;
  let ordinaryRole: string;
  let archiveRoot: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_payload_purge');
    await runMigrations(isolated.runtime.db, 'latest');
    archiveRoot = await mkdtemp(join(tmpdir(), 'known-ledger-purge-'));
    executorRole = `payload_purger_${randomUUID().replaceAll('-', '_')}`;
    ordinaryRole = `payload_ordinary_${randomUUID().replaceAll('-', '_')}`;
    await provisionRoles(isolated, executorRole, ordinaryRole);
  }, 120_000);

  afterAll(async () => {
    if (!isolated) return;
    await isolated.runtime.pool.query(`DROP OWNED BY ${executorRole},${ordinaryRole}`);
    await isolated.runtime.pool.query(`DROP ROLE IF EXISTS ${executorRole},${ordinaryRole}`);
    await isolated.close();
    await rm(archiveRoot, { recursive: true, force: true });
  });

  test('operation cutover retains facts, atomically removes payload, detaches, and receipts', async () => {
    const collectionId = `purge-collection-${randomUUID()}`;
    const operationId = `purge-operation-${randomUUID()}`;
    const boundaryOperationId = `purge-operation-${randomUUID()}`;
    const attachmentId = `purge-attachment-${randomUUID()}`;
    const blobId = `purge-blob-${randomUUID()}`;
    const finalizeCommandId = `purge-finalize-command-${randomUUID()}`;
    const retireCommandId = `purge-retire-command-${randomUUID()}`;
    await seedCollection(isolated, collectionId, `purge-root-${randomUUID()}`);
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type) values($1,'operation')`,
      [operationId],
    );
    await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(
      transaction,
      {
        operationId, collectionId, commitOrdinal: 1n, operationType: 'attachment.finalized',
        payloadJson: { commandId: finalizeCommandId, attachmentId, blobId },
        syncWireJson: { opId: operationId, collectionId }, actorPrincipalId: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ));
    await isolated.runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type) values($1,'operation')`,
      [boundaryOperationId],
    );
    await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(
      transaction,
      {
        operationId: boundaryOperationId, collectionId, commitOrdinal: 2n,
        operationType: 'attachment.retired',
        payloadJson: { commandId: retireCommandId, attachmentId, blobId },
        syncWireJson: { opId: boundaryOperationId, collectionId }, actorPrincipalId: null,
        createdAt: new Date('2026-01-01T00:00:01.000Z'),
      },
    ));
    const lookupBeforePurge = await isolated.runtime.db.transaction().execute(async (transaction) => ({
      byCommand: await findLatestAttachmentOperationByCommandId(
        transaction, 'attachment.finalized', finalizeCommandId,
      ),
      byAttachment: await findLatestAttachmentOperationByAttachmentId(
        transaction, 'attachment.retired', collectionId, attachmentId,
      ),
    }));
    const wrongSegmentId = await readySegment(isolated, {
      family: 'operation', relation: 'public.operations', scope: `collection:${collectionId}`,
      lower: 1n, upper: 3n,
    }, 'verified');
    await assert.rejects(() => isolated.runtime.pool.query(`update sync_history_floors set
      floor_commit_ordinal=2,floor_stable_id=$2,archive_segment_id=$3,state_revision=1
      where collection_id=$1`, [collectionId, boundaryOperationId, wrongSegmentId]),
    hasConstraint('sync_history_floors_binding_mismatch'));
    const source = await createPostgresOperationLedgerArchiveSource(
      isolated.runtime.db, `collection:${collectionId}`,
    );
    const segmentId = await exportVerifiedSegment(source, 1n, 3n);
    await isolated.runtime.pool.query(`update sync_history_floors set
      floor_commit_ordinal=2,floor_stable_id=$2,archive_segment_id=$3,state_revision=1
      where collection_id=$1`, [collectionId, boundaryOperationId, segmentId]);
    await transitionReaderCutover(isolated, segmentId);
    const claim = await enqueueAndClaim(isolated, executorRole, {
      segmentId, family: 'operation', scopeKey: collectionId,
      lower: 1n, upper: 3n, floorOrdinal: 2n,
      floorTieBreaker: boundaryOperationId, floorRevision: 1n,
    });

    await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
      await sql.raw(`set local session authorization ${executorRole}`).execute(transaction);
      await applyLedgerPayloadPurgeBatch(transaction, {
        claim, confirmedSegmentId: segmentId, nodeEnvironment: 'test',
        destructiveMode: 'development', batchSize: 1,
      });
      throw new SimulatedCrash();
    }), (error: unknown) => error instanceof SimulatedCrash);
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from operation_payloads where operation_id=$1', [operationId],
    )).rows[0]!.count, 1);

    const applied = await applyAsExecutor(isolated, executorRole, claim);
    assert.equal(applied.status, 'retryable');
    assert.equal(applied.deletedThisBatch, 1n);
    const released = await createPostgresLedgerPayloadPurgeJobRepository(isolated.runtime.db)
      .get(claim.jobId);
    assert.equal(released?.status, 'retryable');
    assert.equal(released?.leaseOwner, null);
    assert.equal(released?.leaseExpiresAt, null);
    const nextClaim = await createPostgresLedgerPayloadPurgeJobRepository(isolated.runtime.db)
      .claimSegment({ segmentId, leaseOwner: executorRole, leaseDurationMs: 300_000 });
    assert.ok(nextClaim, 'the next batch must be immediately claimable');
    const completed = await applyAsExecutor(isolated, executorRole, nextClaim);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.deletedTotal, 2n);
    const facts = (await isolated.runtime.pool.query<{
      payload_source: string; payload_locator: string; payload_count: number;
    }>(`select operation.payload_source,operation.payload_locator,
        (select count(*)::int from operation_payloads payload
          where payload.operation_id=operation.operation_id) payload_count
      from operations operation where operation.operation_id=$1`, [operationId])).rows[0]!;
    assert.equal(facts.payload_source, 'archive');
    assert.equal(facts.payload_locator,
      `archive://ledger-segment/${segmentId}/operation/${operationId}`);
    assert.equal(facts.payload_count, 0);
    const lookupAfterPurge = await isolated.runtime.db.transaction().execute(async (transaction) => ({
      byCommand: await findLatestAttachmentOperationByCommandId(
        transaction, 'attachment.finalized', finalizeCommandId,
      ),
      byAttachment: await findLatestAttachmentOperationByAttachmentId(
        transaction, 'attachment.retired', collectionId, attachmentId,
      ),
    }));
    assert.deepEqual(lookupAfterPurge, lookupBeforePurge);
    assert.equal(lookupAfterPurge.byCommand?.operation_id, operationId);
    assert.equal(lookupAfterPurge.byCommand?.attachment_id, attachmentId);
    assert.equal(lookupAfterPurge.byCommand?.blob_id, blobId);
    assert.equal(lookupAfterPurge.byAttachment?.operation_id, boundaryOperationId);
    await assertReceiptAndDetached(isolated, claim.jobId, segmentId, 1, 2n);
    const operation = (await isolated.runtime.pool.query<{
      collection_id: string; commit_ordinal: string; payload_source: 'archive';
      payload_locator: string; payload_digest_sha256: string; payload_bytes: string;
      payload_schema_version: 1; payload_bucket: string; sync_wire_present: boolean;
    }>(`select collection_id,commit_ordinal::text,payload_source,payload_locator,
        payload_digest_sha256,payload_bytes::text,payload_schema_version,
        payload_bucket::text,sync_wire_present from operations where operation_id=$1`,
    [operationId])).rows[0]!;
    const archiveSource = composedColdReaders().operationPayloadSource;
    const cold = await isolated.runtime.db.transaction().execute((transaction) => readOperationPayload(
      transaction,
      { operationId, collectionId: operation.collection_id,
        commitOrdinal: BigInt(operation.commit_ordinal), source: operation.payload_source,
        locator: operation.payload_locator, digestSha256: operation.payload_digest_sha256,
        byteCount: BigInt(operation.payload_bytes), schemaVersion: operation.payload_schema_version,
        bucket: operation.payload_bucket, syncWirePresent: operation.sync_wire_present },
      archiveSource,
    ));
    assert.deepEqual(cold.payloadJson, { commandId: finalizeCommandId, attachmentId, blobId });

    await assert.rejects(() => applyAsExecutor(isolated, executorRole, claim),
      (error: unknown) => (error as { stableCode?: string }).stableCode === 'lease_fenced');
  });

  test('audit capability is job/range bound and preserves its permanent header', async () => {
    const eventId = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(
      transaction,
      { operationId: null, collectionId: null, principalId: null,
        eventType: 'purge.audit', details: { sensitive: true } },
    ));
    const segmentId = await exportVerifiedSegment(
      createPostgresAuditPayloadLedgerArchiveSource(isolated.runtime.db),
      eventId, eventId + 1n,
    );
    await transitionReaderCutover(isolated, segmentId);
    const claim = await enqueueAndClaim(isolated, executorRole, {
      segmentId, family: 'audit_payload', scopeKey: 'global',
      lower: eventId, upper: eventId + 1n,
    });

    await applyAsExecutor(isolated, executorRole, claim);
    const header = (await isolated.runtime.pool.query<{
      hot_payload_id: string | null; payload_archive_segment_id: string;
      payload_bucket_locator: string; payload_count: number;
    }>(`select event.hot_payload_id,event.payload_archive_segment_id,
        event.payload_bucket_locator,(select count(*)::int from audit_event_payloads payload
          where payload.event_id=event.id) payload_count
      from audit_events event where event.id=$1`, [eventId.toString()])).rows[0]!;
    assert.equal(header.hot_payload_id, null);
    assert.equal(header.payload_archive_segment_id, segmentId);
    assert.equal(header.payload_bucket_locator,
      `archive://ledger-segment/${segmentId}/audit-event/${eventId}`);
    assert.equal(header.payload_count, 0);
    const coldSource = composedColdReaders().auditPayloadColdSource;
    assert.deepEqual((await createPostgresAuditPayloadReader(
      isolated.runtime.db, coldSource,
    ).read(eventId)).details, { sensitive: true });
  });

  test('audit payload batches cut over many rows with a constant statement budget', async () => {
    const ids = await isolated.runtime.db.transaction().execute(async transaction => {
      const values: bigint[] = [];
      for (let n = 0; n < 32; n += 1) values.push(await appendAuditEvent(transaction, {
        operationId: null, collectionId: null, principalId: null, eventType: 'purge.batch', details: { n },
      }));
      return values;
    });
    const segmentId = await exportVerifiedSegment(createPostgresAuditPayloadLedgerArchiveSource(isolated.runtime.db),
      ids[0]!, ids.at(-1)! + 1n);
    await transitionReaderCutover(isolated, segmentId);
    const claim = await enqueueAndClaim(isolated, executorRole, { segmentId, family: 'audit_payload',
      scopeKey: 'global', lower: ids[0]!, upper: ids.at(-1)! + 1n });
    let statements = 0;
    const db = isolated.runtime.db.withPlugin({
      transformQuery: ({ node }) => { statements += 1; return node; },
      transformResult: async ({ result }) => result,
    });
    const result = await db.transaction().execute(async transaction => {
      await sql.raw(`set local session authorization ${executorRole}`).execute(transaction);
      return applyLedgerPayloadPurgeBatch(transaction, { claim, confirmedSegmentId: segmentId,
        nodeEnvironment: 'test', destructiveMode: 'development', batchSize: 32 });
    });
    assert.equal(result.deletedThisBatch, 32n);
    assert.ok(statements <= 24, `per-row SQL regression: ${statements} statements for 32 rows`);
    const remaining = await isolated.runtime.pool.query('select count(*)::int n from audit_event_payloads where event_id = any($1::bigint[])', [ids.map(String)]);
    assert.equal(remaining.rows[0].n, 0);
  });

  test('social Outbox purge retains permanent claims and rejects GUC, tuple, age, and truncate bypasses', async () => {
    const scope = `purge-scope-${randomUUID()}`;
    const oldId = `purge-outbox-${randomUUID()}`;
    const youngId = `purge-outbox-${randomUUID()}`;
    await seedOutbox(isolated, scope, oldId, 1n, '2025-01-01T00:00:00.000Z', 'completed');
    await seedOutbox(isolated, scope, youngId, 2n, new Date().toISOString(), 'completed');
    await isolated.runtime.pool.query(`insert into outbox_retention_floors(
      handler_name,event_type,aggregate_scope) values(
      'social.publish-collection-change','social.collection-change',$1)`, [scope]);
    await assert.rejects(() => isolated.runtime.pool.query(`update outbox_retention_floors set
      floor_commit_ordinal=2,floor_domain_event_id=$2,state_revision=1
      where aggregate_scope=$1`, [scope, youngId]), hasConstraint('outbox_retention_floors_policy_window'));
    await isolated.runtime.pool.query(`update outbox_retention_floors set
      floor_commit_ordinal=1,floor_domain_event_id=$2,state_revision=1
      where aggregate_scope=$1`, [scope, oldId]);
    const segmentId = await exportVerifiedSegment(
      await createPostgresSocialOutboxLedgerArchiveSource(isolated.runtime.db, scope),
      1n, 2n,
    );
    const exported = await createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db)
      .get(segmentId);
    assert.equal(exported?.ledgerFamily, 'outbox_social');
    assert.equal(exported?.sourceRelation, 'public.outbox_events');
    await transitionReaderCutover(isolated, segmentId);
    const claim = await enqueueAndClaim(isolated, executorRole, {
      segmentId, family: 'outbox_social', scopeKey: scope,
      lower: 1n, upper: 2n, floorOrdinal: 1n, floorTieBreaker: oldId, floorRevision: 1n,
    });

    await assert.rejects(() => isolated.runtime.pool.query(`delete from outbox_events
      where outbox_id=$1`, [oldId]), hasConstraint('outbox_events_delete_guard'));
    // Include the referencing table so PostgreSQL reaches the ledger's own
    // TRUNCATE guard instead of rejecting the statement during FK validation.
    await assert.rejects(() => isolated.runtime.pool.query('truncate outbox_events, collection_classification_tag_jobs'),
      hasConstraint('outbox_events_truncate_guard'));
    await applyAsExecutor(isolated, executorRole, claim);
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from outbox_events where outbox_id=$1', [oldId],
    )).rows[0]!.count, 0);
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from outbox_dispatch_claims where outbox_id=$1', [oldId],
    )).rows[0]!.count, 1);
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from outbox_events where outbox_id=$1', [youngId],
    )).rows[0]!.count, 1);
    const routineVacuum = await reclaimLedgerStorage(
      isolated.runtime.pool, 'outbox_events', false,
    );
    assert.equal(routineVacuum.mode, 'vacuum_analyze');
    assert.equal(routineVacuum.lockImpact, 'routine_vacuum');
    assert.ok(routineVacuum.before.totalBytes > 0n && routineVacuum.after.totalBytes > 0n);
    const fullVacuum = await reclaimLedgerStorage(isolated.runtime.pool, 'outbox_events', true);
    assert.equal(fullVacuum.mode, 'vacuum_full_analyze');
    assert.equal(fullVacuum.lockImpact, 'access_exclusive_file_rewrite');
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from outbox_events where outbox_id=$1', [youngId],
    )).rows[0]!.count, 1);
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from outbox_dispatch_claims where outbox_id=$1', [oldId],
    )).rows[0]!.count, 1);
  });

  test('wrong role/GUC/transaction and legal hold cannot manufacture deletion authority', async () => {
    const eventId = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(
      transaction,
      { operationId: null, collectionId: null, principalId: null,
        eventType: 'purge.audit.negative', details: { protected: true } },
    ));
    await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
      await sql.raw(`set local session authorization ${ordinaryRole}`).execute(transaction);
      await sql`SELECT
        set_config('known.audit_payload_archive_capability','enabled',true),
        set_config('known.audit_payload_archive_transaction',pg_current_xact_id()::text,true),
        set_config('known.ledger_payload_purge_job',${randomUUID()},true),
        set_config('known.ledger_payload_purge_lease_token','1',true),
        set_config('known.ledger_payload_purge_transaction',pg_current_xact_id()::text,true)
      `.execute(transaction);
      await sql`delete from audit_event_payloads where event_id=${eventId}`.execute(transaction);
    }), hasConstraint('audit_event_payloads_mutation_guard'));

    const segmentId = await readySegment(isolated, {
      family: 'audit_payload', relation: 'public.audit_event_payloads', scope: 'global',
      lower: eventId, upper: eventId + 1n,
    });
    await isolated.runtime.pool.query(`update ledger_archive_segments
      set legal_hold=true,state_revision=state_revision+1 where segment_id=$1`, [segmentId]);
    await assert.rejects(() => enqueueAndClaim(isolated, executorRole, {
      segmentId, family: 'audit_payload', scopeKey: 'global',
      lower: eventId, upper: eventId + 1n,
    }), (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint
      === 'ledger_payload_purge_jobs_manifest_not_ready');
  });

  test('repository retry/reclaim/fail transitions fence stale leases', async () => {
    const eventId = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(
      transaction,
      { operationId: null, collectionId: null, principalId: null,
        eventType: 'purge.audit.retry', details: { retained: true } },
    ));
    const segmentId = await readySegment(isolated, {
      family: 'audit_payload', relation: 'public.audit_event_payloads', scope: 'global',
      lower: eventId, upper: eventId + 1n,
    });
    const first = await enqueueAndClaim(isolated, executorRole, {
      segmentId, family: 'audit_payload', scopeKey: 'global',
      lower: eventId, upper: eventId + 1n,
    });
    await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
      await sql.raw(`set local session authorization ${executorRole}`).execute(transaction);
      await sql`SELECT
        set_config('known.ledger_payload_purge_job',${first.jobId},true),
        set_config('known.ledger_payload_purge_lease_token',${first.leaseToken.toString()},true),
        set_config('known.ledger_payload_purge_transaction','wrong-transaction',true),
        set_config('known.audit_payload_archive_capability','enabled',true),
        set_config('known.audit_payload_archive_transaction',pg_current_xact_id()::text,true)
      `.execute(transaction);
      await sql`DELETE FROM audit_event_payloads WHERE event_id=${eventId}`.execute(transaction);
    }), hasConstraint('audit_event_payloads_mutation_guard'));
    const jobs = createPostgresLedgerPayloadPurgeJobRepository(isolated.runtime.db);
    assert.equal((await jobs.retry(first, 'transient_database', 0)).status, 'retryable');
    await assert.rejects(() => jobs.retry(first, 'stale_worker', 0),
      (error: unknown) => (error as { stableCode?: string }).stableCode === 'lease_fenced');
    const reclaimed = await jobs.claimSegment({
      segmentId, leaseOwner: executorRole, leaseDurationMs: 300_000,
    });
    assert.ok(reclaimed);
    assert.ok(reclaimed.leaseToken > first.leaseToken);
    assert.equal((await jobs.fail(reclaimed, 'non_retryable_invariant')).status, 'failed');
  });

  function composedColdReaders() {
    const sources = composeLedgerArchiveColdReaders({
      config: loadLedgerArchiveReaderRuntimeConfig({
        LEDGER_ARCHIVE_READ_ENABLED: 'true',
        LEDGER_ARCHIVE_STORE: 'filesystem',
        LEDGER_ARCHIVE_FILESYSTEM_ROOT: archiveRoot,
        LEDGER_ARCHIVE_KMS_KEY_ID: 'dev:payload-purge-e2e',
      }, 'test'),
      database: isolated.runtime,
    });
    if (!sources) throw new Error('cold reader composition was unexpectedly disabled');
    return sources;
  }

  async function exportVerifiedSegment<Row>(
    source: LedgerArchiveSource<Row>,
    lowerInclusive: bigint,
    upperExclusive: bigint,
  ): Promise<string> {
    const segmentId = randomUUID();
    const store = createFilesystemLedgerArchiveObjectStore({
      rootDirectory: archiveRoot, kmsKeyId: 'dev:payload-purge-e2e',
    });
    const exporter = createLedgerArchiveExporter({
      segments: createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db),
      objects: store, spoolDirectory: join(archiveRoot, 'spool'),
      pageSize: 10, byteCeiling: 10_000_000n,
    });
    const segment = await exporter.export({
      segmentId, source, lowerInclusive, upperExclusive,
      kmsKeyId: 'dev:payload-purge-e2e',
    });
    assert.equal(segment.state, 'verified');
    return segmentId;
  }
});

describeWithPostgres('ledger payload purge migration rollback', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('payload_purge_down_up'); }, 120_000);
  afterAll(async () => isolated?.close());

  test('supports empty down/up and recreates all guards', async () => {
    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const before = await migrator.migrateTo('202610010700_ledger_archive_export_jobs');
    if (before.error) throw before.error;
    const up = await migrator.migrateUp(); if (up.error) throw up.error;
    const down = await migrator.migrateDown(); if (down.error) throw down.error;
    const upAgain = await migrator.migrateUp(); if (upAgain.error) throw upAgain.error;
    const relations = await isolated.runtime.pool.query<{ count: number }>(`select count(*)::int count
      from information_schema.tables where table_schema=current_schema()
        and table_name in ('ledger_payload_purge_jobs','ledger_payload_purge_receipts')`);
    assert.equal(relations.rows[0]!.count, 2);
  });
});
