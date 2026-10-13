import { sql, type Kysely } from 'kysely';

/**
 * Account erasure deletes an Owner's automation rows through `accounts ... ON DELETE CASCADE`, but these
 * links between automation tables had no delete action, so a child without its own owner cascade (for
 * example admission receipts under a run) blocked the erasure. Each child below is meaningless without its
 * parent and is never kept as independent history. The deferred "current revision" pointers, references to
 * collections and operations (never hard-deleted with an Owner), and event facts (kept and swept by the
 * retention worker only when unreferenced) keep their behaviour. The immutability guard gets the same erasure
 * exception for execution-policy revisions that rule and binding revisions already had.
 */
const CASCADE = [
  ['automation_runs', 'automation_runs_binding_set_id_binding_revision_fkey'],
  ['automation_runs', 'automation_runs_rule_revision_id_fkey'],
  ['automation_rule_revisions', 'automation_rule_revisions_binding_set_id_owner_id_fkey'],
  ['automation_binding_sets', 'automation_binding_sets_rule_id_owner_id_fkey'],
  ['automation_event_subscriptions', 'automation_event_subscriptions_owner_id_profile_id_fkey'],
  ['automation_event_subscriptions', 'automation_event_subscriptions_owner_id_target_id_fkey'],
  ['automation_targets', 'automation_targets_owner_id_profile_id_fkey'],
  ['automation_event_deliveries', 'automation_event_deliveries_subscription_id_fkey'],
  ['automation_event_deliveries', 'automation_event_deliveries_job_id_fkey'],
  ['automation_event_deliveries', 'automation_event_deliveries_run_id_fkey'],
  ['automation_event_deliveries', 'automation_event_deliveries_target_id_fkey'],
  ['automation_results', 'automation_results_job_id_generation_fkey'],
  ['automation_effect_receipts', 'automation_effect_receipts_job_id_fkey'],
  ['automation_jobs', 'automation_jobs_reused_result_id_fkey'],
  ['automation_jobs', 'automation_job_target'],
  ['automation_proposals', 'automation_proposals_result_id_fkey'],
  ['automation_admission_receipts', 'automation_admission_receipts_rule_revision_id_fkey'],
  ['automation_admission_receipts', 'automation_admission_receipts_run_id_fkey'],
  ['automation_aggregate_state', 'automation_aggregate_state_rule_revision_id_fkey'],
  ['automation_aggregation_spaces', 'automation_aggregation_spaces_revision_id_fkey'],
  ['automation_aggregation_spaces', 'automation_aggregation_spaces_space_id_fkey'],
  ['automation_batch_members', 'automation_batch_members_rule_revision_id_fkey'],
  ['automation_batch_members', 'automation_batch_members_run_id_fkey'],
  ['automation_manual_previews', 'automation_manual_previews_rule_id_fkey'],
  ['automation_manual_previews', 'automation_manual_previews_run_id_fkey'],
  ['automation_tag_rejections', 'automation_tag_rejections_rule_id_fkey'],
  ['automation_usage_counters', 'automation_usage_counters_rule_id_fkey'],
  ['automation_usage_reservations', 'automation_usage_reservations_rule_id_fkey'],
  ['automation_executors', 'automation_executors_owner_id_target_id_fkey'],
  ['automation_pairings', 'automation_pairings_owner_id_target_id_fkey'],
  ['automation_run_outputs', 'automation_run_outputs_target_id_fkey'],
] as const;

async function redefine(db: Kysely<unknown>, cascade: boolean): Promise<void> {
  for (const [table, name] of CASCADE) {
    const current = (await sql<{ definition: string }>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname=${name} AND conrelid=${table}::regclass`.execute(db)).rows[0];
    if (!current) throw new Error(`Missing foreign key ${table}.${name}`);
    const base = current.definition.replace(/ ON DELETE CASCADE/u, '');
    const definition = cascade ? base.replace(/(\) REFERENCES [^)]*\))/u, '$1 ON DELETE CASCADE') : base;
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT ${sql.id(name)}, ADD CONSTRAINT ${sql.id(name)} ${sql.raw(definition)}`.execute(db);
  }
}
/** The shared immutability guard; `allowPolicyErasure` adds execution-policy revisions to the erasure exception. */
async function guard(db: Kysely<unknown>, allowPolicyErasure: boolean): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION automation_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF TG_TABLE_NAME = 'automation_rule_revisions' THEN
          IF NOT EXISTS (SELECT 1 FROM automation_rules WHERE id = OLD.rule_id)
            OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = OLD.owner_id) THEN RETURN OLD; END IF;
        ELSIF TG_TABLE_NAME = 'automation_binding_revisions' THEN
          IF NOT EXISTS (SELECT 1 FROM automation_binding_sets b JOIN accounts a ON a.id = b.owner_id
            WHERE b.id = OLD.binding_set_id) THEN RETURN OLD; END IF;
        ${sql.raw(allowPolicyErasure ? `ELSIF TG_TABLE_NAME = 'automation_execution_policy_revisions' THEN
          IF NOT EXISTS (SELECT 1 FROM automation_execution_policies p JOIN accounts a ON a.id = p.owner_id
            WHERE p.id = OLD.policy_id) THEN RETURN OLD; END IF;` : '')}
        END IF;
      END IF;
      RAISE EXCEPTION 'automation revisions are immutable';
    END $$`.execute(db);
}
export async function up(db: Kysely<unknown>): Promise<void> { await guard(db, true); await redefine(db, true); }
export async function down(db: Kysely<unknown>): Promise<void> { await redefine(db, false); await guard(db, false); }
