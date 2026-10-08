import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  // Historical account_id remains governance attribution, never upload proof.
  await sql`ALTER TABLE avatar_objects
    ADD COLUMN uploader_account_id text REFERENCES accounts(id),
    ADD COLUMN lifecycle_state text NOT NULL DEFAULT 'legacy' CHECK (lifecycle_state IN ('legacy','preparing','ready','deleting','deleted')),
    ADD COLUMN cleanup_after timestamptz,
    ADD COLUMN lease_until timestamptz`.execute(db);
  await sql`CREATE INDEX avatar_cleanup_due ON avatar_objects(cleanup_after) WHERE uploader_account_id IS NOT NULL AND lifecycle_state <> 'deleted'`.execute(db);
  await sql`CREATE FUNCTION assert_avatar_reference() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE object_uuid uuid; owner_id text; object_state text;
  BEGIN
    IF TG_OP = 'UPDATE' AND NEW.avatar_url IS NOT DISTINCT FROM OLD.avatar_url THEN RETURN NEW; END IF;
    object_uuid := (regexp_match(NEW.avatar_url, '/api/v1/avatar/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$', 'i'))[1]::uuid;
    IF object_uuid IS NULL THEN RETURN NEW; END IF;
    SELECT uploader_account_id, lifecycle_state INTO owner_id, object_state FROM avatar_objects WHERE object_id = object_uuid FOR UPDATE;
    IF owner_id IS DISTINCT FROM NEW.account_id OR object_state IS DISTINCT FROM 'ready' THEN
      RAISE EXCEPTION 'avatar upload ownership is required' USING ERRCODE='23514', CONSTRAINT='avatar_upload_ownership';
    END IF;
    RETURN NEW;
  END $$`.execute(db);
  await sql`CREATE TRIGGER profile_avatar_upload_authority BEFORE INSERT OR UPDATE OF avatar_url ON profiles
    FOR EACH ROW EXECUTE FUNCTION assert_avatar_reference()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER profile_avatar_upload_authority ON profiles`.execute(db);
  await sql`DROP FUNCTION assert_avatar_reference()`.execute(db);
  await sql`DROP INDEX avatar_cleanup_due`.execute(db);
  await sql`ALTER TABLE avatar_objects DROP COLUMN uploader_account_id, DROP COLUMN lifecycle_state, DROP COLUMN cleanup_after, DROP COLUMN lease_until`.execute(db);
}
