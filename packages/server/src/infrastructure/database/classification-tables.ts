import type {Generated} from 'kysely';
export interface ClassificationSettingsTable {
  collection_id: string; owner_subject_id: string; auto_tag_mode: 'off' | 'suggest' | 'auto';
  max_auto_tags: number; execution_mode: 'server_managed'|'server_byok'; provider_profile_id: string|null;
  revision: bigint; updated_at: Date;
}

export interface ClassificationExecutionTable {
  id:string;principal_id:string;owner_subject_id:string;collection_id:string;command_scope:string;command_id:string;
  fingerprint:string;request_id:string;provider_id:string;model:string;policy_version:string;prompt_version:string;
  input_json:unknown;settings_revision:string;content_revision:string;state:'pending'|'running'|'succeeded'|'failed'|'outcome_unknown';
  failure_code:Generated<string|null>;generation:bigint;lease_until:Date|null;deadline_at:Date;created_at:Date;completed_at:Date|null;
  billing_mode:'managed'|'byok'|'legacy_free';credit_charge_id:string|null;billing_owner_kind:'execution'|'action';
}
export interface ClassificationCallAttemptTable {
  execution_id:string;stage:'l1'|'l2'|'tags';chunk_index:number;input_digest:string;
  state:'ready'|'dispatching'|'succeeded'|'failed'|'unknown';attempt_number:number;result_json:unknown;
  reported_model_version:string|null;
  reserved_microusd:bigint;settled_microusd:bigint|null;dispatched_at:Date|null;completed_at:Date|null;
}
export interface ClassificationSpendBudgetTable {day:Date;scope:string;spent_microusd:bigint}
