import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { measureCanonicalTree } from '../../../src/infrastructure/collections/canonical-tree-capacity.js';
import { SNAPSHOT_TREE_CAPACITY } from '../../../src/modules/collections/index.js';
import { readCanonicalTreeCapacity } from '../../../src/infrastructure/collections/canonical-tree-capacity-ledger.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { resetCollectionNodeContractFixture } from '../../support/collection-node-contract-postgres.js';

describeWithPostgres('exact incremental Snapshot capacity', () => {
  let isolated: IsolatedPostgresRuntime;
  const collectionId = 'ledger-collection'; const rootId = 'ledger-root'; const nodeId = 'ledger-bookmark';
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('capacity_ledger');
    await runMigrations(isolated.runtime.db, 'latest');
    await resetCollectionNodeContractFixture(isolated.runtime, {
      principals: [{ principalId: 'ledger-principal', subjectId: 'ledger-subject' }],
      collection: { id: collectionId, ownerSubjectId: 'ledger-subject', rootNodeId: rootId,
        resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1', commitOrdinal: 1n },
      nodes: [{ id: rootId, parentId: null, kind: 'folder', isRoot: true, title: 'Root',
        positionToken: null, resourceRevision: 'r1', childrenRevision: 'c1' },
      { id: nodeId, parentId: rootId, kind: 'bookmark', title: '书签 🐈 "\\\n',
        url: 'https://example.test', description: '界', tags: ['标签'],
        positionToken: 'A', resourceRevision: 'r2', childrenRevision: 'c2' }],
    });
  }, 30_000);
  afterAll(async () => isolated?.close());
  const compare = () => isolated.runtime.db.transaction().execute(async tx => {
    const actual = await readCanonicalTreeCapacity(tx, collectionId);
    assert.deepEqual(actual, await measureCanonicalTree(tx, collectionId));
    return actual;
  });

  test('tracks UTF-8, parent revisions, metadata, deletion and restore exactly', async () => {
    const initial = await compare();
    await isolated.runtime.pool.query(`update nodes set payload_json=jsonb_set(payload_json,
      '{extensions}', $2::jsonb) where id=$1`, [nodeId, JSON.stringify({ 'example.test': { note: '新内容 🐈' } })]);
    assert.ok((await compare()).bytes > initial.bytes);
    await isolated.runtime.pool.query(`update nodes set children_revision='a-longer-revision' where id=$1`, [rootId]);
    await isolated.runtime.pool.query(`update collections set summary='多字节 "\\' where id=$1`, [collectionId]);
    await compare();
    await isolated.runtime.pool.query(`update nodes set deleted_at=current_timestamp where id=$1`, [nodeId]);
    assert.equal((await compare()).nodes, 1);
    await isolated.runtime.pool.query('update nodes set deleted_at=null where id=$1', [nodeId]);
    assert.equal((await compare()).nodes, 2);
  });

  test('contribution updates and dirty facts roll back with the write', async () => {
    const before = await compare();
    await assert.rejects(isolated.runtime.db.transaction().execute(async tx => {
      await readCanonicalTreeCapacity(tx, collectionId);
      await tx.updateTable('nodes').set({ title: 'rolled-back change' }).where('id', '=', nodeId).execute();
      await readCanonicalTreeCapacity(tx, collectionId);
      throw new Error('rollback');
    }), /rollback/u);
    assert.deepEqual(await compare(), before);
  });

  test('serializes concurrent admissions and invalidates across serializer revisions', async () => {
    await Promise.all(['concurrent A', 'concurrent B'].map(title =>
      isolated.runtime.db.transaction().execute(async tx => {
        await readCanonicalTreeCapacity(tx, collectionId);
        await tx.updateTable('nodes').set({ title }).where('id', '=', nodeId).execute();
        await readCanonicalTreeCapacity(tx, collectionId);
      })));
    await compare();
    await sql`update canonical_tree_capacity set serializer_version=0`.execute(isolated.runtime.db);
    await compare();
    const dirty = await sql<{ count: string }>`select count(*) from canonical_tree_capacity_dirty`.execute(isolated.runtime.db);
    assert.equal(Number(dirty.rows[0]!.count), 0);
  });

  test('warm admission reads only changed contributions at 1000, 2500 and 5000 nodes', async () => {
    const measurements: Array<Record<string, number>> = [];
    let previous = 2;
    for (const count of [1000, 2500, 5000]) {
      await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
        select 'capacity-scale-' || n,'node' from generate_series($1::integer,$2::integer) n`, [previous + 1, count]);
      await isolated.runtime.pool.query(`insert into nodes (id,collection_id,parent_id,kind,is_root,
        title,url,position_token,resource_revision,children_revision,visibility,created_at,updated_at,
        payload_json,payload_schema_version,payload_authority_status)
        select 'capacity-scale-' || n,collection_id,parent_id,kind,false,title,url,
          'scale-' || lpad(n::text,5,'0'),resource_revision,children_revision,visibility,created_at,updated_at,
          jsonb_set(payload_json - 'description' - 'tags' - 'extensions','{id}',to_jsonb('capacity-scale-' || n)),payload_schema_version,payload_authority_status
        from nodes cross join generate_series($1::integer,$2::integer) n where id=$3`, [previous + 1, count, nodeId]);
      assert.equal((await compare()).nodes, count);
      let maximumRows = 0;
      const observed = isolated.runtime.db.withPlugin({ transformQuery: ({ node }) => node,
        async transformResult({ result }) { maximumRows = Math.max(maximumRows, result.rows.length); return result; } });
      const started = performance.now();
      const incremental = await observed.transaction().execute(async tx => {
        await tx.selectFrom('collections').select('id').where('id', '=', collectionId).forUpdate().execute();
        await tx.updateTable('nodes').set({ title: `scale ${count}` }).where('id', '=', nodeId).execute();
        return readCanonicalTreeCapacity(tx, collectionId);
      });
      const incrementalMs = performance.now() - started;
      const fullStarted = performance.now();
      const full = await isolated.runtime.db.transaction().execute(tx => measureCanonicalTree(tx, collectionId));
      const fullMs = performance.now() - fullStarted;
      assert.deepEqual(incremental, full); assert.ok(maximumRows <= 2, 'warm accounting reads no whole-tree result');
      assert.ok(full.bytes <= SNAPSHOT_TREE_CAPACITY.maxAggregateBytes, 'benchmark stays within supported Snapshot capacity');
      measurements.push({ nodes: count, incrementalMs, fullMs, maximumRows }); previous = count;
    }
    if (process.env.COLP_SYNC_BENCHMARK_OUTPUT) {
      await writeFile(process.env.COLP_SYNC_BENCHMARK_OUTPUT, JSON.stringify(measurements, null, 2));
    }
  });

  test('a forbidden physical cleanup rolls back its dirty facts and contributions', async () => {
    await assert.rejects(isolated.runtime.db.transaction().execute(async tx => {
      await sql`set constraints all deferred`.execute(tx);
      await tx.deleteFrom('nodes').where('collection_id', '=', collectionId).execute();
      await tx.deleteFrom('collections').where('id', '=', collectionId).execute();
    }), /foreign key/u);
    assert.equal((await compare()).nodes, 5000);
  });
});
