import type { PoolClient } from 'pg';
import type { AuthoritativeParentRevision, SnapshotNode } from '@know-n/colp/types';

export async function insertSnapshotNodeRows(client: PoolClient, snapshotId: string,
  nodes: readonly SnapshotNode[], startOffset = 0,
  parentRevisions: readonly AuthoritativeParentRevision[] = []): Promise<void> {
  const parents = new Map(parentRevisions.map(parent => [parent.parentId, parent.childrenRevision]));
  const batchSize = 500;
  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize);
    const placeholders = batch.map((_, offset) => `($${offset * 4 + 1},$${offset * 4 + 2},$${offset * 4 + 3},$${offset * 4 + 4})`).join(',');
    const params: unknown[] = [];
    for (let row = 0; row < batch.length; row += 1) params.push(snapshotId, startOffset + index + row,
      JSON.stringify(batch[row]!), parents.get(batch[row]!.id) ?? null);
    await client.query(`insert into sync_bootstrap_snapshot_nodes(snapshot_id,node_index,node_json,children_revision)
      values ${placeholders}`, params);
  }
}

/** Read parent authority for this page; pre-expand rows fall back to their immutable header. */
export async function readSnapshotParentRevisions(client: PoolClient, snapshotId: string,
  rows: readonly { readonly node_json: SnapshotNode; readonly children_revision: string | null }[]): Promise<AuthoritativeParentRevision[]> {
  const parents = rows.filter(row => row.node_json.kind === 'root' || row.node_json.kind === 'folder');
  const missing = parents.filter(row => row.children_revision === null).map(row => row.node_json.id);
  const legacy = missing.length ? await client.query<{ value: AuthoritativeParentRevision }>(
    `select value from sync_bootstrap_snapshots s,
      jsonb_array_elements(coalesce(s.snapshot_json->'parentRevisions','[]'::jsonb)) as value
      where s.snapshot_id=$1 and value->>'parentId'=any($2::text[])`, [snapshotId, missing]) : undefined;
  const revisions = new Map(legacy?.rows.map(row => [row.value.parentId, row.value.childrenRevision]));
  return parents.map(row => {
    const childrenRevision = row.children_revision ?? revisions.get(row.node_json.id);
    if (!childrenRevision) throw new Error('Stored Snapshot parent revision is absent');
    return { parentId: row.node_json.id, childrenRevision };
  });
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
