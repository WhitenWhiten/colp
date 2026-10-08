import { sql, type Kysely } from 'kysely';
import {
  currentSchema,
  dropCreditTables,
  installCreditTables,
  qualified,
} from './lib/classification-credits-schema.js';
import {
  dropCreditFunctions,
  installCreditFunctions,
} from './lib/classification-credits-functions.js';
import {
  dropCreditFunding,
  installCreditFunding,
} from './lib/classification-credits-funding.js';

const BASE_FUNCTIONS = [
  { name: 'credit_lock_account', types: 'text,boolean' },
  { name: 'credit_balance', types: 'text,timestamptz' },
  { name: 'credit_append_entry', types: 'text,text,text,text,timestamptz,timestamptz,bigint,bigint,bigint,bigint,text,text,text,uuid,uuid,uuid,timestamptz,jsonb,timestamptz' },
  { name: 'credit_expiry_pending_count', types: 'text' },
  { name: 'credit_reconcile_expired', types: 'text,timestamptz' },
  { name: 'credit_reserve', types: 'text,uuid,text,text,bigint,text,text,text,text,jsonb,timestamptz' },
  { name: 'credit_finish', types: 'text,uuid,boolean,text' },
  { name: 'credit_operator_authorized', types: '' },
] as const;

async function configureCreditPrivileges(db: Kysely<unknown>, schema: string): Promise<void> {
  const financeTables = ['credit_accounts','credit_grants','credit_charges','credit_allocations','credit_ledger_entries']
    .map(name => qualified(schema,name)).join(',');
  await sql.raw(`REVOKE ALL ON ${financeTables} FROM PUBLIC`).execute(db);
  for (const fn of BASE_FUNCTIONS) {
    await sql.raw(`REVOKE ALL ON FUNCTION "${schema}"."${fn.name}"(${fn.types}) FROM PUBLIC`).execute(db);
  }
  await sql.raw(`DO $block$
  DECLARE schema_name text := '${schema.replaceAll("'", "''")}';
  BEGIN
    IF to_regrole('known_credits_app') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL ON ${financeTables} FROM known_credits_app';
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO known_credits_app', schema_name);
      EXECUTE format('GRANT SELECT ON %I.credit_accounts, %I.credit_grants, %I.credit_charges,
        %I.credit_allocations, %I.credit_ledger_entries TO known_credits_app',
        schema_name, schema_name, schema_name, schema_name, schema_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.credit_lock_account(text,boolean) TO known_credits_app', schema_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.credit_balance(text,timestamptz) TO known_credits_app', schema_name);
      IF schema_name='public' THEN
        GRANT USAGE ON SCHEMA known_credits TO known_credits_app;
        GRANT EXECUTE ON FUNCTION known_credits.reconcile_expired_credits(text) TO known_credits_app;
      END IF;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.credit_reserve(text,uuid,text,text,bigint,text,text,text,text,jsonb,timestamptz) TO known_credits_app', schema_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.credit_finish(text,uuid,boolean,text) TO known_credits_app', schema_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.credit_reconcile_expired(text,timestamptz) TO known_credits_app', schema_name);
    END IF;
    IF to_regrole('known_credits_operator') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL ON ${financeTables} FROM known_credits_operator';
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO known_credits_operator', schema_name);
      EXECUTE format('GRANT SELECT (id,status,deleted_at) ON %I.accounts TO known_credits_operator', schema_name);
    END IF;
  END
  $block$`).execute(db);
}

async function assertCreditTablesEmpty(db: Kysely<unknown>, schema: string): Promise<void> {
  const result = await sql.raw(`SELECT EXISTS (
    SELECT 1 FROM ${qualified(schema, 'credit_accounts')} LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM ${qualified(schema, 'credit_grants')} LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM ${qualified(schema, 'credit_charges')} LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM ${qualified(schema, 'credit_allocations')} LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM ${qualified(schema, 'credit_ledger_entries')} LIMIT 1
  ) AS has_data`).execute(db);
  if (Boolean((result.rows[0] as { has_data?: boolean } | undefined)?.has_data)) {
    throw new Error('classification credits migration down requires an empty ledger');
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const schema = await currentSchema(db);
  await installCreditTables(db, schema);
  await installCreditFunctions(db, schema);
  await installCreditFunding(db, schema);
  await configureCreditPrivileges(db, schema);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const schema = await currentSchema(db);
  await assertCreditTablesEmpty(db, schema);
  await dropCreditFunding(db, schema);
  await dropCreditFunctions(db, schema);
  await dropCreditTables(db, schema);
}
