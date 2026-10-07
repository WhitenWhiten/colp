import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE collection_classification_runs
    ADD COLUMN billing_mode text NOT NULL DEFAULT 'legacy_free'
      CHECK (billing_mode IN ('managed','byok','legacy_free')),
    ADD COLUMN price_version text,
    ADD COLUMN quoted_points bigint NOT NULL DEFAULT 0
      CHECK (quoted_points BETWEEN 0 AND 2147483647),
    ADD CONSTRAINT classification_run_billing_shape_check CHECK (
      (billing_mode = 'managed' AND price_version IS NOT NULL AND quoted_points > 0)
      OR (billing_mode IN ('byok','legacy_free') AND price_version IS NULL AND quoted_points = 0)
    )`.execute(db);

  await sql`ALTER TABLE collection_classification_run_actions
    ADD COLUMN principal_id text,
    ADD COLUMN credit_charge_id uuid,
    ADD COLUMN billing_owner_kind text NOT NULL DEFAULT 'action'
      CHECK (billing_owner_kind = 'action')`.execute(db);
  await sql`UPDATE collection_classification_run_actions a
    SET principal_id = r.principal_id
    FROM collection_classification_runs r
    WHERE r.id = a.run_id AND a.principal_id IS NULL`.execute(db);
  await sql`ALTER TABLE collection_classification_run_actions
    ALTER COLUMN principal_id SET NOT NULL,
    ADD CONSTRAINT classification_run_action_principal_fk
      FOREIGN KEY (principal_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    ADD CONSTRAINT classification_run_action_credit_charge_fk
      FOREIGN KEY (principal_id, credit_charge_id)
      REFERENCES credit_charges(account_id, id)
      DEFERRABLE INITIALLY DEFERRED`.execute(db);
  await sql`CREATE INDEX classification_run_actions_credit_charge_idx
    ON collection_classification_run_actions(principal_id, credit_charge_id)
    WHERE credit_charge_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS classification_run_actions_credit_charge_idx`.execute(db);
  await sql`ALTER TABLE collection_classification_run_actions
    DROP CONSTRAINT IF EXISTS classification_run_action_credit_charge_fk,
    DROP CONSTRAINT IF EXISTS classification_run_action_principal_fk,
    DROP COLUMN IF EXISTS billing_owner_kind,
    DROP COLUMN IF EXISTS credit_charge_id,
    DROP COLUMN IF EXISTS principal_id`.execute(db);
  await sql`ALTER TABLE collection_classification_runs
    DROP CONSTRAINT IF EXISTS classification_run_billing_shape_check,
    DROP COLUMN IF EXISTS quoted_points,
    DROP COLUMN IF EXISTS price_version,
    DROP COLUMN IF EXISTS billing_mode`.execute(db);
}
