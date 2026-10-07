import { sql, type Kysely } from 'kysely';

/** Backfill and transactionally enforce one persisted handle per active OIDC account. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $backfill$
    DECLARE
      candidate_account_id text;
      candidate_handle text;
      attempts integer;
    BEGIN
      FOR candidate_account_id IN
        SELECT a.id
          FROM accounts a
          JOIN account_identities i ON i.account_id = a.id
          LEFT JOIN profile_handles h ON h.account_id = a.id
         WHERE a.status = 'active' AND a.deleted_at IS NULL AND h.account_id IS NULL
         ORDER BY a.id
      LOOP
        attempts := 0;
        LOOP
          attempts := attempts + 1;
          candidate_handle := 'u-' || replace(gen_random_uuid()::text, '-', '');
          BEGIN
            INSERT INTO profile_handles(handle, account_id)
            VALUES (candidate_handle, candidate_account_id);
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            IF attempts >= 8 THEN
              RAISE EXCEPTION 'unable to reserve opaque profile handle for account %', candidate_account_id;
            END IF;
          END;
        END LOOP;
      END LOOP;
    END
    $backfill$
  `.execute(db);

  await sql`
    CREATE FUNCTION enforce_active_oidc_profile_handle() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE
      affected_account_id text;
      affected_account_ids text[];
    BEGIN
      IF TG_TABLE_NAME = 'accounts' THEN
        affected_account_ids := ARRAY[CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END];
      ELSIF TG_OP = 'INSERT' THEN
        affected_account_ids := ARRAY[NEW.account_id];
      ELSIF TG_OP = 'DELETE' THEN
        affected_account_ids := ARRAY[OLD.account_id];
      ELSE
        affected_account_ids := ARRAY[NEW.account_id, OLD.account_id];
      END IF;
      FOREACH affected_account_id IN ARRAY affected_account_ids LOOP
        IF EXISTS (
          SELECT 1 FROM accounts a
          JOIN account_identities i ON i.account_id = a.id
          WHERE a.id = affected_account_id
            AND a.status = 'active' AND a.deleted_at IS NULL
        ) AND NOT EXISTS (
          SELECT 1 FROM profile_handles h WHERE h.account_id = affected_account_id
        ) THEN
          RAISE EXCEPTION 'active OIDC account % requires a profile handle', affected_account_id
            USING ERRCODE = '23514', CONSTRAINT = 'active_oidc_account_requires_profile_handle';
        END IF;
      END LOOP;
      RETURN NULL;
    END
    $function$
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER accounts_require_oidc_handle
    AFTER INSERT OR UPDATE ON accounts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION enforce_active_oidc_profile_handle()
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER identities_require_oidc_handle
    AFTER INSERT OR UPDATE OR DELETE ON account_identities
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION enforce_active_oidc_profile_handle()
  `.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER handles_preserve_oidc_invariant
    AFTER INSERT OR UPDATE OR DELETE ON profile_handles
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION enforce_active_oidc_profile_handle()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS handles_preserve_oidc_invariant ON profile_handles`.execute(db);
  await sql`DROP TRIGGER IF EXISTS identities_require_oidc_handle ON account_identities`.execute(db);
  await sql`DROP TRIGGER IF EXISTS accounts_require_oidc_handle ON accounts`.execute(db);
  await sql`DROP FUNCTION IF EXISTS enforce_active_oidc_profile_handle()`.execute(db);
}
