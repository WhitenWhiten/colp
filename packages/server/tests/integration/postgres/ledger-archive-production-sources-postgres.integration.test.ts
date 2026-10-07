import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';

import {
  appendAuditEvent,
  appendOperationWithPayload,
  AuditPayloadReadError,
  createPostgresAuditPayloadReader,
  createPostgresLedgerArchiveSegmentRepository,
  createMigrator,
  OperationPayloadReadError,
  readOperationPayload,
  type OperationPayloadDocument,
  type OperationPayloadFacts,
} from '../../../src/infrastructure/database/index.js';
import {
  createFilesystemLedgerArchiveObjectStore,
  createLedgerArchiveAuditPayloadColdSource,
  createLedgerArchiveColdReader,
  createLedgerArchiveExporter,
  createLedgerArchiveOperationPayloadSource,
  createPostgresAuditPayloadLedgerArchiveSource,
  createPostgresLedgerArchiveSourceRegistry,
  createPostgresOperationLedgerArchiveSource,
  formatAuditPayloadArchiveLocator,
  formatOperationArchiveLocator,
  LedgerArchiveProductionSourceError,
} from '../../../src/infrastructure/ledger-archive/index.js';
import { SyncPullReadError } from '../../../src/modules/sync/index.js';
import { readSyncPullRows } from '../../../src/infrastructure/sync/postgres/sync-operation-payload-reader.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('production ledger archive payload sources and cold readers', () => {
  let isolated: IsolatedPostgresRuntime;
  let objectRoot: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_archive_sources', { maxConnections: 8 });
    const migrated = await createMigrator(
      isolated.runtime.db, 'migrations', isolated.schema,
    ).migrateToLatest();
    if (migrated.error) throw migrated.error;
    objectRoot = await mkdtemp(join(tmpdir(), 'known-production-archive-'));
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
    if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
  });

  test('exports dense Collection operations and cold-hydrates a Pull page with one segment scan', async () => {
    const collectionId = `archive-collection-${randomUUID()}`;
    await seedCollection(isolated, collectionId, `archive-root-${randomUUID()}`);
    for (const ordinal of [1n, 2n]) {
      const operationId = `archive-operation-${ordinal}-${randomUUID()}`;
      await reserveOperation(isolated, operationId);
      await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(transaction, {
        operationId, collectionId, commitOrdinal: ordinal, operationType: 'sync.test',
        payloadJson: { commandId: `command-${ordinal}`, nested: { longer: true, a: Number(ordinal) } },
        syncWireJson: { opId: operationId, collectionId, ordinal: ordinal.toString() },
        actorPrincipalId: null, createdAt: new Date('2026-08-30T03:00:00.000Z'),
      }));
    }
    const rawOperationId = `archive-operation-3-${randomUUID()}`;
    await appendRawCanonicalOperation(isolated, {
      operationId: rawOperationId, collectionId, commitOrdinal: 3n,
      payloadJson: '{"decimal":1.00,"big":9007199254740991,"é":"composed","é":"decomposed","中":"值"}',
      syncWireJson: JSON.stringify({ opId: rawOperationId, collectionId, ordinal: '3' }),
    });
    const source = await createPostgresOperationLedgerArchiveSource(
      isolated.runtime.db, `collection:${collectionId}`,
    );
    const preview = await source.readPage({
      bounds: { lowerInclusive: 1n, upperExclusive: 4n }, limit: 10,
    });
    assert.equal(preview.rows[2]!.canonicalPayloadEnvelopeJson.includes('1.00'), true);
    assert.equal(preview.rows[2]!.canonicalPayloadEnvelopeJson.includes('9007199254740991'), true);
    assert.equal(preview.rows[2]!.canonicalPayloadEnvelopeJson.includes('"é"'), true);
    assert.equal(preview.rows[2]!.canonicalPayloadEnvelopeJson.includes('"é"'), true);
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const store = createFilesystemLedgerArchiveObjectStore({
      rootDirectory: objectRoot, kmsKeyId: 'dev:production-source',
    });
    let segment = await createLedgerArchiveExporter({
      segments, objects: store, spoolDirectory: join(objectRoot, 'spool'), pageSize: 1,
    }).export({
      segmentId: randomUUID(), source, lowerInclusive: 1n, upperExclusive: 4n,
      kmsKeyId: 'dev:production-source',
    });
    segment = await segments.transition({
      segmentId: segment.segmentId, expectedState: 'verified', expectedRevision: segment.stateRevision,
      targetState: 'reader_cutover', evidence: { test: true },
    });

    const operationRows = await isolated.runtime.pool.query<{
      operation_id: string; commit_ordinal: string; payload_digest_sha256: string;
      payload_bytes: string; payload_bucket: string; sync_wire_present: boolean;
    }>(`select operation_id,commit_ordinal::text,payload_digest_sha256,payload_bytes::text,
              payload_bucket::text,sync_wire_present
         from operations where collection_id=$1 order by commit_ordinal`, [collectionId]);
    await isolated.runtime.pool.query('alter table operations disable trigger operations_permanent');
    try {
      for (const row of operationRows.rows) {
        await isolated.runtime.pool.query(`update operations set payload_source='archive',payload_locator=$2
          where operation_id=$1`, [row.operation_id, formatOperationArchiveLocator({
          segmentId: segment.segmentId, operationId: row.operation_id,
        })]);
      }
    } finally {
      await isolated.runtime.pool.query('alter table operations enable trigger operations_permanent');
    }

    const genericReader = createLedgerArchiveColdReader({
      segments, objects: store, byteCeiling: 10_000_000n,
    });
    let scans = 0;
    const cold = createLedgerArchiveOperationPayloadSource({
      segments,
      purpose: 'diagnostic',
      reader: {
        async readRows(segmentId, onRow, signal) {
          scans += 1;
          return genericReader.readRows(segmentId, onRow, signal);
        },
      },
      maxCachedSegments: 1, maxRowsPerSegment: 10, maxMaterializedBytesPerSegment: 1_000_000n,
    });
    const documents = await Promise.all(operationRows.rows.map((row): Promise<OperationPayloadDocument> => {
      const facts = operationFacts(row, collectionId, segment.segmentId);
      return isolated.runtime.db.transaction().execute((transaction) => readOperationPayload(
        transaction, facts, cold,
      ));
    }));
    assert.equal(documents.length, 3);
    assert.deepEqual(documents[2]!.payloadJson, {
      big: 9007199254740991, decimal: 1, 'é': 'composed', 'é': 'decomposed', '中': '值',
    });
    assert.equal(scans, 1);

    const scansBeforePull = scans;
    await assert.rejects(
      () => isolated.runtime.db.transaction().execute((transaction) => readSyncPullRows(
        transaction, collectionId,
        { commitOrdinal: '0', streamKind: 'operation', stableId: '' }, 10,
      )),
      (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure',
    );
    assert.equal(scans, scansBeforePull, 'ordinary Pull must not call the cold source');

    const wrongScope = operationFacts(operationRows.rows[0]!, 'wrong-collection', segment.segmentId);
    await assert.rejects(
      () => isolated.runtime.db.transaction().execute((transaction) => readOperationPayload(
        transaction, wrongScope, cold,
      )),
      (error: unknown) => error instanceof OperationPayloadReadError
        && error.code === 'operation_payload_integrity_failure',
    );

    const canonicalValue = source.archiveValue(preview.rows[2]!) as Record<string, unknown>;
    const tamperedCold = createLedgerArchiveOperationPayloadSource({
      segments,
      purpose: 'diagnostic',
      reader: {
        async readRows(_segmentId, onRow) {
          await onRow({
            key: 3n,
            value: {
              ...canonicalValue,
              canonicalPayloadEnvelopeJson: String(canonicalValue.canonicalPayloadEnvelopeJson)
                .replace('"中": "值"', '"中": "錯"'),
            },
          });
        },
      },
    });
    await assert.rejects(
      () => isolated.runtime.db.transaction().execute((transaction) => readOperationPayload(
        transaction, operationFacts(operationRows.rows[2]!, collectionId, segment.segmentId),
        tamperedCold,
      )),
      (error: unknown) => error instanceof OperationPayloadReadError
        && error.code === 'operation_payload_integrity_failure',
    );
  });

  test('operation production source rejects malformed scope, absent Collection, and ordinal gaps', async () => {
    await assert.rejects(
      () => createPostgresOperationLedgerArchiveSource(isolated.runtime.db, 'global'),
      (error: unknown) => error instanceof LedgerArchiveProductionSourceError
        && error.stableCode === 'archive_source_scope_invalid',
    );
    await assert.rejects(
      () => createPostgresOperationLedgerArchiveSource(isolated.runtime.db, 'collection:absent'),
      (error: unknown) => error instanceof LedgerArchiveProductionSourceError
        && error.stableCode === 'archive_source_collection_not_found',
    );
    const collectionId = `gap-collection-${randomUUID()}`;
    await seedCollection(isolated, collectionId, `gap-root-${randomUUID()}`);
    for (const ordinal of [1n, 3n]) {
      const operationId = `gap-operation-${ordinal}-${randomUUID()}`;
      await reserveOperation(isolated, operationId);
      await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(transaction, {
        operationId, collectionId, commitOrdinal: ordinal, operationType: 'gap',
        payloadJson: { ordinal: ordinal.toString() }, actorPrincipalId: null,
      }));
    }
    const source = await createPostgresOperationLedgerArchiveSource(
      isolated.runtime.db, `collection:${collectionId}`,
    );
    await assert.rejects(
      () => source.readPage({ bounds: { lowerInclusive: 1n, upperExclusive: 4n }, limit: 10 }),
      (error: unknown) => error instanceof LedgerArchiveProductionSourceError
        && error.stableCode === 'archive_source_operation_range_not_dense',
    );
  });

  test('exports global audit event ids and injects cold reader without deleting the hot row', async () => {
    const eventId = await isolated.runtime.db.transaction().execute((transaction) => appendAuditEvent(transaction, {
      operationId: null, collectionId: null, principalId: 'archive-auditor',
      eventType: 'audit.archive.production', details: { retained: true, nested: { z: 2, a: 1 } },
      createdAt: new Date('2026-08-30T04:00:00.000Z'),
    }));
    const registry = await createPostgresLedgerArchiveSourceRegistry(isolated.runtime.db);
    assert.equal(registry.require('audit_payload').sourceScope, 'global');
    const source = createPostgresAuditPayloadLedgerArchiveSource(isolated.runtime.db);
    const segments = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    const store = createFilesystemLedgerArchiveObjectStore({
      rootDirectory: objectRoot, kmsKeyId: 'dev:audit-production-source',
    });
    let segment = await createLedgerArchiveExporter({
      segments, objects: store, spoolDirectory: join(objectRoot, 'spool'), pageSize: 1,
    }).export({
      segmentId: randomUUID(), source, lowerInclusive: eventId, upperExclusive: eventId + 1n,
      kmsKeyId: 'dev:audit-production-source',
    });
    segment = await segments.transition({
      segmentId: segment.segmentId, expectedState: 'verified', expectedRevision: segment.stateRevision,
      targetState: 'reader_cutover', evidence: { test: true },
    });
    const genericReader = createLedgerArchiveColdReader({
      segments, objects: store, byteCeiling: 10_000_000n,
    });
    const cold = createLedgerArchiveAuditPayloadColdSource({ segments, reader: genericReader });

    // Select cold via the immutable header, but deliberately retain the hot row as rollback evidence.
    await isolated.runtime.pool.query('alter table audit_events disable trigger audit_events_update_guard');
    try {
      await isolated.runtime.pool.query(`update audit_events set hot_payload_id=null,
          payload_archive_segment_id=$2,payload_bucket_locator=$3 where id=$1`, [
        eventId.toString(), segment.segmentId, formatAuditPayloadArchiveLocator({
          segmentId: segment.segmentId, eventId,
        }),
      ]);
    } finally {
      await isolated.runtime.pool.query('alter table audit_events enable trigger audit_events_update_guard');
    }
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from audit_event_payloads where event_id=$1', [eventId.toString()],
    )).rows[0]!.count, 1);
    const record = await createPostgresAuditPayloadReader(isolated.runtime.db, cold).read(eventId);
    assert.deepEqual(record.details, { nested: { a: 1, z: 2 }, retained: true });

    await assert.rejects(
      () => createPostgresAuditPayloadReader(isolated.runtime.db, {
        read: async () => null,
      }).read(eventId),
      (error: unknown) => error instanceof AuditPayloadReadError && error.code === 'archive_unavailable',
    );
  });
});

