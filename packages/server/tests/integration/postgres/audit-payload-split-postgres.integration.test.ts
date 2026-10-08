import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import {
  appendAuditEvent,
  AuditPayloadArchiveError,
  createPostgresAuditPayloadArchiveCapability,
  createPostgresLedgerArchiveSegmentRepository,
  createMigrator,
  createPostgresAuditHotPayloadSource,
  createPostgresAuditPayloadReader,
  runMigrations,
  type CreateLedgerArchiveSegmentInput,
  type DatabaseTransaction,
} from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const BEFORE_SPLIT = '202610010400_sync_history_floors';

describeWithPostgres('audit header and hot payload split', () => {
  let isolated: IsolatedPostgresRuntime;
  let archiverRole: string;
  let ordinaryRole: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('audit_payload_split');
    await runMigrations(isolated.runtime.db, 'latest');
    archiverRole = `audit_archiver_${randomUUID().replaceAll('-', '_')}`;
    ordinaryRole = `audit_ordinary_${randomUUID().replaceAll('-', '_')}`;
    await isolated.runtime.pool.query(`DO $block$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='known_audit_payload_archiver') THEN
        CREATE ROLE known_audit_payload_archiver NOLOGIN;
      END IF;
    END $block$`);
    await isolated.runtime.pool.query(`CREATE ROLE ${archiverRole} NOLOGIN`);
    await isolated.runtime.pool.query(`CREATE ROLE ${ordinaryRole} NOLOGIN`);
    await isolated.runtime.pool.query(`GRANT known_audit_payload_archiver TO ${archiverRole}`);
    await isolated.runtime.pool.query(`GRANT USAGE ON SCHEMA ${isolated.schema}
      TO ${archiverRole},${ordinaryRole}`);
    await isolated.runtime.pool.query(`GRANT SELECT,UPDATE ON audit_events TO ${archiverRole},${ordinaryRole}`);
    await isolated.runtime.pool.query(`GRANT SELECT,DELETE ON audit_event_payloads
      TO ${archiverRole},${ordinaryRole}`);
    await isolated.runtime.pool.query(`GRANT SELECT,UPDATE ON ledger_archive_segments
      TO ${archiverRole},${ordinaryRole}`);
  }, 120_000);

  afterAll(async () => {
    if (isolated) {
      await isolated.runtime.pool.query(`DROP OWNED BY ${archiverRole},${ordinaryRole}`);
      await isolated.runtime.pool.query(`DROP ROLE IF EXISTS ${archiverRole},${ordinaryRole}`);
      await isolated.close();
    }
  });

  test('writer atomically stores a null-authority header and canonical payload facts', async () => {
    const id = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(transaction, {
      operationId: null, collectionId: null, principalId: 'principal-a',
      eventType: 'audit.test', details: { z: 1, nested: { y: true, a: 'utf8-中' }, a: 2 },
      createdAt: new Date('2026-08-30T00:00:00.000Z'),
    }));
    const row = await isolated.runtime.pool.query<{
      operation_id: string | null; collection_id: string | null; payload_digest: string;
      payload_bytes: string; payload_bucket_locator: string; canonical_json: string;
    }>(`select event.operation_id,event.collection_id,event.payload_digest,
              event.payload_bytes::text,event.payload_bucket_locator,
              payload.details_json::text canonical_json
         from audit_events event join audit_event_payloads payload on payload.event_id=event.id
        where event.id=$1`, [id.toString()]);
    const stored = row.rows[0]!;
    assert.equal(stored.operation_id, null);
    assert.equal(stored.collection_id, null);
    assert.equal(stored.payload_bucket_locator, `hot://audit_event_payloads/${id}`);
    assert.equal(Number(stored.payload_bytes), Buffer.byteLength(stored.canonical_json));
    assert.equal(stored.payload_digest,
      `sha256:${createHash('sha256').update(stored.canonical_json).digest('hex')}`);
    assert.equal('details_json' in (await isolated.runtime.pool.query(
      `select * from audit_events where id=$1`, [id.toString()],
    )).rows[0]!, false);
  });

  test('header and payload reject ordinary update, delete, and truncate', async () => {
    const id = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(transaction, {
      operationId: null, collectionId: null, principalId: null,
      eventType: 'audit.immutable', details: { immutable: true },
    }));
    const client = await isolated.runtime.pool.connect();
    try {
      for (const statement of [
        [`update audit_events set event_type='changed' where id=$1`, [id.toString()]],
        [`delete from audit_events where id=$1`, [id.toString()]],
        [`update audit_event_payloads set details_json='{}' where event_id=$1`, [id.toString()]],
        [`delete from audit_event_payloads where event_id=$1`, [id.toString()]],
        ['truncate table audit_event_payloads', []],
        ['truncate table audit_events cascade', []],
      ] as const) {
        await assert.rejects(() => client.query(statement[0], statement[1]),
          (error: unknown) => ['23514', '23503', '0A000']
            .includes((error as { code?: string }).code ?? ''));
      }
    } finally {
      client.release();
    }
  });

  test('custom GUC, removed test cleanup value, and wrong role cannot authorize mutation', async () => {
    const id = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(transaction, {
      operationId: null, collectionId: null, principalId: null,
      eventType: 'audit.no-guc-bypass', details: { protected: true },
    }));
    for (const capability of ['enabled', 'test_cleanup']) {
      await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
        await sql.raw(`set local session authorization ${ordinaryRole}`).execute(transaction);
        await sql`SELECT set_config('known.audit_payload_archive_capability', ${capability}, true),
          set_config('known.audit_payload_archive_transaction', pg_current_xact_id()::text, true)`
          .execute(transaction);
        await sql`UPDATE audit_events SET hot_payload_id=NULL,
          payload_archive_segment_id=${randomUUID()}::uuid,
          payload_bucket_locator='s3://bypass/object' WHERE id=${id}`.execute(transaction);
      }), (error: unknown) => (error as { constraint?: string }).constraint
        === 'audit_events_archive_cutover_guard');
    }
    await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
      await sql.raw(`set local session authorization ${archiverRole}`).execute(transaction);
      await sql`SELECT set_config('known.audit_payload_archive_capability','enabled',true),
        set_config('known.audit_payload_archive_transaction','wrong-transaction',true)`
        .execute(transaction);
      await sql`DELETE FROM audit_event_payloads WHERE event_id=${id}`.execute(transaction);
    }), (error: unknown) => (error as { constraint?: string }).constraint
      === 'audit_event_payloads_mutation_guard');
  });

  test('cutover rejects unready, mismatched, out-of-range, and held manifests', async () => {
    const cases = [
      { expected: 'archive_not_ready', segment: { targetState: 'verified' as const } },
      { expected: 'binding_mismatch', segment: { ledgerFamily: 'operations' } },
      { expected: 'binding_mismatch', segment: { sourceScope: 'collection:not-global' } },
      { expected: 'binding_mismatch', segment: { rangeOffset: 100n } },
      { expected: 'archive_not_ready', segment: { legalHold: true } },
    ] as const;
    for (const [index, item] of cases.entries()) {
      const id = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(transaction, {
        operationId: null, collectionId: null, principalId: null,
        eventType: `audit.archive-negative.${index}`, details: { index },
      }));
      const segmentId = await readySegment(isolated, id, item.segment);
      await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
        await authorizeArchiveTransaction(transaction, archiverRole);
        await createPostgresAuditPayloadArchiveCapability(transaction).cutover({
          eventId: id, archiveSegmentId: segmentId,
        });
      }), (error: unknown) => error instanceof AuditPayloadArchiveError
        && error.code === item.expected);
      assert.deepEqual((await createPostgresAuditPayloadReader(isolated.runtime.db).read(id)).details,
        { index });
    }
  });

  test('closed keyset source is stable and even an archiver cannot manufacture a missing payload', async () => {
    const occurred = new Date('2026-08-30T01:00:00.000Z');
    const ids: bigint[] = [];
    for (const marker of ['a', 'b', 'c']) {
      ids.push(await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(transaction, {
        operationId: null, collectionId: null, principalId: null,
        eventType: `audit.keyset.${marker}`, details: { marker }, createdAt: occurred,
      })));
    }
    const source = createPostgresAuditHotPayloadSource(isolated.runtime.db);
    const first = await source.readClosedBatch({
      afterExclusive: { createdAt: new Date(occurred.getTime() - 1), id: 0n },
      throughInclusive: { createdAt: occurred, id: ids[2]! }, limit: 2,
    });
    const second = await source.readClosedBatch({
      afterExclusive: { createdAt: first[1]!.createdAt, id: first[1]!.id },
      throughInclusive: { createdAt: occurred, id: ids[2]! }, limit: 2,
    });
    assert.deepEqual([...first, ...second].map((row) => row.id), ids);

    await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
      await authorizeArchiveTransaction(transaction, archiverRole);
      await sql`delete from audit_event_payloads where event_id=${ids[0]}`.execute(transaction);
    }), (error: unknown) => (error as { constraint?: string }).constraint
      === 'audit_event_payloads_mutation_guard');
    assert.deepEqual((await createPostgresAuditPayloadReader(isolated.runtime.db).read(ids[0]!)).details,
      { marker: 'a' });
  });

  test('legacy archive capability cannot bypass the durable purge job', async () => {
    const id = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(transaction, {
      operationId: null, collectionId: null, principalId: null,
      eventType: 'audit.archive', details: { evidence: 'retained elsewhere' },
    }));
    const segmentId = await readySegment(isolated, id);
    await assert.rejects(() => isolated.runtime.db.transaction().execute(async (transaction) => {
      await authorizeArchiveTransaction(transaction, archiverRole);
      await createPostgresAuditPayloadArchiveCapability(transaction).cutover({
        eventId: id, archiveSegmentId: segmentId,
      });
    }), (error: unknown) => (error as { constraint?: string }).constraint
      === 'audit_events_archive_cutover_guard');
    assert.deepEqual((await createPostgresAuditPayloadReader(isolated.runtime.db).read(id)).details,
      { evidence: 'retained elsewhere' });
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from audit_events where id=$1', [id.toString()],
    )).rows[0]!.count, 1);
    const binding = (await isolated.runtime.pool.query<{
      payload_archive_segment_id: string | null; payload_bucket_locator: string;
    }>('select payload_archive_segment_id,payload_bucket_locator from audit_events where id=$1',
    [id.toString()])).rows[0]!;
    assert.equal(binding.payload_archive_segment_id, null);
    assert.equal(binding.payload_bucket_locator, `hot://audit_event_payloads/${id}`);
  });
});

