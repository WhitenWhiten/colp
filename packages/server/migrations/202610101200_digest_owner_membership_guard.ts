import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Tighten the teardown exception introduced by the subject-id remap. An empty
 * active series still requires its owner membership; only a transaction whose
 * final state has removed the series may remove that owner row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION validate_digest_series_owner_membership() RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE target_series text;
    DECLARE owner_subject text;
    BEGIN
      IF TG_TABLE_NAME = 'digest_members' THEN
        IF TG_OP = 'DELETE' THEN
          -- Deferred execution observes the transaction's final state. Seed
          -- teardown is valid only after the owning series itself is gone.
          IF NOT EXISTS (SELECT 1 FROM digest_series s WHERE s.id = OLD.series_id) THEN
            RETURN OLD;
          END IF;
          IF OLD.role = 'owner' THEN
            RAISE EXCEPTION 'digest owner membership cannot be revoked' USING ERRCODE = '23514';
          END IF;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.role = 'owner'
           AND (NEW.role <> 'owner' OR NEW.revoked_at IS NOT NULL) THEN
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

/** Expand-only: the corrected invariant remains installed. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty.
}

export const migration: Migration = { up, down };
export default migration;
