import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { resetCollectionNodeContractFixture } from '../../support/collection-node-contract-postgres.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { managedSavePorts } from '../../../src/infrastructure/source-archives/managed-copies.js';
import { convergeLocalCopy } from '../../../src/infrastructure/source-archives/local-convergence.js';
import type { ManagedSaveCommand } from '../../../src/modules/source-archives/index.js';
const collectionId = 'AQEBAQEBAQEBAQEBAQEBAQ', account = 'BgYGBgYGBgYGBgYGBgYGBg';
const command: ManagedSaveCommand = { commandId: 'merge', collectionId, replicaId: 'replica', parentId: 'root', parentRevision: 'root-r1', title: 'Saved', url: 'https://example.org',
  slot: { kind: 'bookmark', copy: { purpose: 'semantic', content: { site: 'bilibili', identityVersion: 1, itemId: 'video:av:1', accountId: null } } },
  adopt: { nodeId: 'loser', revision: 'loser-r1' }, converge: { fromParentId: 'root' } };
describeWithPostgres('local source convergence protects user data', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('source_convergence'); await runMigrations(isolated.runtime.db, 'latest'); }, 120000);
  afterAll(async () => { await isolated?.close(); });
  beforeEach(async () => { await resetCollectionNodeContractFixture(isolated.runtime, {
    principals: [{ principalId: account, subjectId: account }], collection: { id: collectionId, ownerSubjectId: account, rootNodeId: 'root',
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1', commitOrdinal: 1n },
    nodes: [{ id: 'root', parentId: null, kind: 'folder', isRoot: true, title: 'Root', positionToken: null, resourceRevision: 'root-r1', childrenRevision: 'root-children-r1' },
      ...['winner', 'loser'].map((id, i) => ({ id, parentId: 'root', kind: 'bookmark' as const, title: 'Saved', url: 'https://example.org', positionToken: i ? 'V' : 'U', resourceRevision: `${id}-r1`, childrenRevision: `${id}-children-r1` }))],
  }); });
  const merge = (cut = false) => isolated.runtime.db.transaction().execute(async tx => {
    const ports = managedSavePorts(tx, account, account); await ports.assertTarget(command);
    const result = await convergeLocalCopy(tx, account, account, command, await ports.read(collectionId, 'winner'));
    if (cut) throw Error('before-commit'); return result;
  });
  const loser = () => isolated.runtime.db.selectFrom('nodes').selectAll().where('id', '=', 'loser').executeTakeFirstOrThrow();
  test('merges an untouched provisional node with a Sync tombstone and rolls back atomically', async () => {
    await expect(merge(true)).rejects.toThrow('before-commit'); expect((await loser()).deleted_at).toBeNull();
    expect(await merge()).toMatchObject({ nodeId: 'winner' }); expect((await loser()).deleted_at).not.toBeNull();
    const tombstone = await isolated.runtime.db.selectFrom('sync_node_tombstones').selectAll().where('target_id', '=', 'loser').executeTakeFirst();
    expect(tombstone).toMatchObject({ collection_id: collectionId, scope: 'single' });
    expect((await isolated.runtime.db.selectFrom('nodes').select('deleted_at').where('id', '=', 'winner').executeTakeFirst())?.deleted_at).toBeNull();
  });
  test.each(['pin', 'annotation', 'relation', 'changed-revision', 'description', 'tags', 'title'] as const)('%s keeps both copies intact', async kind => {
    const db = isolated.runtime.db;
    if (kind === 'pin') await sql`UPDATE nodes SET payload_json=jsonb_set(payload_json,'{extensions}','{"https://know-n.org/extensions/bookmark-pin/v1":{"pinned":true}}'::jsonb) WHERE id='loser'`.execute(db);
    if (kind === 'changed-revision') await sql`UPDATE nodes SET resource_revision='changed',payload_json=jsonb_set(payload_json,'{revision}','"changed"'::jsonb) WHERE id='loser'`.execute(db);
    if (kind === 'description') await sql`UPDATE nodes SET description='keep',payload_json=jsonb_set(payload_json,'{description}','"keep"'::jsonb) WHERE id='loser'`.execute(db);
    if (kind === 'tags') await sql`UPDATE nodes SET tags='["keep"]'::jsonb,payload_json=jsonb_set(payload_json,'{tags}','["keep"]'::jsonb) WHERE id='loser'`.execute(db);
    if (kind === 'title') await sql`UPDATE nodes SET title='Edited',payload_json=jsonb_set(payload_json,'{title}','"Edited"'::jsonb) WHERE id='loser'`.execute(db);
    if (kind === 'annotation') {
      const payload = { id: 'note', collectionId, subject: { type: 'node', id: 'loser' }, creator: { principalId: account }, type: 'note', value: 'keep', visibility: 'private', revision: 'note-r1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await sql`INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES('note','annotation')`.execute(db);
      await sql`INSERT INTO annotations(id,collection_id,subject_type,subject_id,creator_principal_id,type,value_json,visibility,resource_revision,created_at,updated_at,payload_json)
        VALUES('note',${collectionId},'node','loser',${account},'note','"keep"'::jsonb,'private','note-r1',now(),now(),${JSON.stringify(payload)}::jsonb)`.execute(db);
    }
    if (kind === 'relation') {
      const payload = { id: 'relation', collectionId, fromNodeId: 'loser', toNodeId: 'winner', type: 'related', visibility: 'private', revision: 'relation-r1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await sql`INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES('relation','relation')`.execute(db);
      await sql`INSERT INTO relations(id,collection_id,from_node_id,to_node_id,type,visibility,resource_revision,created_at,updated_at,payload_json)
        VALUES('relation',${collectionId},'loser','winner','related','private','relation-r1',${new Date(payload.createdAt)},${new Date(payload.updatedAt)},${JSON.stringify(payload)}::jsonb)`.execute(db);
    }
    await expect(merge()).rejects.toThrow('source_copy_convergence_review'); expect((await loser()).deleted_at).toBeNull();
  });
});
