import { sql, type Kysely, type Migration } from 'kysely';

/** P3-06 expand: an internal CAS fence plus a database terminal-retirement backstop. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sync_replicas ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT sync_replicas_lifecycle_revision_check CHECK (lifecycle_revision >= 0)`.execute(db);

  await sql`CREATE FUNCTION enforce_sync_replica_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.retired_at IS NOT NULL AND (
        NEW.status IS DISTINCT FROM OLD.status OR
        NEW.retired_at IS DISTINCT FROM OLD.retired_at OR
        NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR
        NEW.lease_id IS DISTINCT FROM OLD.lease_id OR
        NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at OR
        NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at OR
        NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision OR
        NEW.checkpoint_cursor IS DISTINCT FROM OLD.checkpoint_cursor OR
        NEW.checkpoint_commit_ordinal IS DISTINCT FROM OLD.checkpoint_commit_ordinal OR
        NEW.wire_json IS DISTINCT FROM OLD.wire_json
      ) THEN
        RAISE EXCEPTION 'retired Replica lifecycle is terminal';
      END IF;
      RETURN NEW;
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_replicas_terminal_retirement
    BEFORE UPDATE ON sync_replicas
    FOR EACH ROW EXECUTE FUNCTION enforce_sync_replica_terminal()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS sync_replicas_terminal_retirement ON sync_replicas`.execute(db);
  await sql`DROP FUNCTION IF EXISTS enforce_sync_replica_terminal()`.execute(db);
  await sql`ALTER TABLE sync_replicas DROP CONSTRAINT IF EXISTS sync_replicas_lifecycle_revision_check,
    DROP COLUMN IF EXISTS lifecycle_revision`.execute(db);
}

export const migration: Migration = { up, down };