function operationFacts(
  row: {
    operation_id: string; commit_ordinal: string; payload_digest_sha256: string;
    payload_bytes: string; payload_bucket: string; sync_wire_present: boolean;
  },
  collectionId: string,
  segmentId: string,
): OperationPayloadFacts {
  return Object.freeze({
    operationId: row.operation_id, collectionId, commitOrdinal: BigInt(row.commit_ordinal),
    source: 'archive', locator: formatOperationArchiveLocator({
      segmentId, operationId: row.operation_id,
    }),
    digestSha256: row.payload_digest_sha256, byteCount: BigInt(row.payload_bytes),
    schemaVersion: 1, bucket: row.payload_bucket, syncWirePresent: row.sync_wire_present,
  });
}

async function seedCollection(
  isolated: IsolatedPostgresRuntime,
  collectionId: string,
  rootId: string,
): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into resource_id_ledger(resource_id,resource_type)
      values($1,'collection'),($2,'node')`, [collectionId, rootId]);
    await client.query(`insert into collections(id,owner_subject_id,title,kind,
      root_node_id,resource_revision,content_revision,policy_revision)
      values($1,'archive-owner','Archive','bookmarks',$2,'r1','c1','p1')`, [collectionId, rootId]);
    await client.query(`insert into nodes(id,collection_id,kind,is_root,title,
      resource_revision,children_revision) values($1,$2,'folder',true,'Root','r1','ch1')`,
    [rootId, collectionId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function reserveOperation(isolated: IsolatedPostgresRuntime, operationId: string): Promise<void> {
  await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
    values($1,'operation')`, [operationId]);
}

