import { sql, type Kysely } from 'kysely';
import { currentSchema, qualified, quoteIdentifier } from './lib/classification-credits-schema.js';

/** CR-02: durable execution billing ownership. The credit tables are installed by CR-01 first. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE classification_provider_executions
    ADD COLUMN billing_mode text NOT NULL DEFAULT 'legacy_free'
      CHECK (billing_mode IN ('managed','byok','legacy_free')),
    ADD COLUMN credit_charge_id uuid,
    ADD COLUMN billing_owner_kind text NOT NULL DEFAULT 'execution'
      CHECK (billing_owner_kind IN ('execution','action'))`.execute(db);
  await sql`ALTER TABLE classification_provider_executions
    ADD CONSTRAINT classification_execution_credit_charge_fk
      FOREIGN KEY (principal_id, credit_charge_id)
      REFERENCES credit_charges(account_id, id)
      DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT classification_execution_billing_shape_check
      CHECK ((billing_mode = 'managed' AND credit_charge_id IS NOT NULL)
        OR (billing_mode IN ('byok','legacy_free') AND credit_charge_id IS NULL))`.execute(db);
  await sql`CREATE INDEX classification_executions_credit_charge_idx
    ON classification_provider_executions(principal_id, credit_charge_id)
    WHERE credit_charge_id IS NOT NULL`.execute(db);
  await sql`UPDATE classification_provider_executions SET billing_owner_kind='action'
    WHERE command_scope='collections:classification-run-action:v1'`.execute(db);
  await sql`CREATE UNIQUE INDEX classification_execution_owned_charge_idx
    ON classification_provider_executions(principal_id,credit_charge_id)
    WHERE billing_owner_kind='execution' AND credit_charge_id IS NOT NULL`.execute(db);
  const schema=await currentSchema(db);
  await sql.raw(`CREATE FUNCTION ${qualified(schema,'classification_execution_billing_guard')}() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,${quoteIdentifier(schema)} AS $function$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF (NEW.billing_mode,NEW.credit_charge_id,NEW.billing_owner_kind) IS DISTINCT FROM
           (OLD.billing_mode,OLD.credit_charge_id,OLD.billing_owner_kind)
          OR (OLD.billing_mode='managed' AND
            (NEW.principal_id,NEW.collection_id,NEW.command_scope,NEW.command_id) IS DISTINCT FROM
            (OLD.principal_id,OLD.collection_id,OLD.command_scope,OLD.command_id)) THEN
          RAISE EXCEPTION 'classification billing ownership is immutable' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.credit_charge_id IS NOT NULL AND EXISTS(SELECT 1 FROM ${qualified(schema,'credit_charges')}
        WHERE account_id=OLD.principal_id AND id=OLD.credit_charge_id AND state='reserved') THEN
        RAISE EXCEPTION 'classification billing owner must terminate before deletion' USING ERRCODE='42501';
      END IF;
      RETURN OLD;
    END $function$`).execute(db);
  await sql.raw(`REVOKE ALL ON FUNCTION ${qualified(schema,'classification_execution_billing_guard')}() FROM PUBLIC`).execute(db);
  await sql`CREATE TRIGGER classification_execution_billing_guard BEFORE UPDATE OR DELETE
    ON classification_provider_executions FOR EACH ROW EXECUTE FUNCTION classification_execution_billing_guard()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const occupied=await sql`SELECT 1 FROM classification_provider_executions WHERE billing_mode='managed' LIMIT 1`.execute(db);
  if(occupied.rows.length)throw new Error('Execution billing bindings must be retained for managed history');
  await sql`DROP TRIGGER IF EXISTS classification_execution_billing_guard ON classification_provider_executions`.execute(db);
  await sql`DROP FUNCTION IF EXISTS classification_execution_billing_guard()`.execute(db);
  await sql`DROP INDEX IF EXISTS classification_execution_owned_charge_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS classification_executions_credit_charge_idx`.execute(db);
  await sql`ALTER TABLE classification_provider_executions
    DROP CONSTRAINT IF EXISTS classification_execution_billing_shape_check,
    DROP CONSTRAINT IF EXISTS classification_execution_credit_charge_fk,
    DROP COLUMN IF EXISTS billing_owner_kind,
    DROP COLUMN IF EXISTS credit_charge_id,
    DROP COLUMN IF EXISTS billing_mode`.execute(db);
}
