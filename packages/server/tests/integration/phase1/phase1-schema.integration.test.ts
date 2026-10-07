import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import { createIsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'kysely';
import {
  appendAuditEvent,
  appendOperationWithPayload,
  createDatabaseRuntime,
  runMigrations,
  type DatabaseRuntime,
} from '../../../src/infrastructure/database/index.js';
import { insertTestAuditEvent, insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';
import {
  productionMigrationNamesFromInclusive,
  productionMigrationNamesNewestFirstUntil,
} from '../../../scripts/lexical-migration-head.mjs';

describeWithPostgres('Phase 1 authoritative PostgreSQL schema', () => {
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `phase1_${randomUUID().replaceAll('-', '_')}`;
  let admin: Pool;
  let runtime: DatabaseRuntime;
  let url: string;

  beforeAll(async () => {
    assert.ok(databaseUrl, 'KNOWN_TEST_DATABASE_URL or DATABASE_URL is required');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema ${schema}`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    url = isolated.toString();
    runtime = createDatabaseRuntime(url, { maxConnections: 2, applicationName: 'known-phase1-schema-test' });
    await runMigrations(runtime.db, 'latest');
  });

  afterAll(async () => {
    await runtime?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  async function reserveResources(...resources: ReadonlyArray<readonly [id: string, type: string]>) {
    await runtime.pool.query(
      'insert into resource_id_ledger (resource_id, resource_type) select * from unnest($1::text[], $2::text[])',
      [resources.map(([id]) => id), resources.map(([, type]) => type)],
    );
  }

  async function bootstrap(collectionId = 'collection-1', rootId = 'root-1') {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into resource_id_ledger (resource_id, resource_type) values ($1, $2), ($3, $4)', [collectionId, 'collection', rootId, 'node']);
      await client.query('insert into collections (id, owner_subject_id, title, kind, root_node_id, resource_revision, content_revision, policy_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', [collectionId, 'owner-1', 'Collection', 'bookmarks', rootId, 'r1', 'c1', 'p1']);
      await client.query('insert into nodes (id, collection_id, kind, is_root, title, resource_revision, children_revision) values ($1, $2, $3, true, $4, $5, $6)', [rootId, collectionId, 'folder', 'Root', 'r1', 'ch1']);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  test('creates the authoritative table set and no future workflow tables', async () => {
    const result = await runtime.pool.query<{ relname: string }>("select relname from pg_class where relkind = 'r' and relnamespace = current_schema()::regnamespace order by relname");
    const names = new Set(result.rows.map((row) => row.relname));
    for (const table of ['accounts', 'profiles', 'sessions', 'resource_id_ledger', 'collections', 'nodes', 'collection_members', 'collection_policies', 'resource_revisions', 'children_revisions', 'policy_revisions', 'operations', 'audit_events', 'outbox_events', 'product_command_receipts', 'attachments']) assert.ok(names.has(table), table);
    for (const table of ['publications', 'subscriptions', 'search_documents']) assert.ok(!names.has(table), table);
  });

  test('enforces one live root, collection-scoped parent and sibling position uniqueness', async () => {
    await bootstrap();
    await reserveResources(['root-2', 'node']);
    await assert.rejects(runtime.pool.query('insert into nodes (id, collection_id, kind, is_root, title, resource_revision, children_revision) values ($1, $2, $3, true, $4, $5, $6)', ['root-2', 'collection-1', 'folder', 'Root 2', 'r2', 'ch2']), /unique|duplicate/i);
    await bootstrap('collection-2', 'folder-2');
    await reserveResources(['collection-3', 'collection']);
    await assert.rejects(runtime.pool.query('insert into collections (id, owner_subject_id, title, kind, root_node_id, resource_revision, content_revision, policy_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['collection-3', 'owner-3', 'Collection 3', 'bookmarks', 'folder-2', 'r1', 'c1', 'p1']), /foreign key|violates/i);
    await reserveResources(['node-1', 'node'], ['node-2', 'node'], ['node-3', 'node']);
    await runtime.pool.query('insert into nodes (id, collection_id, kind, title, url, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', ['node-1', 'collection-1', 'bookmark', 'N1', 'https://example.test/1', 'root-1', 'A', 'r1', 'ch1']);
    await assert.rejects(runtime.pool.query('insert into nodes (id, collection_id, kind, title, url, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', ['node-2', 'collection-1', 'bookmark', 'N2', 'https://example.test/2', 'root-1', 'A', 'r1', 'ch1']), /unique|duplicate/i);
    await assert.rejects(runtime.pool.query('insert into nodes (id, collection_id, kind, title, url, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', ['node-3', 'collection-1', 'bookmark', 'N3', 'https://example.test/3', 'folder-2', 'B', 'r1', 'ch1']), /foreign key|violates/i);
  });

  test('requires folder parents and protocol-safe position tokens', async () => {
    await bootstrap('collection-node-rules', 'root-node-rules');
    await reserveResources(
      ['bookmark-parent', 'node'],
      ['child-of-bookmark', 'node'],
      ['position-empty', 'node'],
      ['position-illegal', 'node'],
      ['position-max', 'node'],
      ['position-long', 'node'],
    );
    await runtime.pool.query('insert into nodes (id, collection_id, kind, title, url, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', ['bookmark-parent', 'collection-node-rules', 'bookmark', 'Parent bookmark', 'https://example.test/parent', 'root-node-rules', 'A', 'r1', 'ch1']);
    await runtime.pool.query('insert into nodes (id, collection_id, kind, title, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['position-max', 'collection-node-rules', 'folder', 'Maximum position', 'root-node-rules', 'A'.repeat(128), 'r1', 'ch1']);
    await assert.rejects(
      runtime.pool.query('insert into nodes (id, collection_id, kind, title, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['child-of-bookmark', 'collection-node-rules', 'folder', 'Child', 'bookmark-parent', 'B', 'r1', 'ch1']),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    for (const [id, position] of [
      ['position-empty', ''],
      ['position-illegal', 'bad space'],
      ['position-long', 'A'.repeat(129)],
    ] as const) {
      await assert.rejects(
        runtime.pool.query('insert into nodes (id, collection_id, kind, title, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', [id, 'collection-node-rules', 'folder', id, 'root-node-rules', position, 'r1', 'ch1']),
        /check|violates/i,
      );
    }
  });

  test('keeps resource IDs reserved and validates revisions and ordinals', async () => {
    await bootstrap('collection-revision', 'root-revision');
    await assert.rejects(runtime.pool.query('insert into resource_id_ledger (resource_id, resource_type) values ($1, $2)', ['collection-revision', 'node']), /unique|duplicate/i);
    await assert.rejects(runtime.pool.query('update resource_id_ledger set resource_type = $2 where resource_id = $1', ['root-revision', 'retired-node']), /immutable/i);
    await assert.rejects(runtime.pool.query('delete from resource_id_ledger where resource_id = $1', ['root-revision']), /immutable/i);
    await assert.rejects(runtime.pool.query('update nodes set deleted_at = now() where id = $1', ['root-revision']), /root|check|violates/i);
    await assert.rejects(runtime.pool.query('insert into resource_id_ledger (resource_id, resource_type) values ($1, $2)', ['root-revision', 'node']), /unique|duplicate/i);
    await assert.rejects(runtime.pool.query('insert into resource_revisions (collection_id, resource_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-revision', 'root-revision', '', 1]), /check|violates/i);
    await assert.rejects(runtime.pool.query('insert into resource_revisions (collection_id, resource_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-revision', 'root-revision', 'bad space', 1]), /check|violates/i);
    await assert.rejects(runtime.pool.query('insert into resource_revisions (collection_id, resource_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-revision', 'root-revision', 'r1', 0]), /check|violates/i);
    await assert.rejects(runtime.pool.query('update collections set commit_ordinal = $2 where id = $1', ['collection-revision', -1]), /check|violates/i);
  });

  test('prevents replacing a collection root and invalidating a live parent', async () => {
    await bootstrap('collection-lifecycle', 'root-lifecycle');
    await reserveResources(['parent-lifecycle', 'node'], ['child-lifecycle', 'node']);
    await runtime.pool.query('insert into nodes (id, collection_id, kind, title, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['parent-lifecycle', 'collection-lifecycle', 'folder', 'Parent', 'root-lifecycle', 'A', 'r1', 'ch1']);
    await runtime.pool.query('insert into nodes (id, collection_id, kind, title, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['child-lifecycle', 'collection-lifecycle', 'folder', 'Child', 'parent-lifecycle', 'A', 'r1', 'ch1']);

    await assert.rejects(
      runtime.pool.query('update collections set root_node_id = $2 where id = $1', ['collection-lifecycle', 'parent-lifecycle']),
      /foreign key|root|violates/i,
    );
    await assert.rejects(
      runtime.pool.query("update nodes set kind = 'bookmark', url = 'https://example.test/parent' where id = $1", ['parent-lifecycle']),
      /parent|child|check|violates/i,
    );
    await assert.rejects(
      runtime.pool.query('update nodes set deleted_at = now(), deleted_commit_ordinal = 1 where id = $1', ['parent-lifecycle']),
      /parent|child|check|violates/i,
    );
  });

  test('enforces operation ordinals and children revision parent domain', async () => {
    await bootstrap('collection-ordinal', 'root-ordinal');
    await bootstrap('collection-other-domain', 'root-other-domain');
    await reserveResources(['operation-ordinal-1', 'operation'], ['operation-ordinal-2', 'operation']);
    await insertTestOperation(runtime.db, {
      operationId: 'operation-ordinal-1', collectionId: 'collection-ordinal',
      commitOrdinal: 1n, operationType: 'create', payloadJson: {}, actorPrincipalId: null,
    });
    await assert.rejects(
      insertTestOperation(runtime.db, {
        operationId: 'operation-ordinal-2', collectionId: 'collection-ordinal',
        commitOrdinal: 1n, operationType: 'update', payloadJson: {}, actorPrincipalId: null,
      }),
      /unique|duplicate/i,
    );
    await assert.rejects(
      runtime.pool.query('insert into children_revisions (collection_id, parent_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-ordinal', 'root-other-domain', 'ch-cross-domain', 1]),
      /foreign key|violates/i,
    );
  });

  test('allocates revision ordinals per resource while isolating collections', async () => {
    await bootstrap('collection-resource-ordinal', 'root-resource-ordinal');
    await bootstrap('collection-resource-other', 'root-resource-other');
    await reserveResources(['resource-ordinal-child', 'node']);
    await runtime.pool.query('insert into nodes (id, collection_id, kind, title, parent_id, position_token, resource_revision, children_revision) values ($1, $2, $3, $4, $5, $6, $7, $8)', ['resource-ordinal-child', 'collection-resource-ordinal', 'folder', 'Child', 'root-resource-ordinal', 'A', 'r1', 'ch1']);
    await runtime.pool.query('insert into resource_revisions (collection_id, resource_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-resource-ordinal', 'root-resource-ordinal', 'root-r10', 10]);
    await runtime.pool.query('insert into resource_revisions (collection_id, resource_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-resource-ordinal', 'resource-ordinal-child', 'child-r10', 10]);
    await assert.rejects(
      runtime.pool.query('insert into resource_revisions (collection_id, resource_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-resource-ordinal', 'resource-ordinal-child', 'child-r11', 10]),
      (error: unknown) => (error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'resource_revisions_resource_ordinal_unique',
    );
    await runtime.pool.query('insert into resource_revisions (collection_id, resource_id, revision, ordinal) values ($1, $2, $3, $4)', ['collection-resource-other', 'root-resource-other', 'other-r10', 10]);
  });

  test('binds audit operation and collection as one foreign-key identity', async () => {
    await bootstrap('collection-audit', 'root-audit');
    await reserveResources(['operation-audit', 'operation']);
    await insertTestOperation(runtime.db, {
      operationId: 'operation-audit', collectionId: 'collection-audit',
      commitOrdinal: 1n, operationType: 'create', payloadJson: {}, actorPrincipalId: null,
    });
    await assert.rejects(
      insertTestAuditEvent(runtime.db, {
        operationId: 'operation-audit', collectionId: 'wrong-collection',
        principalId: null, eventType: 'create', details: {},
      }),
      (error: unknown) => (error as { code?: string; constraint?: string }).code === '23503' && (error as { constraint?: string }).constraint === 'audit_events_operation_collection_fk',
    );
  });

  test('makes command receipt binding the sole winner and rolls back all ledger writes atomically', async () => {
    await bootstrap('collection-transaction', 'root-transaction');
    const commandId = '00000000-0000-4000-8000-000000000001';
    const rollbackCommandId = '00000000-0000-4000-8000-000000000002';
    const base = ['principal-1', 'collection:collection-transaction', commandId, 'fp-1'];
    await runtime.pool.query('insert into product_command_receipts (principal_id, command_scope, command_id, request_fingerprint) values ($1, $2, $3, $4)', base);
    await assert.rejects(runtime.pool.query('insert into product_command_receipts (principal_id, command_scope, command_id, request_fingerprint) values ($1, $2, $3, $4)', [...base.slice(0, 3), 'fp-2']), /unique|duplicate/i);
    await runtime.pool.query('insert into product_command_receipts (principal_id, command_scope, command_id, request_fingerprint) values ($1, $2, $3, $4)', ['principal-2', base[1], base[2], 'fp-principal-isolated']);
    await runtime.pool.query('insert into product_command_receipts (principal_id, command_scope, command_id, request_fingerprint) values ($1, $2, $3, $4)', [base[0], 'collection:another', base[2], 'fp-scope-isolated']);
    const isolatedBindings = await runtime.pool.query('select 1 from product_command_receipts where command_id = $1', [base[2]]);
    assert.equal(isolatedBindings.rowCount, 3);
    try {
      await runtime.db.transaction().execute(async (transaction) => {
        await sql`insert into resource_id_ledger (resource_id, resource_type) values
          ('op-rollback', 'operation'), ('ob-rollback', 'outbox'), ('event-rollback', 'domain-event')`.execute(transaction);
        await appendOperationWithPayload(transaction, {
          operationId: 'op-rollback', collectionId: 'collection-transaction',
          commitOrdinal: 1n, operationType: 'create', payloadJson: {}, actorPrincipalId: null,
        });
        await appendAuditEvent(transaction, {
          operationId: 'op-rollback', collectionId: 'collection-transaction',
          principalId: null, eventType: 'create', details: {},
        });
        await sql`insert into outbox_events
          (outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
           aggregate_type, aggregate_id, occurred_at)
          values ('ob-rollback', 'event-rollback', 'collection.created', 1, 'test', 'delivery_each_event',
            'collection', 'collection-transaction', current_timestamp)`.execute(transaction);
        await sql`insert into product_command_receipts (principal_id, command_scope, command_id, request_fingerprint)
          values ('principal-rollback', 'collection:collection-transaction', ${rollbackCommandId}, 'fp')`.execute(transaction);
        throw new Error('force rollback after all authoritative writes succeed');
      });
    } catch (error: unknown) {
      assert.match(error instanceof Error ? error.message : String(error), /force rollback/);
    }
    for (const [table, column, value] of [['resource_id_ledger', 'resource_id', 'op-rollback'], ['resource_id_ledger', 'resource_id', 'ob-rollback'], ['resource_id_ledger', 'resource_id', 'event-rollback'], ['operations', 'operation_id', 'op-rollback'], ['audit_events', 'operation_id', 'op-rollback'], ['outbox_events', 'outbox_id', 'ob-rollback'], ['product_command_receipts', 'command_id', rollbackCommandId]] as const) {
      const row = await runtime.pool.query(`select 1 from ${table} where ${column} = $1`, [value]);
      assert.equal(row.rowCount, 0, `${table} leaked a rolled-back row`);
    }
  });

  test('rolls the production migration down and back up in sortable order', async () => {
    const rollback = await createIsolatedPostgresRuntime('phase1_historical_rollback');
    try {
    const historical = createHistoricalMigrator(rollback, '202607221500_product_command_receipt_hardening');
    const initial = await historical.migrateToLatest();
    if (initial.error) throw initial.error;
    const downNames: string[] = [];
    let downResult;
    do {
      downResult = await runMigrations(rollback.runtime.db, 'down');
      downNames.push(...downResult.results.map((result) => result.migrationName));
      assert.ok(downResult.results.every((result) => result.status === 'Success'));
    } while (!downNames.includes('202607220900_phase1_schema'));
    // Newest → oldest; keep in lockstep with migrations/ production expand chain.
    assert.deepEqual(downNames, productionMigrationNamesNewestFirstUntil('202607220900_phase1_schema').filter(name => name <= '202607221500_product_command_receipt_hardening'));
    const removed = await rollback.runtime.pool.query<{ table_name: string | null }>("select to_regclass('collections')::text as table_name");
    assert.equal(removed.rows[0]?.table_name, null);

    const up = await runMigrations(rollback.runtime.db, 'latest');
    assert.deepEqual(up.results.map((result) => result.migrationName), productionMigrationNamesFromInclusive('202607220900_phase1_schema'));
    assert.ok(up.results.every((result) => result.status === 'Success'));
    } finally { await rollback.close(); }
  }, 180_000);
});
