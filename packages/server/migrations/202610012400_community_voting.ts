import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CS-01 community voting: durable vote state plus the bookmark target
 * generation fence.
 *
 * `community_votes` keeps one row per (account, target). `target_generation`
 * records the generation the vote was cast against; read paths filter on the
 * target's CURRENT generation so votes on superseded bookmark content never
 * migrate to new content.
 *
 * `community_bookmark_generations` is the opaque server-minted generation
 * authority for bookmark targets. A single AFTER trigger pair on `nodes`
 * mints a fresh generation for every bookmark INSERT and for every UPDATE
 * that changes `url` or `kind`. Because the trigger runs in the writer's own
 * transaction, every real URL mutation path (Product canonical mutation,
 * sync create/update, conflict resolution, restore, seed) is fenced without
 * relying on callers to remember a side write.
 *
 * The fence is semantic: the canonical mutation adapter pins the stored
 * raw `url` when a submitted spelling is normalization-equivalent (same
 * scheme/host after lowercasing, default port, hash removal, and trailing
 * slash collapse — see `normalizeBookmarkUrl`), so the trigger never
 * observes a non-semantic `url` drift and the generation survives. A
 * genuinely different URL still persists and rotates the generation.
 *
 * Expand-only: new tables and triggers, no existing reader or writer is
 * affected. Empty `down` leaves objects in place, so `up` must be re-entrant
 * after Kysely forgets the migration row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS community_votes (
    target_kind text NOT NULL CHECK (target_kind IN ('collection','bookmark','digest_series','digest_edition')),
    target_id text NOT NULL,
    target_collection_id text,
    target_series_id text,
    target_generation text NOT NULL CHECK (length(target_generation) BETWEEN 1 AND 128),
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    value smallint NOT NULL CHECK (value IN (-1, 1)),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, target_kind, target_id),
    CHECK (
      (target_kind = 'bookmark' AND target_collection_id IS NOT NULL AND target_series_id IS NULL)
      OR (target_kind = 'digest_edition' AND target_series_id IS NOT NULL AND target_collection_id IS NULL)
      OR (target_kind IN ('collection','digest_series') AND target_collection_id IS NULL AND target_series_id IS NULL)
    )
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS community_votes_target_idx
    ON community_votes (target_kind, target_id, target_generation)`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS community_bookmark_generations (
    collection_id text NOT NULL,
    node_id text NOT NULL,
    generation text NOT NULL CHECK (length(generation) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection_id, node_id),
    FOREIGN KEY (collection_id, node_id) REFERENCES nodes(collection_id, id) ON DELETE CASCADE
  )`.execute(db);

  await sql`CREATE OR REPLACE FUNCTION community_bookmark_generation_fence() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.kind = 'bookmark' AND NEW.url IS NOT NULL AND (
        TG_OP = 'INSERT'
        OR NEW.url IS DISTINCT FROM OLD.url
        OR NEW.kind IS DISTINCT FROM OLD.kind
      ) THEN
        INSERT INTO community_bookmark_generations (collection_id, node_id, generation, updated_at)
        VALUES (NEW.collection_id, NEW.id, 'bm-gen-' || replace(gen_random_uuid()::text, '-', ''), now())
        ON CONFLICT (collection_id, node_id) DO UPDATE
          SET generation = EXCLUDED.generation, updated_at = now();
      END IF;
      RETURN NEW;
    END
  $body$`.execute(db);
  await sql`
    DO $reentrant$
    BEGIN
      CREATE TRIGGER community_bookmark_generation_insert
        AFTER INSERT ON nodes FOR EACH ROW
        WHEN (NEW.kind = 'bookmark' AND NEW.url IS NOT NULL)
        EXECUTE FUNCTION community_bookmark_generation_fence();
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END
    $reentrant$
  `.execute(db);
  await sql`
    DO $reentrant$
    BEGIN
      CREATE TRIGGER community_bookmark_generation_update
        AFTER UPDATE OF url, kind ON nodes FOR EACH ROW
        WHEN (NEW.kind = 'bookmark' AND NEW.url IS NOT NULL)
        EXECUTE FUNCTION community_bookmark_generation_fence();
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END
    $reentrant$
  `.execute(db);

  // Backfill a generation for every existing bookmark (live or tombstoned)
  // so no pre-migration bookmark resolves with a null generation.
  await sql`INSERT INTO community_bookmark_generations (collection_id, node_id, generation)
    SELECT collection_id, id, 'bm-gen-' || replace(gen_random_uuid()::text, '-', '')
    FROM nodes WHERE kind = 'bookmark' AND url IS NOT NULL
    ON CONFLICT (collection_id, node_id) DO NOTHING`.execute(db);
}

/** Expand-only contract: production rollback is flag-off; never run migration down. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. These tables are retained for rollback safety and auditability.
}

export const migration: Migration = { up, down };
export default migration;
