import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  appendOperationWithPayload,
  createMigrator,
  OperationPayloadReadError,
  readOperationPayload,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const BEFORE_SPLIT = '202610010400_sync_history_floors';
const BEFORE_LOOKUP_FACTS = '202610010900_ledger_archive_runtime';

describeWithPostgres('Operation fact and payload split', () => {
  let isolated: IsolatedPostgresRuntime;
  const collectionId = 'operation-payload-collection';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('operation_payload_split');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollection(isolated, collectionId, 'operation-payload-root');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('atomic writer stores permanent facts and canonical envelope metadata', async () => {
    await reserveOperation(isolated, 'operation-payload-one');
    await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(transaction, {
      operationId: 'operation-payload-one', collectionId, commitOrdinal: 1n,
      operationType: 'sync.test', payloadJson: { z: 1, a: '中' },
      syncWireJson: { opId: 'operation-payload-one', collectionId },
      actorPrincipalId: 'actor', createdAt: new Date('2026-08-30T02:00:00.000Z'),
    }));
    const row = (await isolated.runtime.pool.query<{
      payload_source: string; payload_locator: string; payload_digest_sha256: string;
      payload_bytes: string; calculated_digest: string; calculated_bytes: string;
    }>(`select operation.payload_source,operation.payload_locator,
        operation.payload_digest_sha256,operation.payload_bytes::text,
        operation_payload_sha256(payload.payload_json,payload.sync_wire_json) calculated_digest,
        octet_length(operation_payload_canonical_bytes(
          payload.payload_json,payload.sync_wire_json))::text calculated_bytes
      from operations operation join operation_payloads payload using(operation_id)
      where operation.operation_id=$1`, ['operation-payload-one'])).rows[0]!;
    assert.equal(row.payload_source, 'hot');
    assert.match(row.payload_locator, /^operation_payloads\/2026-08-01\//u);
    assert.equal(row.payload_digest_sha256, row.calculated_digest);
    assert.equal(row.payload_bytes, row.calculated_bytes);
    const columns = (await isolated.runtime.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema=current_schema() and table_name='operations'`,
    )).rows.map(({ column_name }) => column_name);
    assert.equal(columns.includes('payload_json'), false);
    assert.equal(columns.includes('sync_wire_json'), false);
  });

  test('deferred exact-one, FK binding, and immutable payload guards fail closed', async () => {
    await reserveOperation(isolated, 'operation-payload-orphan');
    await assert.rejects(() => isolated.runtime.pool.query(`insert into operations(
      operation_id,collection_id,commit_ordinal,operation_type,actor_principal_id,
      payload_source,payload_locator,payload_digest_sha256,payload_bytes,
      payload_schema_version,payload_bucket,sync_wire_present)
      values($1,$2,2,'test',null,'hot',$3,$4,1,1,'2026-08-01',false)`,
    ['operation-payload-orphan', collectionId,
      'operation_payloads/2026-08-01/operation-payload-orphan', '0'.repeat(64)]),
    (error: unknown) => (error as { constraint?: string }).constraint === 'operations_hot_payload_required');

    for (const statement of [
      `update operation_payloads set payload_json='{}' where operation_id='operation-payload-one'`,
      `delete from operation_payloads where operation_id='operation-payload-one'`,
      'truncate operation_payloads',
      `delete from operations where operation_id='operation-payload-one'`,
    ]) {
      await assert.rejects(() => isolated.runtime.pool.query(statement),
        (error: unknown) => (error as { code?: string }).code === '23514');
    }
  });

  test('archive locator contract reports unavailable and never fabricates JSON', async () => {
    const facts = await isolated.runtime.db.transaction().execute(async (transaction) => {
      const operation = await transaction.selectFrom('operations').selectAll()
        .where('operation_id', '=', 'operation-payload-one').executeTakeFirstOrThrow();
      return {
        operationId: operation.operation_id, collectionId: operation.collection_id,
        commitOrdinal: BigInt(operation.commit_ordinal), source: 'archive' as const,
        locator: 'archive://operation-payload-one', digestSha256: operation.payload_digest_sha256,
        byteCount: BigInt(operation.payload_bytes), schemaVersion: 1 as const,
        bucket: operation.payload_bucket instanceof Date
          ? operation.payload_bucket.toISOString().slice(0, 10) : String(operation.payload_bucket),
        syncWirePresent: operation.sync_wire_present,
      };
    });
    await assert.rejects(
      () => isolated.runtime.db.transaction().execute((transaction) =>
        readOperationPayload(transaction, facts)),
      (error: unknown) => error instanceof OperationPayloadReadError
        && error.code === 'operation_payload_unavailable',
    );
  });
});

describeWithPostgres('Operation payload split upgrade rollback', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('operation_payload_upgrade'); }, 120_000);
  afterAll(async () => isolated?.close());

  test('backfills one verified payload per Operation and survives down/up', async () => {
    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const before = await migrator.migrateTo(BEFORE_SPLIT); if (before.error) throw before.error;
    await seedCollection(isolated, 'upgrade-collection', 'upgrade-root');
    await reserveOperation(isolated, 'upgrade-operation');
    await isolated.runtime.pool.query(`insert into operations(operation_id,collection_id,
      commit_ordinal,operation_type,payload_json,sync_wire_json,created_at)
      values('upgrade-operation','upgrade-collection',1,'upgrade','{"b":2,"a":1}',
        '{"opId":"upgrade-operation"}','2026-08-30T03:00:00Z')`);
    const up = await migrator.migrateTo('202610010500_operation_payload_split'); if (up.error) throw up.error;
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from operation_payloads',
    )).rows[0]!.count, 1);
    const down = await migrator.migrateDown(); if (down.error) throw down.error;
    assert.deepEqual((await isolated.runtime.pool.query(
      `select payload_json from operations where operation_id='upgrade-operation'`,
    )).rows[0]!.payload_json, { a: 1, b: 2 });
    const upAgain = await migrator.migrateUp(); if (upAgain.error) throw upAgain.error;
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from operation_payloads',
    )).rows[0]!.count, 1);
  });
});

describeWithPostgres('permanent Operation lookup facts', () => {
  let isolated: IsolatedPostgresRuntime;
  const lookupCollectionId = 'operation-lookup-collection';

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('operation_lookup_facts');
    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const before = await migrator.migrateTo(BEFORE_LOOKUP_FACTS); if (before.error) throw before.error;
    await seedCollection(isolated, lookupCollectionId, 'operation-lookup-root');
    await reserveOperation(isolated, 'operation-lookup-backfill');
    await insertPreLookupOperation(isolated, {
      operationId: 'operation-lookup-backfill', collectionId: lookupCollectionId,
      commitOrdinal: 1n, operationType: 'attachment.finalized',
      payload: { commandId: 'command-backfill', attachmentId: 'attachment-backfill', blobId: 'blob-backfill' },
    });
    const up = await migrator.migrateUp(); if (up.error) throw up.error;
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('backfills exact facts and atomically materializes new writes', async () => {
    assert.deepEqual((await isolated.runtime.pool.query(
      `select operation_id,collection_id,commit_ordinal::text,operation_type,
        command_id,attachment_id,blob_id from operation_lookup_facts order by commit_ordinal`,
    )).rows, [{
      operation_id: 'operation-lookup-backfill', collection_id: lookupCollectionId,
      commit_ordinal: '1', operation_type: 'attachment.finalized',
      command_id: 'command-backfill', attachment_id: 'attachment-backfill', blob_id: 'blob-backfill',
    }]);

    await reserveOperation(isolated, 'operation-lookup-new');
    await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(transaction, {
      operationId: 'operation-lookup-new', collectionId: lookupCollectionId, commitOrdinal: 2n,
      operationType: 'attachment.retired', payloadJson: {
        commandId: 'command-new', attachmentId: 'attachment-backfill', blobId: 'blob-backfill',
      }, actorPrincipalId: null,
    }));
    assert.equal((await isolated.runtime.pool.query(
      `select count(*)::int count from operation_lookup_facts where operation_id='operation-lookup-new'`,
    )).rows[0]!.count, 1);
  });

  test('rejects malformed fields, command rebinding, and attachment rebinding atomically', async () => {
    await reserveOperation(isolated, 'operation-lookup-malformed');
    await assert.rejects(() => isolated.runtime.db.transaction().execute((transaction) =>
      appendOperationWithPayload(transaction, {
        operationId: 'operation-lookup-malformed', collectionId: lookupCollectionId,
        commitOrdinal: 3n, operationType: 'attachment.finalized',
        payloadJson: { commandId: 'malformed-command', blobId: 'malformed-blob' },
        actorPrincipalId: null,
      })), (error: unknown) => (error as { constraint?: string }).constraint ===
        'operation_lookup_facts_payload_shape');

    await reserveOperation(isolated, 'operation-lookup-command-duplicate');
    await assert.rejects(() => isolated.runtime.db.transaction().execute((transaction) =>
      appendOperationWithPayload(transaction, {
        operationId: 'operation-lookup-command-duplicate', collectionId: lookupCollectionId,
        commitOrdinal: 3n, operationType: 'attachment.finalized', payloadJson: {
          commandId: 'command-backfill', attachmentId: 'attachment-other', blobId: 'blob-other',
        }, actorPrincipalId: null,
      })), (error: unknown) => (error as { constraint?: string }).constraint ===
        'operation_lookup_facts_command_unique');

    await reserveOperation(isolated, 'operation-lookup-attachment-duplicate');
    await assert.rejects(() => isolated.runtime.db.transaction().execute((transaction) =>
      appendOperationWithPayload(transaction, {
        operationId: 'operation-lookup-attachment-duplicate', collectionId: lookupCollectionId,
        commitOrdinal: 3n, operationType: 'attachment.finalized', payloadJson: {
          commandId: 'command-other', attachmentId: 'attachment-backfill', blobId: 'blob-other',
        }, actorPrincipalId: null,
      })), (error: unknown) => (error as { constraint?: string }).constraint ===
        'operation_lookup_facts_attachment_unique');

    assert.equal((await isolated.runtime.pool.query(`select count(*)::int count from operations
      where operation_id like 'operation-lookup-%duplicate' or operation_id='operation-lookup-malformed'`))
      .rows[0]!.count, 0);
  });

  test('rejects UPDATE, DELETE, and TRUNCATE and supports exact hot down/up reconstruction', async () => {
    for (const statement of [
      `update operation_lookup_facts set command_id='changed' where operation_id='operation-lookup-backfill'`,
      `delete from operation_lookup_facts where operation_id='operation-lookup-backfill'`,
      'truncate operation_lookup_facts',
    ]) {
      await assert.rejects(() => isolated.runtime.pool.query(statement),
        (error: unknown) => (error as { constraint?: string }).constraint ===
          'operation_lookup_facts_immutable');
    }

    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const down = await migrator.migrateDown(); if (down.error) throw down.error;
    assert.equal((await isolated.runtime.pool.query(`select to_regclass('operation_lookup_facts') name`))
      .rows[0]!.name, null);
    const up = await migrator.migrateUp(); if (up.error) throw up.error;
    assert.equal((await isolated.runtime.pool.query(
      'select count(*)::int count from operation_lookup_facts',
    )).rows[0]!.count, 2);
  });
});

describeWithPostgres('Operation lookup fact rollback safety', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('operation_lookup_down_guard');
    const setup = await createHistoricalMigrator(isolated, '202610011000_operation_lookup_facts').migrateToLatest();
    if (setup.error) throw setup.error;
    await seedCollection(isolated, 'lookup-down-collection', 'lookup-down-root');
    await reserveOperation(isolated, 'lookup-down-operation');
    await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(transaction, {
      operationId: 'lookup-down-operation', collectionId: 'lookup-down-collection', commitOrdinal: 1n,
      operationType: 'attachment.finalized', payloadJson: {
        commandId: 'lookup-down-command', attachmentId: 'lookup-down-attachment', blobId: 'lookup-down-blob',
      }, actorPrincipalId: null,
    }));
    await isolated.runtime.pool.query(
      'alter table operation_payloads disable trigger operation_payloads_immutable',
    );
    await isolated.runtime.pool.query(
      `delete from operation_payloads where operation_id='lookup-down-operation'`,
    );
    await isolated.runtime.pool.query(
      'alter table operation_payloads enable trigger operation_payloads_immutable',
    );
  }, 120_000);
  afterAll(async () => isolated?.close());

  test('development down refuses when a recognized hot payload is missing', async () => {
    const migrator = createMigrator(isolated.runtime.db, undefined, isolated.schema);
    const down = await migrator.migrateTo(BEFORE_LOOKUP_FACTS);
    assert.ok(down.error);
    assert.match(String(down.error), /hot payload reconstruction is incomplete/iu);
    assert.equal((await isolated.runtime.pool.query(`select to_regclass('operation_lookup_facts') name`))
      .rows[0]!.name, 'operation_lookup_facts');
  });
});

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
      values($1,'operation-payload-owner','Payload','bookmarks',$2,'r1','c1','p1')`,
    [collectionId, rootId]);
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

async function insertPreLookupOperation(
  isolated: IsolatedPostgresRuntime,
  input: {
    operationId: string; collectionId: string; commitOrdinal: bigint; operationType: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query(`with supplied as (select $1::text operation_id,$2::text collection_id,
        $3::bigint commit_ordinal,$4::text operation_type,$5::jsonb payload_json,
        current_timestamp created_at), materialized as (select supplied.*,
        date_trunc('month',created_at at time zone 'UTC')::date payload_bucket,
        operation_payload_sha256(payload_json,null) digest,
        octet_length(operation_payload_canonical_bytes(payload_json,null))::bigint bytes
        from supplied), inserted as (insert into operations(operation_id,collection_id,
          commit_ordinal,operation_type,actor_principal_id,created_at,payload_source,payload_locator,
          payload_digest_sha256,payload_bytes,payload_schema_version,payload_bucket,sync_wire_present)
        select operation_id,collection_id,commit_ordinal,operation_type,null,created_at,'hot',
          'operation_payloads/'||payload_bucket::text||'/'||operation_id,digest,bytes,1,payload_bucket,false
        from materialized returning operation_id)
      insert into operation_payloads(operation_id,collection_id,commit_ordinal,payload_bucket,
        payload_schema_version,payload_json,sync_wire_json,canonical_digest_sha256,canonical_bytes,created_at)
      select materialized.operation_id,collection_id,commit_ordinal,payload_bucket,1,payload_json,null,
        digest,bytes,created_at from materialized join inserted using(operation_id)`, [
      input.operationId, input.collectionId, input.commitOrdinal.toString(), input.operationType,
      JSON.stringify(input.payload),
    ]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
