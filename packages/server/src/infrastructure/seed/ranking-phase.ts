import { createPostgresCommunityRankingRefreshUnitOfWork } from '../community/index.js';
import { refreshCommunityRanking } from '../../modules/community/index.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import { SeedError } from './manifest.js';

/**
 * Wave 17: rebuild the durable hot-v1 ranking snapshot from the votes and
 * official hide/delist rows that data.sql just committed. Explore's hot
 * board pages this projection, not live vote counts — without a snapshot
 * the board stays empty until the rank-refresh worker happens to run.
 *
 * Snapshots use an identity primary key, so they are not registered in
 * seed_rows. Withdraw auto-cleans community_rank_snapshots (entries
 * cascade). Re-apply of a new version rebuilds a fresh snapshot after
 * votes and moderation actions exist.
 */
export async function runCommunityRankingSeedPhase(
  runtime: DatabaseRuntime,
): Promise<{ readonly snapshotId: string; readonly itemCount: number }> {
  try {
    const result = await createPostgresCommunityRankingRefreshUnitOfWork(runtime.db, runtime.cancelBackend)
      .execute((ports) => refreshCommunityRanking(ports));
    if (result.itemCount < 1) {
      throw new SeedError(
        'ranking_snapshot_empty',
        'community ranking seed phase wrote a snapshot with 0 eligible targets',
      );
    }
    return { snapshotId: result.snapshotId, itemCount: result.itemCount };
  } catch (error) {
    if (error instanceof SeedError) throw error;
    throw new SeedError(
      'ranking_snapshot_failed',
      `community ranking seed phase failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
