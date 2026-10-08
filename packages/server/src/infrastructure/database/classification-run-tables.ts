import type { Generated } from 'kysely';
export interface ClassificationRunTable {
  id:string;collection_id:string;principal_id:string;owner_subject_id:string;command_id:string;command_scope:string;
  revision:Generated<bigint>;status:'queued'|'running'|'open'|'applied'|'failed'|'cancelled'|'expired';failure_code:'stale_snapshot'|'configuration_changed'|'all_actions_failed'|null;
  taxonomy_revision:string;settings_revision:string;profile_revision:string|null;
  provider_id:string;model:string;policy_version:string;prompt_version:string;candidate_version:string;
  snapshot_json:unknown;created_at:Generated<Date>;deadline_at:Date;expires_at:Date;
  billing_mode:Generated<'managed'|'byok'|'legacy_free'>;price_version:Generated<string|null>;quoted_points:Generated<bigint>;
}
export interface ClassificationRunActionTable {
  run_id:string;action_id:string;ordinal:number;node_id:string;node_etag:string;source_parent_id:string;execution_command_id:string;
  principal_id:string;credit_charge_id:string|null;billing_owner_kind:'action';
  status:'pending'|'running'|'succeeded'|'failed';decision_json:Record<string,unknown>|null;failure_code:'provider_timeout'|'provider_unavailable'|'contract_drift'|'outcome_unknown'|'budget_exhausted'|'context_limit'|'deadline_exceeded'|'cancelled'|null;
}
export interface ClassificationRunJobTable {
  run_id:string;state:'pending'|'running'|'complete';generation:Generated<bigint>;lease_until:Date|null;
  available_at:Generated<Date>;attempts:Generated<number>;
}
export interface ClassificationRunDatabaseSchema {
  collection_classification_runs:ClassificationRunTable;
  collection_classification_run_actions:ClassificationRunActionTable;
  collection_classification_run_jobs:ClassificationRunJobTable;
}
