import { sql, type Kysely } from 'kysely';
import { currentSchema, qualified, quoteIdentifier } from './lib/classification-credits-schema.js';

/** Application roles lock financial rows through a fixed-schema function, never direct UPDATE grants. */
export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = await currentSchema(db);
  const q = (name: string) => qualified(schema, name);
  await sql.raw(`CREATE FUNCTION ${q('credit_lock_financial_rows')}(p_account_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${quoteIdentifier(schema)} AS $function$
    BEGIN
      -- The account-bound port requires L0/L1 before the caller's business locks.
      -- Acquire all L6 rows in the same order before finishing multiple charges.
      PERFORM id FROM ${q('credit_grants')} WHERE account_id=p_account_id
        ORDER BY expires_at NULLS LAST,created_at,id FOR UPDATE;
      PERFORM id FROM ${q('credit_charges')} WHERE account_id=p_account_id AND state='reserved'
        ORDER BY id FOR UPDATE;
      PERFORM charge_id,grant_id FROM ${q('credit_allocations')} WHERE account_id=p_account_id
        ORDER BY charge_id,grant_id FOR UPDATE;
    END $function$`).execute(db);
  await sql.raw(`REVOKE ALL ON FUNCTION ${q('credit_lock_financial_rows')}(text) FROM PUBLIC`).execute(db);
  await sql.raw(`DO $block$ BEGIN
    IF to_regrole('known_credits_app') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION ${q('credit_lock_financial_rows')}(text) TO known_credits_app;
    END IF;
  END $block$`).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const schema = await currentSchema(db);
  await sql.raw(`DROP FUNCTION ${qualified(schema, 'credit_lock_financial_rows')}(text)`).execute(db);
}
