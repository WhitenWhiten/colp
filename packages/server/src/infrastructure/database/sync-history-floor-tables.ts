import type { Generated } from 'kysely';

/** V1 is intentionally restricted to the operation side of the mixed Pull stream. */
export interface SyncHistoryFloorTable {
  collection_id: string;
  floor_commit_ordinal: Generated<bigint>;
  floor_stream_kind: Generated<0>;
  floor_stable_id: Generated<string>;
  archive_segment_id: Generated<string | null>;
  state_revision: Generated<bigint>;
  advanced_at: Generated<Date>;
}
