import type { CanonicalTreeCapacityAdmission } from './canonical-tree-capacity.js';
import {
  createCanonicalMutationApplication,
  type ProductCollectionCanonicalPorts,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { lockCollectionForReplicaInvalidation } from '../database/lock-order.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { type DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresCanonicalMutationPorts } from './canonical-mutation-postgres-ports.js';
import { createPostgresBookmarkIconWritePort } from './bookmark-icon-postgres.js';
import {
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresNodeWritePort,
} from './repositories.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

export function createClassificationCanonicalPorts(
  transaction: DatabaseTransaction,
  options: { readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort; readonly treeCapacityAdmission?: CanonicalTreeCapacityAdmission } = {},
): ProductCollectionCanonicalPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const clock = createPostgresCollectionsClock(transaction);
  const collections = createPostgresCollectionWritePort(transaction);
  const nodes = createPostgresNodeWritePort(transaction);
  const rawCanonical = createCanonicalMutationApplication(
    createPostgresCanonicalMutationPorts(transaction, {
      // B0-3 / SR-03: classify-inbox accept moves a node without a
      // Replica/Sequence identity, so its Operation persists
      // `sync_wire_present = false` and can never be delivered by the
      // incremental Push/Pull protocol. Force the same Snapshot recovery as
      // Product node writes.
      invalidateSyncReplicasOnNodeMutation: true,
      treeCapacityAdmission: options.treeCapacityAdmission,
      ...(options.reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation: options.reportSourceInvalidation }),
    }),
  );
  return {
    receipts,
    clock,
    collections: {
      // T-10 lock order (ADR-0027): the canonical mutation above marks this
      // collection's active replicas `recovery_required`, so the
      // Collection-first command entry points must take the `sync_replicas`
      // rows before the `collections` row.
      lockForUpdate: (collectionId) => lockCollectionForReplicaInvalidation(
        transaction, collectionId, () => collections.lockForUpdate(collectionId)),
    },
    nodes: {
      getNode: (collectionId, nodeId) => nodes.getNode(collectionId, nodeId),
      readParentAncestry: (collectionId, parentId, maxDepth) =>
        nodes.readParentAncestry!(collectionId, parentId, maxDepth),
      listLiveSiblingPositions: (collectionId, parentId) =>
        nodes.listLiveSiblingPositions(collectionId, parentId),
      hasLiveChildren: (collectionId, parentId) =>
        nodes.hasLiveChildren!(collectionId, parentId),
    },
    accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
    canonical: {
      execute: (input) => rawCanonical.execute({ transaction }, input),
      bootstrapOwnedCollection: async () => {
        throw new Error('classification content does not bootstrap collections');
      },
    },
    bookmarkIcons: createPostgresBookmarkIconWritePort(transaction),
  };
}
