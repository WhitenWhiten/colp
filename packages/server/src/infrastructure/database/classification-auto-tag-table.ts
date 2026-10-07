import type { Generated } from 'kysely';
export interface ClassificationAutoTagJobTable {
  id:string;collection_id:string;node_id:string;source_operation_id:string;resource_revision:string;
  owner_subject_id:string;principal_id:string;settings_revision:string;profile_id:string|null;profile_revision:string|null;
  /** Resolved from deployment configuration when the job runs; null until then. */
  provider_id:string|null;model:string|null;model_version:string|null;policy_version:string;prompt_version:string;candidate_version:string;
  execution_command_id:string;recompute_command_id:string;apply_command_id:string;recomputations:Generated<number>;outbox_id:string|null;
  status:'pending'|'running'|'applied'|'skipped'|'obsolete'|'failed'|'outcome_unknown';failure_code:string|null;
  selected_tag_count:Generated<number>;selected_tag_digest:string|null;
  created_at:Generated<Date>;expires_at:Date;completed_at:Date|null;
}
export interface ClassificationAutoTagDatabaseSchema {collection_classification_tag_jobs:ClassificationAutoTagJobTable}
