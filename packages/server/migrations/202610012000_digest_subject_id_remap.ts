import { sql, type Kysely, type Migration } from 'kysely';

/**
 * Seed / T-03 remaps `accounts.subject_id` from `sub-uNN` onto the mapped
 * Better Auth `user.id`. Digest owner/member columns copy that subject and
 * point at `accounts(subject_id)` with an owner-membership guard.
 *
 * Immediate FKs reject rewriting the copies before `accounts`, and rewriting
 * `accounts` first orphans the copies. The owner-member trigger also treated a
 * subject rewrite as a downgrade. Expand-only: make those FKs deferrable and
 * allow a subject rewrite that stays an active owner. Empty `down` keeps the
 * objects, so `up` must be re-entrant. Phase-1 `DROP TABLE accounts CASCADE`
 * can drop the named FKs while leaving the digest tables; add them back.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $reentrant$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'digest_series_owner_subject_id_fkey'
           AND connamespace = current_schema()::regnamespace
      ) THEN
        ALTER TABLE digest_series
          ADD CONSTRAINT digest_series_owner_subject_id_fkey
          FOREIGN KEY (owner_subject_id) REFERENCES accounts(subject_id)
          ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
      ELSE
        ALTER TABLE digest_series
          ALTER CONSTRAINT digest_series_owner_subject_id_fkey
          DEFERRABLE INITIALLY IMMEDIATE;
      END IF;
    END
    $reentrant$
  `.execute(db);
  await sql`
    DO $reentrant$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'digest_members_subject_id_fkey'
           AND connamespace = current_schema()::regnamespace
      ) THEN
        ALTER TABLE digest_members
          ADD CONSTRAINT digest_members_subject_id_fkey
          FOREIGN KEY (subject_id) REFERENCES accounts(subject_id)
          ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
      ELSE
        ALTER TABLE digest_members
          ALTER CONSTRAINT digest_members_subject_id_fkey
          DEFERRABLE INITIALLY IMMEDIATE;
      END IF;
    END
    $reentrant$
  `.execute(db);
  await sql`CREATE OR REPLACE FUNCTION validate_digest_series_owner_membership() RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE target_series text;
    DECLARE owner_subject text;
    BEGIN
      IF TG_TABLE_NAME = 'digest_members' THEN
        IF TG_OP = 'DELETE' THEN
          -- Constraint triggers are deferred. Seed withdraw deletes every
          -- member after editions/follows/schedules; at commit the owner row
          -- is already gone. Allow that empty-series teardown, but keep a
          -- live series from losing its owner.
          IF NOT EXISTS (SELECT 1 FROM digest_editions e WHERE e.series_id = OLD.series_id)
             AND NOT EXISTS (SELECT 1 FROM digest_follows f WHERE f.series_id = OLD.series_id)
             AND NOT EXISTS (SELECT 1 FROM digest_schedules s WHERE s.series_id = OLD.series_id)
          THEN
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

/** Expand-only: deferrable FKs and the remappable owner guard stay installed. */
export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally empty.
}

export const migration: Migration = { up, down };
export default migration;
