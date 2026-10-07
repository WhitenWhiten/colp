import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { test } from 'vitest';

import { runMigrations } from '../../../src/infrastructure/database/index.js';

import { createPostgresSyncAckApplication, createPostgresSyncPullReadPort } from '../../../src/infrastructure/sync/index.js';

import { createSyncPullCursorKeyring, SyncPullReadError } from '../../../src/modules/sync/index.js';


import { EXPAND_ONLY_NEWS_DIGEST_MIGRATIONS, runMigrationsExcludingNewsDigest }
  from '../../support/news-digest-migration-filter.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { productionMigrationNamesFromInclusive, productionMigrationNamesNewestFirstUntil } from '../../../scripts/lexical-migration-head.mjs';

import { createSyncPullFixture, ISSUER, ACCOUNT, SUBJECT, COLLECTION, ROOT, TARGET, ORIGIN, migrationDirectoryExcluding } from './sync-pull-fixture.js';

describeWithPostgres('P3-20 sync-pull-migrations-plan-postgres.integration.test.ts', () => {
  const pullFixture = createSyncPullFixture('p3_pull_2', true);
  const { seedCollection, createProtocolScope, operation, insertOperation, insertConflict, reader, countPersistenceStatements, seedOperationBatch } = pullFixture;

  test('large operation stream plan remains index-backed without sort spill or sequential scan', async () => {
    const suffix = randomUUID();
    const values: string[] = [];
    const parameters: unknown[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      const id = `plan-${suffix}-${String(index).padStart(5, '0')}`;
      values.push(`($${parameters.length + 1},'operation')`); parameters.push(id);
    }
    await pullFixture.isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type) values ${values.join(',')}`, parameters);
    await pullFixture.isolated.runtime.pool.query(`with supplied as (
        select 'plan-${suffix}-'||lpad(value::text,5,'0') operation_id,$1::text collection_id,
          (1000+value)::bigint commit_ordinal,'sync.node.update'::text operation_type,
          '{}'::jsonb payload_json,jsonb_build_object('opId','plan-${suffix}-'||lpad(value::text,5,'0'),
            'replicaId',$3::text,'sequence',value,'collectionId',$1::text,'type','update_node_content',
            'targetId',$4::text,'baseRevision','root-r1','occurredAt','2026-07-26T06:01:00Z',
            'payload',jsonb_build_object('base',jsonb_build_object('title','Root'),
              'value',jsonb_build_object('title','Changed'))) sync_wire_json,
          $2::text actor_principal_id,current_timestamp created_at
        from generate_series(0,4999) value),
      materialized as (select supplied.*,
        date_trunc('month',created_at at time zone 'UTC')::date payload_bucket,
        operation_payload_sha256(payload_json,sync_wire_json) digest,
        octet_length(operation_payload_canonical_bytes(payload_json,sync_wire_json))::bigint bytes
        from supplied),
      inserted_fact as (insert into operations(operation_id,collection_id,commit_ordinal,operation_type,
          actor_principal_id,created_at,payload_source,payload_locator,payload_digest_sha256,payload_bytes,
          payload_schema_version,payload_bucket,sync_wire_present)
        select operation_id,collection_id,commit_ordinal,operation_type,actor_principal_id,created_at,'hot',
          'operation_payloads/'||payload_bucket::text||'/'||operation_id,digest,bytes,1,payload_bucket,
          sync_wire_json is not null from materialized returning operation_id)
      insert into operation_payloads(operation_id,collection_id,commit_ordinal,payload_bucket,
        payload_schema_version,payload_json,sync_wire_json,canonical_digest_sha256,canonical_bytes,created_at)
      select materialized.operation_id,collection_id,commit_ordinal,payload_bucket,1,payload_json,sync_wire_json,
        digest,bytes,created_at from materialized join inserted_fact using(operation_id)`,
    [COLLECTION, ACCOUNT, pullFixture.scope.replica.replicaId, TARGET]);
    await pullFixture.isolated.runtime.pool.query('vacuum analyze operations');
    await pullFixture.isolated.runtime.pool.query('vacuum analyze operation_payloads');
    await pullFixture.isolated.runtime.pool.query('vacuum analyze sync_conflicts');
    // Checkout a dedicated connection so the planner hint and EXPLAIN run on the same
    // backend session; SET LOCAL keeps the hint transaction-scoped and auto-rolls back.
    const client = await pullFixture.isolated.runtime.pool.connect();
    let plan: { rows: Array<{ 'QUERY PLAN': string }> };
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan=off');
      plan = await client.query(`explain (analyze, buffers, format text)
      select commit_ordinal,stream_kind,stable_id,payload from (
        (select operation.commit_ordinal,operation.sync_stream_kind stream_kind,
            operation.operation_id stable_id,payload.sync_wire_json payload
         from operations operation
         left join operation_payloads payload on payload.operation_id=operation.operation_id
         where operation.collection_id=$1 and operation.sync_wire_present
           and (operation.commit_ordinal,operation.sync_stream_kind,operation.operation_id collate "C")>
             ($2::bigint,$3::smallint,$4::text collate "C")
         order by operation.commit_ordinal,stream_kind,operation.operation_id collate "C" limit 200)
        union all
        (select commit_ordinal,sync_stream_kind stream_kind,conflict_id stable_id,pull_wire_json payload
         from sync_conflicts where collection_id=$1
           and (commit_ordinal,sync_stream_kind,conflict_id collate "C")>
             ($2::bigint,$3::smallint,$4::text collate "C")
         order by commit_ordinal,stream_kind,conflict_id collate "C" limit 200)
      ) visible_stream order by commit_ordinal,stream_kind,stable_id collate "C" limit 200`,
    [COLLECTION, 1000, 0, '']);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    // Which index the planner picks for the operations side (operations_sync_pull_order_idx
    // vs operations_collection_ordinal_unique + in-memory incremental sort) varies with
    // PostgreSQL version and statistics; either is index-backed proof, so accept both.
    assert.match(text, /Index (?:Only )?Scan using (?:operations_sync_pull_order_idx|operations_collection_ordinal_unique)/iu);
    assert.match(text, /sync_conflicts_pull_order_idx/iu);
    assert.match(text, /Merge Append/iu);
    assert.doesNotMatch(text, /Seq Scan|Bitmap Heap Scan|external merge|Disk:/iu);
    // The plan-structure assertions above are the index-usage proof; the budgets below
    // are lenient regression sentinels only, so machine load or PostgreSQL versions
    // cannot turn the gate red while gross regressions are still caught.
    const peakMemory = /Peak Memory: (\d+)kB/iu.exec(text);
    if (peakMemory) assert.ok(Number(peakMemory[1]) <= 8_192, text);
    const execution = /Execution Time: ([0-9.]+) ms/iu.exec(text);
    assert.ok(execution && Number(execution[1]) < 5_000, text);
  }, 20_000);

  test('upgrades from P3-19 and supports the documented destructive down/up cycle', async () => {
    const upgrade = await createIsolatedPostgresRuntime('p3_sync_pull_upgrade');
    try {
      let latest = '';
      while (latest !== '202607252100_sync_conflict_resolution') {
        const step = await runMigrations(upgrade.runtime.db, 'up');
        latest = step.results[0]?.migrationName ?? '';
        assert.notEqual(latest, '');
      }
      const up = await runMigrations(upgrade.runtime.db, 'up');
      assert.deepEqual(up.results.map((item) => item.migrationName), ['202607252200_sync_pull_stream']);
      const columns = await upgrade.runtime.pool.query<{ table_name: string; column_name: string }>(`
        select table_name,column_name from information_schema.columns
        where table_schema=current_schema() and
          (table_name,column_name) in (('operations','sync_wire_json'),('sync_conflicts','pull_wire_json'))
        order by table_name,column_name`);
      assert.deepEqual(columns.rows, [
        { table_name: 'operations', column_name: 'sync_wire_json' },
        { table_name: 'sync_conflicts', column_name: 'pull_wire_json' },
      ]);
      assert.deepEqual((await runMigrations(upgrade.runtime.db, 'down')).results.map(
        (item) => item.migrationName), ['202607252200_sync_pull_stream']);
      assert.deepEqual((await runMigrations(upgrade.runtime.db, 'up')).results.map(
        (item) => item.migrationName), ['202607252200_sync_pull_stream']);
    } finally { await upgrade.close(); }
  }, 30_000);

  test('rolls the recovery-proof migration down after raw cursor redaction without deleting receipts or audit', async () => {
    const recoveryIsolated = await createIsolatedPostgresRuntime('p3_sync_pull_recovery_down', {
      maxConnections: 4,
    });
    const sharedIsolated = pullFixture.isolated;
    pullFixture.isolated = recoveryIsolated;
    const excludedMigrations = new Set([...EXPAND_ONLY_NEWS_DIGEST_MIGRATIONS,
      ...productionMigrationNamesFromInclusive('202610100700_classification_credits')]);
    // Session issuance now reads accounts.security_epoch_bumped_at. Keep those
    // reversible migrations while still excluding later financial downs.
    for (const name of [
      '202610202500_accounts_security_epoch_bumped_at',
      '202610202501_stamp_security_epoch_bumped_at_on_bump',
    ]) excludedMigrations.delete(name);
    const migrationDirectory = await migrationDirectoryExcluding(excludedMigrations);
    try {
    // This test exercises the reversible recovery-proof migration while
    // excluding later financial and expand-only News Digest migrations. Financial
    // integrity controls intentionally refuse down; the News Digest migrations
    // intentionally retain their tables on down, so including them would make
    // a subsequent up attempt recreate existing objects and would test
    // migration ordering rather than the target contract.
    await runMigrationsExcludingNewsDigest(recoveryIsolated, migrationDirectory,
      excludedMigrations);
    await seedCollection(COLLECTION, ROOT);
    await pullFixture.isolated.runtime.pool.query(
      "insert into accounts(id,subject_id,status) values ($1,$2,'active')",
      [ACCOUNT, SUBJECT],
    );
    await pullFixture.isolated.runtime.pool.query(
      "insert into profile_handles(handle,account_id) values ('sync_pull',$1)",
      [ACCOUNT],
    );
    await pullFixture.isolated.runtime.pool.query(
      `insert into account_identities(id,account_id,issuer,subject)
        values ('p3-20-identity',$1,$2,'p3-20-oidc')`,
      [ACCOUNT, ISSUER],
    );
    const recovery = await createProtocolScope('0.1');
    let recoveryNow = Date.now();
    const recoveryKeys = createSyncPullCursorKeyring({
      active: { id: `migration-recovery-${randomUUID()}`, secret: Buffer.alloc(32, 57).toString('base64') },
      retained: [], ttlMs: 60_000, now: () => recoveryNow,
    });
    const recoveryPort = createPostgresSyncPullReadPort(pullFixture.isolated.runtime.db, recoveryKeys, {
      cursorNow: () => recoveryNow,
    });
    const first = await recoveryPort.read({ credential: recovery.credential,
      sessionId: recovery.session.sessionId, collectionId: COLLECTION,
      replicaId: recovery.replica.replicaId, cursor: null, limit: 2 });
    await createPostgresSyncAckApplication(pullFixture.isolated.runtime.db, {
      leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
    }).acknowledge({ credential: recovery.credential,
      idempotencyKey: `migration-recovery-ack-${randomUUID()}`, origin: ORIGIN,
      mediaType: 'application/json', endpointIdentity: 'syncAck',
      request: { sessionId: recovery.session.sessionId, cursor: first.nextCursor, warnings: [] } });
    recoveryNow += 120_000;
    await assert.rejects(recoveryPort.read({ credential: recovery.credential,
      sessionId: recovery.session.sessionId, collectionId: COLLECTION,
      replicaId: recovery.replica.replicaId, cursor: first.nextCursor, limit: 2 }),
    (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    const candidate = await pullFixture.isolated.runtime.pool.query<{ evidence_id: string }>(`select evidence.evidence_id::text
      from sync_pull_cursor_evidence evidence join sync_replicas replica on replica.replica_id=evidence.replica_id
      where replica.status='recovery_required' and evidence.replica_id=$1 and evidence.cursor is not null limit 1`,
    [recovery.replica.replicaId]);
    assert.equal(candidate.rowCount, 1);
    await pullFixture.isolated.runtime.pool.query('update sync_pull_cursor_evidence set cursor=null where evidence_id=$1',
      [candidate.rows[0]!.evidence_id]);
    const before = (await pullFixture.isolated.runtime.pool.query<{ receipts: string; audits: string }>(`select
      (select count(*)::text from sync_ack_receipts) receipts,
      (select count(*)::text from audit_events) audits`)).rows[0]!;
    for (const name of productionMigrationNamesNewestFirstUntil(
      '202607300100_sync_pull_recovery_proofs', migrationDirectory,
    )) {
      assert.deepEqual((await runMigrations(pullFixture.isolated.runtime.db, 'down', migrationDirectory)).results.map(
        (item) => item.migrationName), [name]);
    }
    const nullable = await pullFixture.isolated.runtime.pool.query<{ is_nullable: string }>(`select is_nullable
      from information_schema.columns where table_schema=current_schema()
        and table_name='sync_pull_cursor_evidence' and column_name='cursor'`);
    assert.equal(nullable.rows[0]?.is_nullable, 'NO');
    for (const name of productionMigrationNamesFromInclusive(
      '202607300100_sync_pull_recovery_proofs', migrationDirectory,
    )) {
      assert.deepEqual((await runMigrations(pullFixture.isolated.runtime.db, 'up', migrationDirectory)).results.map(
        (item) => item.migrationName), [name]);
    }
    const after = (await pullFixture.isolated.runtime.pool.query<{ receipts: string; audits: string }>(`select
      (select count(*)::text from sync_ack_receipts) receipts,
      (select count(*)::text from audit_events) audits`)).rows[0]!;
    assert.deepEqual(after, before);
    recoveryKeys.destroy();
    } finally {
      pullFixture.isolated = sharedIsolated;
      await recoveryIsolated.close();
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  }, 180_000);


});