async function appendRawCanonicalOperation(
  isolated: IsolatedPostgresRuntime,
  input: Readonly<{
    operationId: string; collectionId: string; commitOrdinal: bigint;
    payloadJson: string; syncWireJson: string;
  }>,
): Promise<void> {
  await reserveOperation(isolated, input.operationId);
  await isolated.runtime.pool.query(`WITH supplied AS (
      SELECT $1::text operation_id,$2::text collection_id,$3::bigint commit_ordinal,
        $4::jsonb payload_json,$5::jsonb sync_wire_json,
        '2026-08-30T03:00:00.000Z'::timestamptz created_at
    ), materialized AS (
      SELECT supplied.*,
        date_trunc('month',created_at AT TIME ZONE 'UTC')::date payload_bucket,
        operation_payload_sha256(payload_json,sync_wire_json) digest,
        octet_length(operation_payload_canonical_bytes(payload_json,sync_wire_json))::bigint bytes
      FROM supplied
    ), inserted_fact AS (
      INSERT INTO operations(operation_id,collection_id,commit_ordinal,operation_type,
        actor_principal_id,created_at,payload_source,payload_locator,payload_digest_sha256,
        payload_bytes,payload_schema_version,payload_bucket,sync_wire_present)
      SELECT operation_id,collection_id,commit_ordinal,'sync.test',null,created_at,'hot',
        'operation_payloads/'||payload_bucket::text||'/'||operation_id,digest,bytes,1,
        payload_bucket,true FROM materialized RETURNING operation_id
    ) INSERT INTO operation_payloads(operation_id,collection_id,commit_ordinal,payload_bucket,
      payload_schema_version,payload_json,sync_wire_json,canonical_digest_sha256,canonical_bytes,created_at)
      SELECT materialized.operation_id,collection_id,commit_ordinal,payload_bucket,1,payload_json,
        sync_wire_json,digest,bytes,created_at FROM materialized JOIN inserted_fact USING(operation_id)`, [
    input.operationId, input.collectionId, input.commitOrdinal.toString(), input.payloadJson, input.syncWireJson,
  ]);
}
