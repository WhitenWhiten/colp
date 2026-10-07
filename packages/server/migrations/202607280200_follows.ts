import { sql, type Kysely, type Migration } from 'kysely';

/** Expand-only P5-02 free-social Follow authority. N-1 binaries ignore this table. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE follows (
    actor_profile_id text NOT NULL,
    target_profile_id text NOT NULL,
    followed_at timestamptz NOT NULL DEFAULT current_timestamp,
    CONSTRAINT follows_pkey PRIMARY KEY (actor_profile_id,target_profile_id),
    CONSTRAINT follows_actor_profile_fk FOREIGN KEY (actor_profile_id)
      REFERENCES profiles(account_id) ON DELETE CASCADE,
    CONSTRAINT follows_target_profile_fk FOREIGN KEY (target_profile_id)
      REFERENCES profiles(account_id) ON DELETE CASCADE,
    CONSTRAINT follows_distinct_profiles CHECK (actor_profile_id <> target_profile_id),
    CONSTRAINT follows_followed_at_finite CHECK (
      followed_at > '-infinity'::timestamptz AND followed_at < 'infinity'::timestamptz
    )
  )`.execute(db);
  await sql`COMMENT ON COLUMN follows.actor_profile_id IS
    'Stable identity-owned Profile id; currently profiles.account_id, never a mutable handle.'`.execute(db);
  await sql`COMMENT ON COLUMN follows.target_profile_id IS
    'Stable identity-owned Profile id; currently profiles.account_id, never a mutable handle.'`.execute(db);
  await sql`COMMENT ON COLUMN follows.followed_at IS
    'Canonical PostgreSQL transaction time for the immutable Follow binding.'`.execute(db);

  await sql`CREATE INDEX follows_actor_page_idx
    ON follows(actor_profile_id,followed_at DESC,target_profile_id DESC)`.execute(db);
  await sql`CREATE INDEX follows_target_page_idx
    ON follows(target_profile_id,followed_at DESC,actor_profile_id DESC)`.execute(db);

  await sql`CREATE FUNCTION forbid_follow_binding_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.actor_profile_id IS DISTINCT FROM OLD.actor_profile_id
         OR NEW.target_profile_id IS DISTINCT FROM OLD.target_profile_id
         OR NEW.followed_at IS DISTINCT FROM OLD.followed_at THEN
        RAISE EXCEPTION 'Follow binding and canonical time are immutable'
          USING ERRCODE = '23514', CONSTRAINT = 'follows_binding_immutable';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER follows_binding_immutable
    BEFORE UPDATE ON follows FOR EACH ROW EXECUTE FUNCTION forbid_follow_binding_mutation()`.execute(db);

  // Share locks serialize Follow insertion with a concurrent Account lifecycle change.
  await sql`CREATE FUNCTION validate_follow_profile_lifecycle() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE
      locked_profile_id text;
      locked_profile_ids text[] := ARRAY[]::text[];
    BEGIN
      IF NEW.actor_profile_id = NEW.target_profile_id THEN
        RETURN NEW;
      END IF;

      -- SHARE conflicts with Account lifecycle's non-key UPDATE lock. Stable
      -- ordering also prevents reverse Follow pairs from deadlocking here.
      FOR locked_profile_id IN
        SELECT p.account_id
          FROM profiles p JOIN accounts a ON a.id=p.account_id
         WHERE p.account_id IN (NEW.actor_profile_id,NEW.target_profile_id)
           AND a.status='active' AND a.deleted_at IS NULL
         ORDER BY p.account_id
         FOR SHARE OF p,a
      LOOP
        locked_profile_ids := array_append(locked_profile_ids,locked_profile_id);
      END LOOP;

      IF NOT NEW.actor_profile_id = ANY(locked_profile_ids) THEN
        RAISE EXCEPTION 'Follow actor Profile is unavailable'
          USING ERRCODE = '23503', CONSTRAINT = 'follows_actor_profile_active';
      END IF;
      IF NOT NEW.target_profile_id = ANY(locked_profile_ids) THEN
        RAISE EXCEPTION 'Follow target Profile is unavailable'
          USING ERRCODE = '23503', CONSTRAINT = 'follows_target_profile_active';
      END IF;
      RETURN NEW;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER follows_profile_lifecycle_guard
    BEFORE INSERT OR UPDATE ON follows FOR EACH ROW
    EXECUTE FUNCTION validate_follow_profile_lifecycle()`.execute(db);

  await sql`CREATE FUNCTION remove_follows_for_inactive_account() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL THEN
        DELETE FROM follows
         WHERE actor_profile_id=NEW.id OR target_profile_id=NEW.id;
      END IF;
      RETURN NULL;
    END
    $function$`.execute(db);
  await sql`CREATE TRIGGER accounts_remove_inactive_follows
    AFTER UPDATE OF status,deleted_at ON accounts FOR EACH ROW
    WHEN (NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL)
    EXECUTE FUNCTION remove_follows_for_inactive_account()`.execute(db);
}

/** Developer-only destructive rollback; drain P5-02 writers before migrating down. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS accounts_remove_inactive_follows ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS remove_follows_for_inactive_account()`.execute(db);
  await sql`DROP TABLE IF EXISTS follows`.execute(db);
  await sql`DROP FUNCTION IF EXISTS validate_follow_profile_lifecycle()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS forbid_follow_binding_mutation()`.execute(db);
}

export const migration: Migration = { up, down };
export default migration;
