import { sql, type Kysely, type Migration } from 'kysely';

/** Expand-only collection follow relation. N-1 binaries ignore this table. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE collection_follows (
    collection_id text NOT NULL,
    follower_profile_id text NOT NULL,
    followed_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT collection_follows_pkey PRIMARY KEY (collection_id,follower_profile_id),
    CONSTRAINT collection_follows_collection_fk FOREIGN KEY (collection_id)
      REFERENCES collections(id) ON DELETE CASCADE,
    CONSTRAINT collection_follows_follower_profile_fk FOREIGN KEY (follower_profile_id)
      REFERENCES profiles(account_id) ON DELETE CASCADE,
    CONSTRAINT collection_follows_followed_at_finite CHECK (
      followed_at > '-infinity'::timestamptz AND followed_at < 'infinity'::timestamptz
    )
  )`.execute(db);
  await sql`COMMENT ON COLUMN collection_follows.collection_id IS
    'Stable Collection OpaqueId; never a publication slug.'`.execute(db);
  await sql`COMMENT ON COLUMN collection_follows.follower_profile_id IS
    'Stable identity-owned Profile id; currently profiles.account_id, never a mutable handle.'`.execute(db);
  await sql`COMMENT ON COLUMN collection_follows.followed_at IS
    'Canonical PostgreSQL transaction time for the immutable Collection Follow binding.'`.execute(db);

  await sql`CREATE INDEX collection_follows_follower_page_idx
    ON collection_follows(follower_profile_id,followed_at DESC,collection_id DESC)`.execute(db);

  await sql`CREATE FUNCTION forbid_collection_follow_binding_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
         OR NEW.follower_profile_id IS DISTINCT FROM OLD.follower_profile_id
         OR NEW.followed_at IS DISTINCT FROM OLD.followed_at THEN
        RAISE EXCEPTION 'Collection Follow binding and canonical time are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_follows_binding_immutable';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER collection_follows_binding_immutable
    BEFORE UPDATE ON collection_follows FOR EACH ROW
    EXECUTE FUNCTION forbid_collection_follow_binding_mutation()`.execute(db);

  await sql`CREATE FUNCTION validate_collection_follow_lifecycle() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE
      locked_follower text;
      follower_subject text;
      locked_collection text;
      owner_subject text;
    BEGIN
      SELECT p.account_id, a.subject_id
        INTO locked_follower, follower_subject
        FROM profiles p JOIN accounts a ON a.id=p.account_id
       WHERE p.account_id=NEW.follower_profile_id
         AND a.status='active' AND a.deleted_at IS NULL
       FOR SHARE OF p,a;
      IF locked_follower IS NULL THEN
        RAISE EXCEPTION 'Collection Follow actor Profile is unavailable'
          USING ERRCODE = '23503', CONSTRAINT = 'collection_follows_follower_profile_active';
      END IF;

      SELECT c.id, c.owner_subject_id
        INTO locked_collection, owner_subject
        FROM collections c
       WHERE c.id=NEW.collection_id
         AND c.deleted_at IS NULL
         AND c.visibility IN ('public','unlisted')
       FOR SHARE OF c;
      IF locked_collection IS NULL THEN
        RAISE EXCEPTION 'Collection Follow target Collection is unavailable'
          USING ERRCODE = '23503', CONSTRAINT = 'collection_follows_collection_followable';
      END IF;

      IF follower_subject = owner_subject THEN
        RAISE EXCEPTION 'A Collection owner cannot follow their own collection.'
          USING ERRCODE = '23514', CONSTRAINT = 'collection_follows_owner_forbidden';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER collection_follows_lifecycle_guard
    BEFORE INSERT ON collection_follows FOR EACH ROW
    EXECUTE FUNCTION validate_collection_follow_lifecycle()`.execute(db);

  await sql`CREATE FUNCTION remove_collection_follows_for_inactive_account() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL THEN
        DELETE FROM collection_follows
         WHERE follower_profile_id=NEW.id;
      END IF;
      RETURN NULL;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER accounts_remove_inactive_collection_follows
    AFTER UPDATE OF status,deleted_at ON accounts FOR EACH ROW
    WHEN (NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL)
    EXECUTE FUNCTION remove_collection_follows_for_inactive_account()`.execute(db);
}

/** Developer-only destructive rollback; drain collection-follow writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS accounts_remove_inactive_collection_follows ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS remove_collection_follows_for_inactive_account()`.execute(db);
  await sql`DROP TABLE IF EXISTS collection_follows`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_collection_follow_lifecycle()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_collection_follow_binding_mutation()`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
