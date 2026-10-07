import { sql, type Kysely } from 'kysely';
import { qualified, quoteIdentifier } from './classification-credits-schema.js';

export async function installCreditMutationGuard(db: Kysely<unknown>, schema: string): Promise<void> {
  const accounts = qualified(schema, 'accounts');
  const guard = qualified(schema, 'credit_mutation_guard');
  const internalSetting = `current_setting('known.credits_internal_xact', true) IS NOT DISTINCT FROM txid_current()::text`;
  const deleteSetting = `current_setting('known.credits_account_delete', true) = OLD.account_id
    AND NOT EXISTS(SELECT 1 FROM ${accounts} owner_account WHERE owner_account.id=OLD.account_id)`;
  await sql.raw(`CREATE OR REPLACE FUNCTION ${guard}() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, ${quoteIdentifier(schema)} AS $function$
    BEGIN
      IF TG_OP = 'DELETE' AND ${deleteSetting} THEN RETURN OLD; END IF;
      IF NOT ${internalSetting} THEN
        RAISE EXCEPTION 'credit table mutation is function-owned' USING ERRCODE = '42501';
      END IF;
      IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'credit_grants'
        AND (to_jsonb(OLD) - ARRAY['reserved_amount','spent_amount','expired_amount','expiry_processed_at'])
          IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['reserved_amount','spent_amount','expired_amount','expiry_processed_at']) THEN
        RAISE EXCEPTION 'credit grant ownership fields are immutable' USING ERRCODE = '42501';
      END IF;
      IF TG_OP='UPDATE' AND TG_TABLE_NAME='credit_grants' THEN
        IF NEW.spent_amount<OLD.spent_amount OR NEW.expired_amount<OLD.expired_amount
          OR (OLD.expiry_processed_at IS NOT NULL AND NEW.expiry_processed_at IS DISTINCT FROM OLD.expiry_processed_at) THEN
          RAISE EXCEPTION 'credit grant terminal counters are immutable' USING ERRCODE='42501';
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'credit_charges'
        AND (to_jsonb(OLD) - ARRAY['state','settled_amount','refunded_amount','completed_at'])
          IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','settled_amount','refunded_amount','completed_at']) THEN
        RAISE EXCEPTION 'credit charge ownership fields are immutable' USING ERRCODE = '42501';
      END IF;
      IF TG_OP='UPDATE' AND TG_TABLE_NAME='credit_charges' THEN
        IF NEW.refunded_amount<OLD.refunded_amount OR (OLD.state<>'reserved'
          AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)) THEN
          RAISE EXCEPTION 'credit charge terminal state is immutable' USING ERRCODE='42501';
        END IF;
      END IF;
      IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'credit_allocations' THEN
        RAISE EXCEPTION 'credit allocations are immutable' USING ERRCODE = '42501';
      END IF;
      IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'credit_accounts'
        AND (to_jsonb(OLD) - ARRAY['last_sequence','integrity_blocked','integrity_issue_count']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['last_sequence','integrity_blocked','integrity_issue_count']) THEN
        RAISE EXCEPTION 'credit account identity is immutable' USING ERRCODE = '42501';
      END IF;
      IF TG_OP='UPDATE' AND TG_TABLE_NAME='credit_accounts' THEN
        IF NEW.last_sequence<>OLD.last_sequence AND NEW.last_sequence<>OLD.last_sequence+1 THEN
          RAISE EXCEPTION 'credit account sequence must advance once' USING ERRCODE='42501';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credit account cleanup required' USING ERRCODE='42501'; END IF;
      RETURN NEW;
    END
    $function$`).execute(db);
}
