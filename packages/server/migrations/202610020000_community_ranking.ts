import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CS-02 community hot ranking: durable projection storage plus the
 * first-accepted-vote authority.
 *
 * `community_vote_targets` records the instant of the FIRST accepted
 * up/down vote per (target kind, id, generation). It is written inside the
 * vote command's own transaction (upsert insert-or-ignore) so no write path
 * can bypass it; `firstVoteAt` never falls back to creation time.
 *
 * `community_rank_snapshots` + `community_rank_entries` are the durable
 * hot-v1 projection the GET /community/ranking pages from. The refresh
 * worker rebuilds them wholesale from `community_votes` — never from
 * historical outbox payloads — so the projection can be reconstructed after
 * any loss. Snapshots are pruned past the cursor-TTL retention horizon,
 * which is also what turns a still-valid cursor into snapshot_expired.
 *
 * Expand-only: new tables, no existing reader or writer is affected.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS community_vote_targets (
    target_kind text NOT NULL CHECK (target_kind IN ('collection','bookmark','digest_series','digest_edition')),
    target_id text NOT NULL,
    target_collection_id text,
    target_series_id text,
    target_generation text NOT NULL CHECK (length(target_generation) BETWEEN 1 AND 128),
    first_vote_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (target_kind, target_id, target_generation),
    CHECK (
      (target_kind = 'bookmark' AND target_collection_id IS NOT NULL AND target_series_id IS NULL)
      OR (target_kind = 'digest_edition' AND target_series_id IS NOT NULL AND target_collection_id IS NULL)
      OR (target_kind IN ('collection','digest_series') AND target_collection_id IS NULL AND target_series_id IS NULL)
    )
  )`.execute(db);

  // Backfill the authority from retained votes: the first accepted vote for
  // a generation is the oldest retained ±1 row against it.
  await sql`INSERT INTO community_vote_targets (
      target_kind, target_id, target_collection_id, target_series_id,
      target_generation, first_vote_at
    )
    SELECT target_kind, target_id, target_collection_id, target_series_id,
      target_generation, min(created_at)
    FROM community_votes
    GROUP BY target_kind, target_id, target_collection_id, target_series_id, target_generation
    ON CONFLICT (target_kind, target_id, target_generation) DO NOTHING`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS community_rank_snapshots (
    snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    score_version text NOT NULL CHECK (length(score_version) BETWEEN 1 AND 64),
    item_count integer NOT NULL CHECK (item_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS community_rank_snapshots_created_idx
    ON community_rank_snapshots (created_at)`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS community_rank_entries (
    snapshot_id bigint NOT NULL REFERENCES community_rank_snapshots(snapshot_id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 1),
    target_kind text NOT NULL CHECK (target_kind IN ('collection','bookmark','digest_series','digest_edition')),
    target_id text NOT NULL,
    target_collection_id text,
    target_series_id text,
    target_generation text NOT NULL CHECK (length(target_generation) BETWEEN 1 AND 128),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    href text NOT NULL CHECK (length(href) BETWEEN 1 AND 8192),
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    language text,
    up integer NOT NULL CHECK (up BETWEEN 0 AND 2147483647),
    down integer NOT NULL CHECK (down BETWEEN 0 AND 2147483647),
    first_vote_at timestamptz,
    hot double precision NOT NULL,
    PRIMARY KEY (snapshot_id, position),
    CHECK (
      (target_kind = 'bookmark' AND target_collection_id IS NOT NULL AND target_series_id IS NULL)
      OR (target_kind = 'digest_edition' AND target_series_id IS NOT NULL AND target_collection_id IS NULL)
      OR (target_kind IN ('collection','digest_series') AND target_collection_id IS NULL AND target_series_id IS NULL)
    )
  )`.execute(db);
}

/** Expand-only contract: production rollback is flag-off; never run migration down. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. These tables are retained for rollback safety and auditability.
}

export const migration: Migration = { up, down };
export default migration;
