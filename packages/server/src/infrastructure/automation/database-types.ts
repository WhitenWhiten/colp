import type { Generated } from 'kysely';
import type { RuleDefinition, RoleBindings, PreviewResult, HealthIncident } from '@know-n/colp/automation';
export interface AutomationDatabaseSchema {
  automation_settings: { owner_id: string; paused: boolean; paused_at: Date | null; paused_by: 'owner' | 'restore' | 'capacity' | null; revision: Generated<string> };
  automation_rules: { id: string; owner_id: string; current_revision_id: string | null; state_revision: Generated<string>; desired_state: 'draft' | 'enabled' | 'paused' | 'archived'; created_at: Generated<Date>; updated_at: Generated<Date> };
  automation_rule_revisions: { id: string; owner_id: string; rule_id: string; revision: string; definition_json: RuleDefinition; binding_set_id: string; execution_policy_id: string | null; template_ref: string | null; semantic_digest: string; created_at: Generated<Date> };
  automation_binding_sets: { id: string; owner_id: string; rule_id: string | null; current_revision: string; name: string; created_at: Generated<Date>; updated_at: Generated<Date> };
  automation_binding_revisions: { binding_set_id: string; revision: string; values_json: RoleBindings; semantic_digest: string; created_at: Generated<Date> };
  automation_dependencies: { rule_revision_id: string; role: string; resource_kind: string; resource_id: string; dependency_revision: string; stage: string; snapshot_json: Record<string, unknown> };
  automation_incidents: { id: string; owner_id: string; rule_id: string; dependency_key: string; code: HealthIncident['code']; revision: string; severity: HealthIncident['severity']; state: HealthIncident['state']; incident_json: HealthIncident; first_seen: Generated<Date>; last_seen: Generated<Date> };
  automation_preview_records: { id: string; owner_id: string; config_digest: string; snapshot_json: Record<string, unknown>; result_json: PreviewResult; expires_at: Date; created_at: Generated<Date> };
  automation_activations: { rule_revision_id: string; collection_id: string; generation: string; after_ordinal: string; disabled_after_ordinal: string | null; aggregate_epoch: string };
}
