import { sql, type Kysely, type Migration } from 'kysely';

/**
 * FIX-M-011 (SYNC-R06): widen the Conflict immutability trigger with exactly
 * one additional in-place transition — key-rotation re-encryption. The drain
 * tool rewrites only the private_payload_* columns of an open Conflict while
 * status/revision/resolution fields stay untouched; every other UPDATE or any
 * DELETE remains forbidden.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER sync_conflicts_immutable ON sync_conflicts`.execute(db);
  await sql`DROP FUNCTION forbid_sync_conflict_mutation()`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_conflict_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.status = 'open' AND NEW.status = 'resolved'
        AND NEW.revision <> OLD.revision
        AND (to_jsonb(NEW) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at',
          'sync_stream_kind']::text[])
          = (to_jsonb(OLD) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at',
          'sync_stream_kind']::text[])
      THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE'
        AND OLD.status = 'open' AND NEW.status = 'open'
        AND (to_jsonb(NEW) - ARRAY['private_payload_ciphertext','private_payload_iv',
          'private_payload_auth_tag','private_payload_key_version','private_payload_digest',
          'sync_stream_kind']::text[])
          = (to_jsonb(OLD) - ARRAY['private_payload_ciphertext','private_payload_iv',
          'private_payload_auth_tag','private_payload_key_version','private_payload_digest',
          'sync_stream_kind']::text[])
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'sync Conflict is immutable outside resolution and payload re-encryption'
        USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_conflicts_immutable
    BEFORE UPDATE OR DELETE ON sync_conflicts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_conflict_mutation()`.execute(db);
}

/** Developer-only destructive rollback; drain any already-rotated Conflicts first. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER sync_conflicts_immutable ON sync_conflicts`.execute(db);
  await sql`DROP FUNCTION forbid_sync_conflict_mutation()`.execute(db);
  await sql`CREATE FUNCTION forbid_sync_conflict_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE'
        AND OLD.status = 'open' AND NEW.status = 'resolved'
        AND NEW.revision <> OLD.revision
        AND (to_jsonb(NEW) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at',
          'sync_stream_kind']::text[])
          = (to_jsonb(OLD) - ARRAY['status','revision','resolved_by_operation_id',
          'resolved_by_principal_id','resolution','resolution_result_json','resolved_at',
          'sync_stream_kind']::text[])
      THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'sync Conflict is immutable outside its one open to resolved transition'
        USING ERRCODE = '23514';
    END
  $$`.execute(db);
  await sql`CREATE TRIGGER sync_conflicts_immutable
    BEFORE UPDATE OR DELETE ON sync_conflicts
    FOR EACH ROW EXECUTE FUNCTION forbid_sync_conflict_mutation()`.execute(db);
}

export const migration: Migration = { up, down };
