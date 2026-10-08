import type { PoolClient } from 'pg';
import type { SnapshotNode } from '@know-n/colp/types';

export async function insertSnapshotNodeRows(client: PoolClient, snapshotId: string,
  nodes: readonly SnapshotNode[]): Promise<void> {
  const batchSize = 500;
  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize);
    const placeholders = batch.map((_, offset) => `($${offset * 3 + 1},$${offset * 3 + 2},$${offset * 3 + 3})`).join(',');
    const params: unknown[] = [];
    for (let row = 0; row < batch.length; row += 1) params.push(snapshotId, index + row, JSON.stringify(batch[row]!));
    await client.query(`insert into sync_bootstrap_snapshot_nodes(snapshot_id,node_index,node_json)
      values ${placeholders}`, params);
  }
}

/**
 * Best-effort bounded cleanup of expired Snapshots. Evidence-bearing rows are
 * never candidates; a concurrent FK race only skips this round.
 */
export async function cleanupExpiredSnapshots(client: PoolClient, collectionId: string,
  snapshotId: string): Promise<void> {
  await client.query('savepoint sync_snapshot_cleanup');
  try {
    await client.query(`delete from sync_bootstrap_snapshots as snapshot
      where snapshot.snapshot_id in (
        select candidate.snapshot_id from sync_bootstrap_snapshots as candidate
          where (candidate.snapshot_id=$1 or candidate.collection_id=$2)
            and candidate.expires_at<=current_timestamp
            and not exists (select 1 from sync_bootstrap_snapshot_pages page
              where page.snapshot_id=candidate.snapshot_id)
            and not exists (select 1 from sync_recovery_capabilities capability
              where capability.snapshot_id=candidate.snapshot_id)
            and not exists (select 1 from sync_recovery_ack_receipts receipt
              where receipt.snapshot_id=candidate.snapshot_id)
          order by candidate.expires_at
          limit 200)`, [snapshotId, collectionId]);
  } catch (error) {
    if (isSnapshotCleanupFkRace(error)) await client.query('rollback to savepoint sync_snapshot_cleanup');
    else throw error;
  }
}

function isSnapshotCleanupFkRace(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && String((error as { readonly code: unknown }).code) === '23503';
}
