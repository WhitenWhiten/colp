import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { measureCanonicalTree } from '../../../src/infrastructure/collections/canonical-tree-capacity.js';
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
});
