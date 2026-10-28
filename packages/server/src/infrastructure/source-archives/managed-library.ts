import { createPostgresNodeWritePort, createPostgresCollectionWritePort } from '../collections/repositories.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SourceArchiveError, type ManagedNode } from '../../modules/source-archives/index.js';
export async function lockManagedLibrary(tx: DatabaseTransaction, subjectId: string, collectionId: string) {
  await lockActiveSyncReplicasForCollection(tx, collectionId);
  const collection = await createPostgresCollectionWritePort(tx).lockForUpdate(collectionId);
  if (!collection || collection.deletedAt || collection.ownerSubjectId !== subjectId) throw new SourceArchiveError('source_root_unavailable', 403);
  return collection;
}
export async function readManagedNode(tx: DatabaseTransaction, collectionId: string, nodeId: string): Promise<ManagedNode | null> {
  const node = await createPostgresNodeWritePort(tx).getNode(collectionId, nodeId);
  return node ? { nodeId: node.id, parentId: node.parentId!, title: node.title, url: node.url, revision: node.resourceRevision, deleted: !!node.deletedAt } : null;
}
