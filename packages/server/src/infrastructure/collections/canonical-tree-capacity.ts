import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SNAPSHOT_TREE_CAPACITY, SnapshotTreeCapacityError } from '../../modules/collections/index.js';
import { mapSnapshotCollection, mapSnapshotNode, snapshotParentRevisions, withSnapshotBinding, type SnapshotCollectionRow, type SnapshotNodeRow } from './snapshot-document.js';

export interface CanonicalTreeSize { readonly nodes: number; readonly bytes: number }

/** Uses the actual Snapshot document projection, including extensions and parent revisions. */
export async function measureCanonicalTree(tx: DatabaseTransaction, collectionId: string): Promise<CanonicalTreeSize> {
  const measured = await sql<{ collection: SnapshotCollectionRow; nodes: SnapshotNodeRow[] }>`
    SELECT row_to_json(c) AS collection, COALESCE((SELECT json_agg(n) FROM nodes n
      WHERE n.collection_id=c.id AND n.deleted_at IS NULL), '[]'::json) AS nodes
    FROM collections c WHERE c.id=${collectionId}
  `.execute(tx);
  const row = measured.rows[0];
  if (!row) throw new Error('Canonical collection disappeared during capacity admission');
  const collection = { ...row.collection, created_at: new Date(row.collection.created_at), updated_at: new Date(row.collection.updated_at) };
  const rows = row.nodes.map(node => ({ ...node, created_at: new Date(node.created_at), updated_at: new Date(node.updated_at) }));
  // mounted-folder is the longer of the two supported binding envelopes.
  const document = {
    collection: withSnapshotBinding(mapSnapshotCollection(collection), 'mounted-folder', collection.root_node_id),
    nodes: rows.map(mapSnapshotNode), parentRevisions: snapshotParentRevisions(rows),
  };
  return { nodes: rows.length, bytes: Buffer.byteLength(JSON.stringify(document), 'utf8') };
}

export function admitCanonicalTreeChange(before: CanonicalTreeSize, after: CanonicalTreeSize): void {
  if ((after.nodes > SNAPSHOT_TREE_CAPACITY.maxNodes && after.nodes > before.nodes)
    || (after.bytes > SNAPSHOT_TREE_CAPACITY.maxAggregateBytes && after.bytes > before.bytes)) {
    throw new SnapshotTreeCapacityError();
  }
}

/** The collection lock is held by canonical orchestration throughout this check. */
export async function withCanonicalTreeCapacity<Result>(tx: DatabaseTransaction, collectionId: string, write: () => Promise<Result>): Promise<Result> {
  const before = await measureCanonicalTree(tx, collectionId);
  const result = await write();
  admitCanonicalTreeChange(before, await measureCanonicalTree(tx, collectionId));
  return result;
}

export interface CanonicalTreeCapacityAdmission {
  execute<Result>(tx: DatabaseTransaction, collectionId: string, write: () => Promise<Result>): Promise<Result>;
}

/** An explicit atomic batch owns one before/after check, regardless of mutation count. */
export async function withCanonicalTreeCapacityBatch<Result>(
  tx: DatabaseTransaction,
  collectionId: string | undefined,
  work: (admission: CanonicalTreeCapacityAdmission) => Promise<Result>,
): Promise<Result> {
  // Generic transaction owners bind the collection on their first mutation.
  let boundCollectionId = collectionId;
  let before: CanonicalTreeSize | undefined;
  let open = true;
  const admission: CanonicalTreeCapacityAdmission = {
    async execute(actualTx, actualCollectionId, write) {
      if (!open || actualTx !== tx || (boundCollectionId !== undefined && actualCollectionId !== boundCollectionId)) {
        throw new Error('Canonical capacity batch cannot escape its transaction and collection');
      }
      // Called only after canonical orchestration owns the collection lock.
      boundCollectionId = actualCollectionId;
      before ??= await measureCanonicalTree(tx, actualCollectionId);
      return write();
    },
  };
  try {
    const result = await work(admission);
    if (before && boundCollectionId !== undefined) {
      admitCanonicalTreeChange(before, await measureCanonicalTree(tx, boundCollectionId));
    }
    return result;
  } finally {
    open = false;
  }
}
