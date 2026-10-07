import { sql, type Kysely } from 'kysely';
import { subtreeDeleteSource } from '@know-n/colp/sync';
import type { DatabaseSchema } from '../../src/infrastructure/database/runtime.js';

/** Test client's explicit preview read. Call before the competing mutation. */
export async function observeSubtree(db: Kysely<DatabaseSchema>, rootId: string) {
  const result = await sql<{ id: string; revision: string }>`
    with recursive members as (
      select id, collection_id, resource_revision from nodes where id=${rootId} and deleted_at is null
      union all select child.id, child.collection_id, child.resource_revision
      from nodes child join members parent on child.parent_id=parent.id and child.collection_id=parent.collection_id
      where child.deleted_at is null
    ) select id, resource_revision as revision from members`.execute(db);
  return subtreeDeleteSource(rootId, result.rows);
}