describeWithPostgres('audit payload split migration upgrade and rollback', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('audit_payload_upgrade');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('backfills verified payloads and supports lossless down/up smoke', async () => {
    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const before = await migrator.migrateTo(BEFORE_SPLIT);
    if (before.error) throw before.error;
    await isolated.runtime.pool.query(`
      insert into audit_events(operation_id,collection_id,principal_id,event_type,details_json,created_at)
      values(null,null,'upgrade-principal','audit.upgrade','{"b":2,"a":1}'::jsonb,
             '2026-08-30T02:00:00.000Z')
    `);
    const upgraded = await migrator.migrateTo('202610010600_audit_payload_split');
    if (upgraded.error) throw upgraded.error;
    const reader = createPostgresAuditPayloadReader(isolated.runtime.db);
    assert.deepEqual((await reader.read(1n)).details, { a: 1, b: 2 });

    const down = await migrator.migrateDown();
    if (down.error) throw down.error;
    assert.deepEqual((await isolated.runtime.pool.query(
      'select details_json from audit_events where id=1',
    )).rows[0]!.details_json, { a: 1, b: 2 });
    const up = await migrator.migrateUp();
    if (up.error) throw up.error;
    assert.deepEqual((await createPostgresAuditPayloadReader(isolated.runtime.db).read(1n)).details,
      { a: 1, b: 2 });
  });
});

