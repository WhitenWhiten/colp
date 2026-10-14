export type AutomationErrorCode = 'invalid_cursor' | 'payload_too_large' | 'resource_not_found' | 'insufficient_permission' | 'precondition_failed' | 'invalid_request'
  | 'automation_binding_unavailable' | 'automation_rule_conflict' | 'automation_unsupported_capability'
  | 'automation_invalid_graph' | 'automation_stale_input' | 'automation_command_conflict'
  | 'rate_limited' | 'feature_temporarily_unavailable' | 'automation_budget_exceeded' | 'automation_claim_conflict' | 'automation_lease_lost' | 'automation_paused';
export class AutomationError extends Error {
  constructor(readonly code: AutomationErrorCode, message: string, readonly fieldErrors: readonly { path: string; code: string; message: string }[] = [], readonly currentEtag: string | null = null,readonly retryAfterSeconds: number | null = null) { super(message); }
}
