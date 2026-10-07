import { sql, type Kysely } from 'kysely';

/** Expand-only P2B-15 private Saved Resource authority. N-1 binaries ignore these rows. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE audit_events ALTER COLUMN operation_id DROP NOT NULL,
    ALTER COLUMN collection_id DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE audit_events ADD CONSTRAINT audit_events_authority_pair_check CHECK (
    (operation_id IS NULL AND collection_id IS NULL) OR
    (operation_id IS NOT NULL AND collection_id IS NOT NULL)
  )`.execute(db);
  await sql`CREATE TABLE saved_resources (
    id bigserial PRIMARY KEY,
    account_id text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    saved_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    CONSTRAINT saved_resources_account_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    CONSTRAINT saved_resources_target_type_check CHECK (resource_type IN ('collection','node')),
    CONSTRAINT saved_resources_target_id_check CHECK (length(resource_id) BETWEEN 1 AND 512),
    CONSTRAINT saved_resources_time_order_check CHECK (updated_at >= saved_at),
    CONSTRAINT saved_resources_deletion_facts_check CHECK (deleted_at IS NULL OR deleted_at = updated_at)
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX saved_resources_live_target_uidx
    ON saved_resources(account_id,resource_type,resource_id) WHERE deleted_at IS NULL`.execute(db);
  await sql`CREATE INDEX saved_resources_account_order_idx
    ON saved_resources(account_id,saved_at DESC,resource_type ASC,resource_id ASC)
    WHERE deleted_at IS NULL`.execute(db);
}

/**
 * Developer-only destructive rollback. The old NOT NULL audit authority cannot be
 * restored while any Operation-less audit row remains, and that NULL pair is shared
 * with Reading Progress and future modules, so down refuses with counts before any
 * destructive statement instead of deleting audit history. Production rollback keeps
 * this expand migration installed (forward recovery); an operator may back up and
 * explicitly remove the counted rows, then retry.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$
    DECLARE
      saved_count bigint;
      progress_count bigint;
      other_count bigint;
    BEGIN
      SELECT count(*) FILTER (WHERE event_type LIKE 'saved_resource.%'),
             count(*) FILTER (WHERE event_type LIKE 'reading_progress.%'),
             count(*) - count(*) FILTER (WHERE event_type LIKE 'saved_resource.%')
                     - count(*) FILTER (WHERE event_type LIKE 'reading_progress.%')
        INTO saved_count, progress_count, other_count
        FROM audit_events
        WHERE operation_id IS NULL AND collection_id IS NULL;
      IF saved_count + progress_count + other_count > 0 THEN
        RAISE EXCEPTION
          'saved_resources down refused: % privacy-minimal audit_events remain (saved_resource=%, reading_progress=%, other=%); restoring NOT NULL would require deleting audit history that other modules may own. Back up and explicitly remove these rows first, or keep the expand schema installed (forward recovery).',
          saved_count + progress_count + other_count, saved_count, progress_count, other_count;
      END IF;
    END
  $$`.execute(db);
  await sql`DROP TABLE IF EXISTS saved_resources`.execute(db);
  await sql`ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_authority_pair_check`.execute(db);
  await sql`ALTER TABLE audit_events ALTER COLUMN operation_id SET NOT NULL,
    ALTER COLUMN collection_id SET NOT NULL`.execute(db);
}
