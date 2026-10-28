import { randomUUID, createHash } from 'node:crypto';
import type { Operation } from '@know-n/colp/types';
import { createCanonicalMutationApplication, assertLibraryDestination, type JsonObject } from '../../modules/collections/index.js';
import { createPostgresCanonicalMutationPorts } from '../collections/canonical-mutation-postgres-ports.js';
import { createPostgresNodeWritePort, createPostgresCollectionWritePort } from '../collections/repositories.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SourceArchiveError, type ManagedNode, type ManagedSavePorts } from '../../modules/source-archives/index.js';
import { persistAuthoritativeOperationEffect } from '../sync/index.js';
import { convergeLocalCopy } from './local-convergence.js';
export async function lockManagedLibrary(tx: DatabaseTransaction, subjectId: string, collectionId: string) {
  await lockActiveSyncReplicasForCollection(tx, collectionId);
  const collection = await createPostgresCollectionWritePort(tx).lockForUpdate(collectionId);
  if (!collection || collection.deletedAt || collection.ownerSubjectId !== subjectId) throw new SourceArchiveError('source_root_unavailable', 403);
  return collection;
}
/** Called under the existing source account transaction; source strings are opaque authenticated user data. */
export function managedSavePorts(tx: DatabaseTransaction, subjectId: string, accountId: string): ManagedSavePorts {
  const nodes = createPostgresNodeWritePort(tx);
  const canonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(tx, { replicaLocksAlreadyHeld: () => true }));
  return {
    converge: (command, winner) => convergeLocalCopy(tx, subjectId, accountId, command, winner),
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
      // Source imports are ordinary server-origin creates. Publish their exact
      // effects in this transaction so Pull can project them without rebuilding
      // every replica (and invalidating an in-flight recovery Snapshot).
      const operation: Operation = { opId: operationId, collectionId: c.collectionId,
        replicaId: `server-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`,
        sequence: 1, type: 'create_node', baseRevision: null, occurredAt: new Date().toISOString(), dependencies: [],
        payload: { parentId: c.parentId, node: c.slot.kind === 'folder' ? { kind: 'folder', title: c.title }
          : { kind: 'bookmark', title: c.title, url: c.url! } } };
      const result = await canonical.execute({ transaction: tx }, {
        operationId, collectionId: c.collectionId, actor: { principalId: accountId, principalType: 'account' },
        operationSyncWire: operation as unknown as JsonObject,
        intakeDisposition: 'userSelected', automationContext: { origin: 'import' },
        mutation: { action: 'create', target: { collectionId: c.collectionId, resourceId: nodeId, resourceKind: 'node' }, parentId: c.parentId,
          fields: { kindFields: { kind: c.slot.kind === 'folder' ? 'folder' : 'bookmark', title: c.title, url: c.url,
            description: null, tags: [], visibility: 'inherit' }, extensions: {} } },
      });
      await persistAuthoritativeOperationEffect({ transaction: tx, operation, targetId: nodeId,
        commitOrdinal: result.allocation.commitOrdinal, terminalStatus: 'applied', cursor: `source-create-${result.allocation.commitOrdinal}` });
      return { nodeId, parentId: c.parentId, title: c.title, url: c.url, revision: result.allocation.resourceRevision! };
    },
  };
}
