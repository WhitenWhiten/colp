import { randomUUID } from 'node:crypto';
import { createCanonicalMutationApplication, assertLibraryDestination } from '../../modules/collections/index.js';
import { createPostgresCanonicalMutationPorts } from '../collections/canonical-mutation-postgres-ports.js';
import { createPostgresNodeWritePort, createPostgresCollectionWritePort } from '../collections/repositories.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SourceArchiveError, type ManagedNode, type ManagedSavePorts } from '../../modules/source-archives/index.js';
export async function lockManagedLibrary(tx: DatabaseTransaction, subjectId: string, collectionId: string) {
  await lockActiveSyncReplicasForCollection(tx, collectionId);
  const collection = await createPostgresCollectionWritePort(tx).lockForUpdate(collectionId);
  if (!collection || collection.deletedAt || collection.ownerSubjectId !== subjectId) throw new SourceArchiveError('source_root_unavailable', 403);
  return collection;
}
/** Called under the existing source account transaction; source strings are opaque authenticated user data. */
export function managedSavePorts(tx: DatabaseTransaction, subjectId: string, accountId: string): ManagedSavePorts {
  const nodes = createPostgresNodeWritePort(tx);
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, {
    invalidateSyncReplicasOnNodeMutation: true, replicaLocksAlreadyHeld: () => true,
  }));
  return {
    async assertTarget(c) {
      const collection = await lockManagedLibrary(tx, subjectId, c.collectionId);
      const parent = await nodes.getNode(c.collectionId, c.parentId);
      if (!collection || collection.deletedAt || collection.ownerSubjectId !== subjectId || !parent || parent.deletedAt
        || parent.kind !== 'folder' || parent.resourceRevision !== c.parentRevision) throw new SourceArchiveError('source_root_changed');
      await assertLibraryDestination({ nodes }, collection, parent);
    },
    async read(collectionId, nodeId) {
      const n = await nodes.getNode(collectionId, nodeId);
      return n ? { nodeId: n.id, parentId: n.parentId!, title: n.title, url: n.url, revision: n.resourceRevision, deleted: !!n.deletedAt } : null;
    },
    async create(c): Promise<ManagedNode> {
      const nodeId = randomUUID(), operationId = randomUUID();
      const result = await canonical.execute({ transaction: tx }, {
        operationId, collectionId: c.collectionId, actor: { principalId: accountId, principalType: 'account' },
        intakeDisposition: 'userSelected', automationContext: { origin: 'import' },
        mutation: { action: 'create', target: { collectionId: c.collectionId, resourceId: nodeId, resourceKind: 'node' }, parentId: c.parentId,
          fields: { kindFields: { kind: c.slot.kind === 'folder' ? 'folder' : 'bookmark', title: c.title, url: c.url,
            description: null, tags: [], visibility: 'inherit' }, extensions: {} } },
      });
      return { nodeId, parentId: c.parentId, title: c.title, url: c.url, revision: result.allocation.resourceRevision! };
    },
  };
}
