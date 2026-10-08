import {
  lockCollectionForReplicaInvalidation,
  type DatabaseTransaction,
} from '../infrastructure/database/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../infrastructure/outbox/index.js';
import {
  createCanonicalMutationApplication,
  type ProductCollectionCanonicalPorts,
} from '../modules/collections/index.js';
import {
  createPostgresCanonicalMutationPorts,
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresNodeWritePort,
  createPostgresBookmarkIconWritePort,
} from '../infrastructure/collections/index.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../infrastructure/access-policy/index.js';
import {
  createPostgresProductCommandReceiptPort,
} from '../infrastructure/database/index.js';

/**
 * Build the transaction-bound canonical ports used by the MCP Write planner
 * and commit coordinator. Keeping this adapter outside the orchestration file
 * leaves the composition focused on lifecycle and capability wiring.
 */
export function createMcpWriteProductPorts(
  transaction: DatabaseTransaction,
  productOrigin?: string,
  reportSourceInvalidation?: ReportSourceInvalidationOutboxPort,
): ProductCollectionCanonicalPorts {
  const rawCanonical = createCanonicalMutationApplication(
    createPostgresCanonicalMutationPorts(transaction, {
      // B0-3 / SR-03: the MCP `changes.commit` executor writes without a
      // Replica/Sequence identity, so its Operations persist
      // `sync_wire_present = false` and can never be delivered by the
      // incremental Push/Pull protocol. Force the same Snapshot recovery as
      // Product node writes.
      invalidateSyncReplicasOnNodeMutation: true,
      ...(reportSourceInvalidation === undefined
        ? {} : { reportSourceInvalidation }),
    }),
  );
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const clock = createPostgresCollectionsClock(transaction);
  const collections = createPostgresCollectionWritePort(transaction);
  const nodeReader = createPostgresNodeWritePort(transaction);
  const accessPolicy = createPostgresAccessPolicyFactsPort(transaction);

  return Object.freeze({
    canonical: Object.freeze({
      execute: (input: Parameters<typeof rawCanonical.execute>[1]) =>
        rawCanonical.execute({ transaction }, input),
      async bootstrapOwnedCollection() {
        throw new Error('MCP-W10 write composition never bootstraps collections through Commit');
      },
    }),
    receipts,
    clock,
    collections: Object.freeze({
      // T-10 lock order (ADR-0027): the canonical mutation above ends by marking
      // this collection's active replicas `recovery_required`, so the
      // Collection-first command entry points must take the `sync_replicas`
      // rows before the `collections` row.
      lockForUpdate: (collectionId: string) => lockCollectionForReplicaInvalidation(
        transaction, collectionId, () => collections.lockForUpdate(collectionId)),
    }),
    nodes: Object.freeze({
      getNode: (collectionId: string, nodeId: string) =>
        nodeReader.getNode(collectionId, nodeId),
      readParentAncestry: (collectionId: string, parentId: string, maxDepth: number) =>
        nodeReader.readParentAncestry!(collectionId, parentId, maxDepth),
      listLiveSiblingPositions: (collectionId: string, parentId: string) =>
        nodeReader.listLiveSiblingPositions(collectionId, parentId),
      hasLiveChildren: (collectionId: string, parentId: string) =>
        nodeReader.hasLiveChildren!(collectionId, parentId),
    }),
    accessPolicy,
    bookmarkIcons: createPostgresBookmarkIconWritePort(transaction),
    ...(productOrigin === undefined ? {} : { productOrigin }),
  });
}
