import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION schedule_replaced_avatar_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_object_id uuid;
  BEGIN
    IF TG_OP = 'UPDATE' AND NEW.avatar_url IS NOT DISTINCT FROM OLD.avatar_url THEN RETURN NEW; END IF;
    old_object_id := (regexp_match(OLD.avatar_url, '/api/v1/avatar/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$', 'i'))[1]::uuid;
    UPDATE avatar_objects SET cleanup_after=now() + interval '5 minutes'
      WHERE object_id=old_object_id AND uploader_account_id IS NOT NULL AND lifecycle_state='ready';
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END $$`.execute(db);
  await sql`CREATE TRIGGER avatar_reference_released AFTER UPDATE OF avatar_url OR DELETE ON profiles
    FOR EACH ROW EXECUTE FUNCTION schedule_replaced_avatar_cleanup()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER avatar_reference_released ON profiles`.execute(db);
  await sql`DROP FUNCTION schedule_replaced_avatar_cleanup()`.execute(db);
}
