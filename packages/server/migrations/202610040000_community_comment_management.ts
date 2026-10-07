import { sql, type Kysely, type Migration } from 'kysely';

/**
 * CS-04 community comment management: curation overlay + comment-area
 * settings.
 *
 * Three independent revision/ETag authorities exist by design:
 *   1. `community_comments.revision` — author edits and author deletion.
 *   2. `community_comment_curations.revision` — curator hide/unhide.
 *   3. `community_comment_settings.revision` — curator lock/unlock.
 * They are never interchangeable; each mutation path CAS-es on its own
 * revision only.
 *
 * `community_comment_curations` holds one row per comment *only after* a
 * curator first writes to it: the absent row is the virtual default
 * (`hidden=false`, revision 1); the first successful CAS write stores
 * revision 2. `hidden=false` removes only this curator
 * overlay — it can never resurrect an author-deleted tombstone, and it
 * never touches `community_comments.state`, so author deletion stays
 * permanent and independent. `reason` stores the reason of the last write
 * (hide or unhide); the wire projection exposes it only while hidden.
 * `updated_by_account_id` records the last operator for audit; the
 * immutable per-write evidence lives in `audit_events`.
 *
 * `community_comment_settings` holds one row per comment-area target
 * (kind + id, with the same closed parent columns as the comments table).
 * It is generation-independent on purpose: locking a bookmark's comment
 * area must survive a source-URL generation advance, while comments
 * themselves remain generation-pinned. The absent row is the virtual
 * default (`locked=false`, revision 1, updatedAt = target created_at);
 * the first successful CAS write stores revision 2.
 *
 * Deliberately NOT marked `known.append_heavy=true`: both relations are
 * mutable singleton-per-resource rows (CAS-updated), not append-only
 * ledgers — same precedent as `community_votes`.
 *
 * Expand-only: new tables and indexes, no existing reader or writer is
 * affected. Empty `down` leaves objects in place, so `up` must be
 * re-entrant after Kysely forgets the migration row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS community_comment_curations (
    comment_id text PRIMARY KEY REFERENCES community_comments(comment_id) ON DELETE RESTRICT
      CHECK (length(comment_id) BETWEEN 1 AND 128),
    hidden boolean NOT NULL,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_by_account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS community_comment_settings (
    target_kind text NOT NULL CHECK (target_kind IN ('collection','bookmark','digest_series','digest_edition')),
    target_id text NOT NULL,
    target_collection_id text,
    target_series_id text,
    locked boolean NOT NULL,
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_by_account_id text NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (target_kind, target_id),
    CHECK (
      (target_kind = 'bookmark' AND target_collection_id IS NOT NULL AND target_series_id IS NULL)
      OR (target_kind = 'digest_edition' AND target_series_id IS NOT NULL AND target_collection_id IS NULL)
      OR (target_kind IN ('collection','digest_series') AND target_collection_id IS NULL AND target_series_id IS NULL)
    )
  )`.execute(db);

  // Reverse lookup for housekeeping/inspection: which comments did an
  // account last curate. The primary key already serves comment_id reads.
  await sql`CREATE INDEX IF NOT EXISTS community_comment_curations_operator_idx
    ON community_comment_curations (updated_by_account_id, updated_at DESC)`.execute(db);
}

/** Expand-only contract: production rollback is flag-off; never run migration down. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. These tables are retained for rollback safety and auditability.
}

export const migration: Migration = { up, down };
export default migration;
