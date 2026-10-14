import { sql, type RawBuilder } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/** Independent revision ledgers share one round trip, retaining every per-operation row. */
export async function appendRevisions(
  tx: DatabaseTransaction,
  collectionId: string,
  resourceId: string,
  allocation: { resourceRevision?: string; createdNodeChildrenRevision?: string; contentRevision?: string; policyRevision?: string; childrenRevisions: Readonly<Record<string, string>>; commitOrdinal: bigint },
  now: Date,
  recordCreatedNodeChildrenRevision = false,
  skipResourceRevision = false,
): Promise<void> {
  const writes: RawBuilder<unknown>[] = [];
  if (allocation.resourceRevision && !skipResourceRevision) writes.push(sql`${tx.insertInto('resource_revisions').values({
    collection_id: collectionId, resource_id: resourceId, revision: allocation.resourceRevision,
    ordinal: allocation.commitOrdinal, created_at: now,
  })}`);
  if (allocation.contentRevision) writes.push(sql`${tx.insertInto('content_revisions').values({
    collection_id: collectionId, revision: allocation.contentRevision, ordinal: allocation.commitOrdinal, created_at: now,
  })}`);
  if (allocation.policyRevision) writes.push(sql`${tx.insertInto('policy_revisions').values({
    collection_id: collectionId, revision: allocation.policyRevision, ordinal: allocation.commitOrdinal, created_at: now,
  })}`);
  const children = Object.entries(allocation.childrenRevisions).map(([parentId, revision]) => ({
    collection_id: collectionId, parent_id: parentId, revision, ordinal: allocation.commitOrdinal,
  }));
  if (recordCreatedNodeChildrenRevision && allocation.createdNodeChildrenRevision) children.push({
    collection_id: collectionId, parent_id: resourceId,
    revision: allocation.createdNodeChildrenRevision, ordinal: allocation.commitOrdinal,
  });
  if (children.length) writes.push(sql`${tx.insertInto('children_revisions').values(children)}`);
  if (writes.length) await sql`WITH ${sql.join(writes.map((write, i) => sql`${sql.id(`revision_${i}`)} AS (${write})`))}
    SELECT 1`.execute(tx);
}
