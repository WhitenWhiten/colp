import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { createUnitOfWork, lockActiveSyncReplicasForCollection, type DatabaseSchema } from '../infrastructure/database/index.js';
import { createPostgresCanonicalMutationPorts } from '../infrastructure/collections/index.js';
import { createCanonicalMutationApplication } from '../modules/collections/index.js';

/** Operator-only, one atomic folder at a time. Canonical writes preserve history,
 * revisions, audit, capacity checks and replica recovery just like normal moves. */
export async function maintainPositions(db: Kysely<DatabaseSchema>, collectionId: string) {
  const parents = await db.selectFrom('nodes').select('parent_id').distinct()
    .where('collection_id', '=', collectionId).where('deleted_at', 'is', null)
    .where('position_token', 'is not', null).execute();
  let repaired = 0;
  for (const { parent_id: parentId } of parents) {
    if (!parentId) continue;
    const changed = await createUnitOfWork(db).execute(async ({ transaction }) => {
      await lockActiveSyncReplicasForCollection(transaction, collectionId);
      const collection = await transaction.selectFrom('collections').selectAll()
        .where('id', '=', collectionId).where('deleted_at', 'is', null).forUpdate().executeTakeFirstOrThrow();
      const rows = await transaction.selectFrom('nodes').select(['id', 'position_token', 'resource_revision'])
        .where('collection_id', '=', collectionId).where('parent_id', '=', parentId)
        .where('deleted_at', 'is', null).orderBy('position_token').orderBy('id').forUpdate().execute();
      if (!rows.some(row => (row.position_token?.length ?? 0) >= 32)) return false;
      const target = rows[0]!;
      const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(transaction, {
        positionMaintenance: true, invalidateSyncReplicasOnNodeMutation: true,
      }));
      await canonical.execute({ transaction }, {
        operationId: randomUUID(), collectionId,
        actor: { principalId: collection.owner_subject_id, principalType: 'account' },
        automationContext: { origin: 'system' },
        mutation: { action: 'move', target: { collectionId, resourceId: target.id, resourceKind: 'node' },
          parentId, expectedResourceRevision: target.resource_revision,
          fields: { kindFields: {}, extensions: {} },
          ...(rows[1] ? { relativePosition: { beforeId: rows[1].id } } : {}) },
      });
      return true;
    });
    if (changed) repaired += 1;
  }
  return { repairedFolders: repaired };
}
