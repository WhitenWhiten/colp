import { sql, type RawBuilder } from 'kysely';
import type { CommunityRankCandidate, CommunityRankingRefreshPorts } from '../../modules/community/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

type BuildInput = Parameters<NonNullable<CommunityRankingRefreshPorts['snapshots']['writeFromCandidates']>>[0];
const BATCH_SIZE = 512;

/** Keep JS scoring exact, while PostgreSQL performs the unbounded sort (and can spill). */
export async function writeStreamedCommunitySnapshot<Row>(transaction: DatabaseTransaction,
  candidates: RawBuilder<Row>, toCandidate: (row: Row) => CommunityRankCandidate, input: BuildInput,
): Promise<{ snapshotId: string; itemCount: number }> {
  const header = await sql<{ snapshot_id: string }>`
    insert into community_rank_snapshots(score_version,item_count,created_at)
    values (${input.scoreVersion},0,${input.createdAt}) returning snapshot_id::text
  `.execute(transaction);
  const snapshotId = header.rows[0]!.snapshot_id;
  await sql`CREATE TEMP TABLE known_rank_stage ON COMMIT DROP AS
    SELECT * FROM community_rank_entries WITH NO DATA`.execute(transaction);
  await sql`DECLARE known_rank_source NO SCROLL CURSOR FOR ${candidates}`.execute(transaction);
  const staging = transaction.withTables<{ known_rank_stage: DatabaseSchema['community_rank_entries'] }>();
  let itemCount = 0;
  for (;;) {
    const page = await sql<Row>`FETCH FORWARD 512 FROM known_rank_source`.execute(transaction);
    if (page.rows.length === 0) break;
    const entries = page.rows.map(row => {
      const entry = input.score(toCandidate(row));
      return { snapshot_id: BigInt(snapshotId), position: 0, target_kind: entry.target.kind,
        target_id: entry.target.id, target_collection_id: entry.target.collectionId,
        target_series_id: entry.target.seriesId, target_generation: entry.target.generation,
        title: entry.title, href: entry.href, tags: sql`${JSON.stringify(entry.tags)}::jsonb`,
        language: entry.language, up: entry.up, down: entry.down,
        first_vote_at: entry.firstVoteAt, hot: entry.hot };
    });
    await staging.insertInto('known_rank_stage').values(entries).execute();
    itemCount += entries.length;
    if (entries.length < BATCH_SIZE) break;
  }
  await sql`CLOSE known_rank_source`.execute(transaction);
  await sql`INSERT INTO community_rank_entries
    (snapshot_id,position,target_kind,target_id,target_collection_id,target_series_id,target_generation,
     title,href,tags,language,up,down,first_vote_at,hot)
    SELECT snapshot_id,row_number() over (order by hot desc,target_kind collate "C",target_id collate "C"),
      target_kind,target_id,target_collection_id,target_series_id,target_generation,
      title,href,tags,language,up,down,first_vote_at,hot FROM known_rank_stage`.execute(transaction);
  await sql`UPDATE community_rank_snapshots SET item_count=${itemCount}
    WHERE snapshot_id=${BigInt(snapshotId)}`.execute(transaction);
  return { snapshotId, itemCount };
}
