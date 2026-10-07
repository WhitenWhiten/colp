import type {Generated} from 'kysely';
export interface ClassificationProviderProfileTable {
  id:string;owner_subject_id:string;label:string;kind:'cloudflare_ai_gateway';protocol:'cloudflare_ai_run_v1';model:'typesafe/jev';config_json:unknown;
  secret_envelope:unknown;secret_fingerprint:string|null;revision:Generated<bigint>;status:'active'|'disabled'|'test_failed';
  last_tested_at:Date|null;created_at:Generated<Date>;updated_at:Generated<Date>;
}
export interface ClassificationProfileTestTable {
  id:string;principal_id:string;owner_subject_id:string;profile_id:string;profile_revision:string;command_id:string;fingerprint:string;request_id:string;
  state:'pending'|'dispatching'|'succeeded'|'failed'|'outcome_unknown';deadline_at:Date;dispatched_at:Date|null;completed_at:Date|null;
  reserved_microusd:Generated<bigint>;settled_microusd:bigint|null;
}

export interface ClassificationProfileDatabaseSchema {classification_provider_profiles:ClassificationProviderProfileTable;classification_profile_tests:ClassificationProfileTestTable}