async function authorizeArchiveTransaction(
  transaction: DatabaseTransaction,
  role: string,
): Promise<void> {
  await sql.raw(`set local session authorization ${role}`).execute(transaction);
  await sql`SELECT
    set_config('known.audit_payload_archive_capability', 'enabled', true),
    set_config('known.audit_payload_archive_transaction', pg_current_xact_id()::text, true)
  `.execute(transaction);
}

async function readySegment(
  isolated: IsolatedPostgresRuntime,
  eventId: bigint,
  options: {
    readonly targetState?: 'verified' | 'reader_cutover';
    readonly ledgerFamily?: string;
    readonly sourceScope?: string;
    readonly rangeOffset?: bigint;
    readonly legalHold?: boolean;
  } = {},
): Promise<string> {
  const repository = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
  const segmentId = randomUUID();
  const lower = eventId + (options.rangeOffset ?? 0n);
  const input: CreateLedgerArchiveSegmentInput = {
    segmentId,
    ledgerFamily: options.ledgerFamily ?? 'audit_payload',
    sourceRelation: 'public.audit_event_payloads',
    sourceScope: options.sourceScope ?? 'global',
    sourceKeyKind: 'bigint', sourceKeyComparator: 'signed-bigint-ascending-v1',
    sourceKeyBounds: { lowerInclusive: lower, upperExclusive: lower + 1n },
    rowCount: 1n, sourceBytes: 128n,
    contentDigest: `sha256:${'a'.repeat(64)}`,
    archiveObjectUri: `s3://known-audit/${segmentId}`,
    archiveObjectEtag: `etag-${segmentId}`,
    archiveSchemaVersion: 1, kmsKeyId: 'kms:known:audit-v1', deleteAfter: null,
  };
  let segment = await repository.create(input);
  const target = options.targetState ?? 'reader_cutover';
  for (const state of ['sealed', 'exported', 'verified', 'reader_cutover'] as const) {
    segment = await repository.transition({
      segmentId, expectedState: segment.state, expectedRevision: segment.stateRevision,
      targetState: state, evidence: { test: true, state },
    });
    if (state === target) break;
  }
  if (options.legalHold) {
    segment = await repository.setLegalHold({
      segmentId, expectedState: segment.state, expectedRevision: segment.stateRevision,
      legalHold: true,
    });
  }
  return segment.segmentId;
}
