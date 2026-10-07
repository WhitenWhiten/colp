import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Durable keyset cursor for report source-cache invalidation fan-out.
 *
 * A source can be referenced by more than 1,000 report series.  The outbox
 * handler processes one bounded page, persists `after_slug`, and asks the
 * generic worker for a continuation.  The cursor intentionally has no FK to
 * collections: a source may be soft/hard deleted while its invalidation is
 * draining, and the event must remain replayable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS digest_source_invalidation_progress (
    domain_event_id text PRIMARY KEY REFERENCES resource_id_ledger(resource_id) ON DELETE RESTRICT,
    collection_id text NOT NULL,
    after_slug text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT digest_source_invalidation_progress_collection_check
      CHECK (length(collection_id) BETWEEN 1 AND 256 AND collection_id !~ '[[:cntrl:]]'),
    CONSTRAINT digest_source_invalidation_progress_cursor_check
      CHECK (after_slug IS NULL OR (length(after_slug) BETWEEN 3 AND 63
        AND after_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'))
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS digest_source_invalidation_progress_collection_idx
    ON digest_source_invalidation_progress(collection_id, after_slug, domain_event_id)`.execute(db);
  await sql`COMMENT ON TABLE digest_source_invalidation_progress IS
    'append/replay-safe keyset cursor for bounded report source invalidation fan-out'`.execute(db);
}

/** Expand-only: cursors are retained with their outbox event for replay/audit. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty. Progress rows must remain replayable during rollback.
}

export const migration: Migration = { up, down };
export default migration;
