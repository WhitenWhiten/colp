export type AutomationErrorCode = 'resource_not_found' | 'insufficient_permission' | 'precondition_failed' | 'invalid_request'
  | 'automation_binding_unavailable' | 'automation_rule_conflict' | 'automation_unsupported_capability'
  | 'automation_invalid_graph' | 'automation_stale_input' | 'automation_command_conflict';
export class AutomationError extends Error {
  constructor(readonly code: AutomationErrorCode, message: string, readonly fieldErrors: readonly { path: string; code: string; message: string }[] = [], readonly currentEtag: string | null = null) { super(message); }
}
