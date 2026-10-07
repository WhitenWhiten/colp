import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Corrective expand-only migration for the ND owner-membership trigger.
 *
 * The initial digest migration used polymorphic OLD/NEW trigger records and
 * PostgreSQL resolved `OLD.role` even for digest_series rows.  That made every
 * series INSERT fail at commit time.  CREATE OR REPLACE fixes existing
 * installations without dropping any report data or ledger identities.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION validate_digest_series_owner_membership() RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE target_series text;
    DECLARE owner_subject text;
    BEGIN
      IF TG_TABLE_NAME = 'digest_members' THEN
        IF TG_OP = 'DELETE' AND OLD.role = 'owner' THEN
          RAISE EXCEPTION 'digest owner membership cannot be revoked' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.role = 'owner'
           AND (NEW.role <> 'owner' OR NEW.revoked_at IS NOT NULL OR NEW.subject_id IS DISTINCT FROM OLD.subject_id) THEN
          RAISE EXCEPTION 'digest owner membership cannot be downgraded' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF TG_TABLE_NAME = 'digest_series' THEN
        target_series := NEW.id;
      ELSIF TG_OP = 'DELETE' THEN
        target_series := OLD.series_id;
      ELSE
        target_series := NEW.series_id;
      END IF;
      SELECT owner_subject_id INTO owner_subject FROM digest_series WHERE id = target_series;
      IF owner_subject IS NULL OR NOT EXISTS (
        SELECT 1 FROM digest_members
         WHERE series_id = target_series AND subject_id = owner_subject
           AND role = 'owner' AND revoked_at IS NULL
      ) THEN
        RAISE EXCEPTION 'digest series must retain an active owner membership' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END
  $body$`.execute(db);
}

/** Expand-only: report tables and the corrected trigger remain retained. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty.
}

export const migration: Migration = { up, down };
export default migration;
