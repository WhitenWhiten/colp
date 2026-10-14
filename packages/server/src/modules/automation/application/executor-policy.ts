import type { ExecutionPolicy, ExecutionPolicyInput, TaskSpec } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import { parseContract, requireEtag } from './rule-service.js';
import type { PageAfter } from './ports.js';

export interface ExecutionPolicyStore {
  load(id: string, revision?: string): Promise<ExecutionPolicy | null>;
  list(after: PageAfter | null, limit: number): Promise<{ view: ExecutionPolicy; createdAt: string }[]>;
  save(configuration: ExecutionPolicyInput, id?: string): Promise<ExecutionPolicy>;
}
export async function saveExecutionPolicy(store: ExecutionPolicyStore, body: unknown, id?: string, ifMatch?: string) {
  const input = parseContract('ExecutionPolicyInput', body);
  if (hasUnsupportedCostLimit(input)) throw new AutomationError('automation_unsupported_capability',
    'Monetary limits are unavailable: use zero for observation-only cost fields. Call and daily-run caps remain enforced.');
  if (new Set(input.assignments.map(a => a.taskType)).size !== input.assignments.length)
    throw new AutomationError('invalid_request', 'A task type must have exactly one primary assignment.');
  // Fallback across executors is not implemented; reject it instead of silently ignoring it.
  if (input.assignments.some(a => a.fallbackRoles.length || a.fallbackOn.length))
    throw new AutomationError('automation_unsupported_capability', 'Automatic fallback is unavailable; assign one explicit executor.');
  if (id) {
    const previous = await store.load(id);
    if (!previous) throw new AutomationError('resource_not_found', 'Execution policy is unavailable.');
    requireEtag(previous.revision, ifMatch ?? '');
  }
  return store.save(input, id);
}
/** Absence, data denial and exhaustion always hold optional work, never M1 placement. */
export function taskExecutionAssignment(policy: ExecutionPolicy | null, task: TaskSpec) {
  if (policy && hasUnsupportedCostLimit(policy.configuration))
    return { available: false as const, reason: 'Pinned monetary limits cannot be enforced by this host.' };
  const assignment = policy?.configuration.assignments.find(a => a.taskType === task.type);
  if (!assignment || assignment.primaryRole !== task.executorRole || assignment.maxCalls === 0)
    return { available: false as const, reason: 'No explicit execution assignment permits this task.' };
  if (task.inputFields.some(field => !assignment.allowedData.includes(field)))
    return { available: false as const, reason: 'Task input fields exceed the execution policy allowlist.' };
  return { available: true as const, assignment };
}

export function hasUnsupportedCostLimit(policy: ExecutionPolicyInput): boolean {
  return policy.maxDailyCostMicros !== 0 || policy.assignments.some(assignment => assignment.maxCostMicros !== 0);
}
