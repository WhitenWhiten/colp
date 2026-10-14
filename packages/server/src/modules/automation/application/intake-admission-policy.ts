import type { RuleDefinition } from '@know-n/colp/automation';
import type { RuleEventPlan } from './rule-evaluation.js';

export interface IntakeAdmissionState {
  state: 'waiting' | 'completed' | 'review';
  runnable: boolean;
  explanation?: string;
}

/** Missing inputs are durable decisions, not negative matches or permission to move. */
export function intakeAdmissionState(plan: RuleEventPlan, policy: RuleDefinition['policy'], hasWorkerTasks = false): IntakeAdmissionState {
  if (plan.kind === 'placed') return { state: 'waiting', runnable: true };
  if (plan.kind === 'matched') return { state: 'completed', runnable: true };
  if (plan.kind === 'preserved' && hasWorkerTasks) return { state: 'completed', runnable: true };
  if (plan.kind === 'missingInput') {
    return policy.missingInput === 'defer'
      ? { state: 'waiting', runnable: false,
        explanation: 'Deferred: the immutable source lacks usable input. The original rule, binding and event remain pinned; a newer live bookmark is never substituted. No effect is authorized. The Owner may cancel this deferred run.' }
      : { state: 'review', runnable: false,
        explanation: 'Review required: the immutable source lacks usable input. No effect was authorized; a later bookmark edit does not replace this source.' };
  }
  return { state: 'review', runnable: false };
}
