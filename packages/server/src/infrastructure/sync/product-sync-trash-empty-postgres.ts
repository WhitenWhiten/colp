import {
  PRODUCT_SYNC_TRASH_EMPTY_CONFIRMATION,
  PRODUCT_SYNC_TRASH_EMPTY_LIMIT,
  type ProductSyncCenterPorts,
  type ProductSyncTrashEmptyView,
} from '../../modules/sync/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { SyncTombstonePurgeFenceLostError } from './sync-tombstone-purge-postgres.js';
import { purgeOwnedTrashInTransaction } from './sync-tombstone-user-purge-postgres.js';
import {
  invalidRequest, notFound, ownedCollection, preconditionFailed, productTrashCommand,
  type ProductSyncTrashPostgresOptions,
} from './product-sync-trash-shared-postgres.js';

export function productSyncTrashEmptyPorts(
  transaction: DatabaseTransaction,
  options: ProductSyncTrashPostgresOptions,
): Pick<ProductSyncCenterPorts, 'emptyTrash'> {
  return {
    emptyTrash: (input) => productTrashCommand(transaction, {
      principalId: input.accountId,
      commandScope: `sync-trash-empty:${input.collectionId}`,
      commandId: input.commandId,
    }, input.fingerprint, async () => emptyTrash(transaction, input, options)),
  };
}

async function emptyTrash(
  transaction: DatabaseTransaction,
  input: {
    readonly accountId: string; readonly subjectId: string; readonly collectionId: string;
    readonly expectedCount: number; readonly confirmation: string;
  },
  options: ProductSyncTrashPostgresOptions,
): Promise<ProductSyncTrashEmptyView> {
  if (input.confirmation !== PRODUCT_SYNC_TRASH_EMPTY_CONFIRMATION) {
    throw invalidRequest('Trash empty confirmation is invalid.');
  }
  if (!Number.isInteger(input.expectedCount) || input.expectedCount < 1
      || input.expectedCount > PRODUCT_SYNC_TRASH_EMPTY_LIMIT) {
    throw invalidRequest('Trash empty selection is empty or too large.');
  }
  const collection = await ownedCollection(transaction, input.collectionId, input.subjectId);
  if (!collection) throw notFound();
  const liveCount = await countRestorable(transaction, input.collectionId);
  if (liveCount !== input.expectedCount) throw preconditionFailed();
  try {
    const purged = await purgeOwnedTrashInTransaction(transaction, {
      collectionId: input.collectionId,
      workerId: `product-trash-empty:${input.accountId}`,
      leaseDurationMs: 30_000,
    });
    if (purged.results.length > PRODUCT_SYNC_TRASH_EMPTY_LIMIT) {
      throw invalidRequest('Trash empty selection is too large.');
    }
    const summary = {
      purged: purged.results.filter((item) => item.outcome === 'purged').length,
      skipped: purged.results.filter((item) => item.outcome === 'skipped').length,
      remaining: purged.remaining,
    };
    options.metrics?.increment(summary.purged > 0
      ? 'sync_trash_empty_total.purged' : 'sync_trash_empty_total.skipped');
    return Object.freeze({
      collectionId: input.collectionId,
      results: purged.results,
      summary: Object.freeze(summary),
    });
  } catch (error) {
    if (error instanceof SyncTombstonePurgeFenceLostError) {
      options.metrics?.increment('sync_trash_empty_total.fence_lost');
      throw Object.assign(new Error('Trash empty lease fence was lost.'), { code: 'command_in_progress' });
    }
    throw error;
  }
}

async function countRestorable(transaction: DatabaseTransaction, collectionId: string): Promise<number> {
  const row = await transaction.selectFrom('sync_node_tombstones as tombstone')
    .innerJoin('nodes as node', (join) => join
      .onRef('node.collection_id', '=', 'tombstone.collection_id')
      .onRef('node.id', '=', 'tombstone.target_id'))
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('tombstone.collection_id', '=', collectionId)
    .where('tombstone.payload_purged_at', 'is', null)
    .where('node.deleted_at', 'is not', null)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
