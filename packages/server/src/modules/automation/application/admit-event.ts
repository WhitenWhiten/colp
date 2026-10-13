import type { EventFacts } from '@know-n/colp/automation';
import { evaluateRuleEvents, plansRun, type PreparedRule, type RuleEventPlan } from './rule-evaluation.js';

export interface AdmissionCandidate extends PreparedRule { revisionId: string; afterOrdinal: string; epoch: string }
export interface AdmissionDecision { candidate: AdmissionCandidate; plan: RuleEventPlan; createRun: boolean }
/** Pure admission decision for each and countBatch rules. The caller owns the source lock and atomic receipt, run and batch writes. */
export function admitEvent(candidates: readonly AdmissionCandidate[], event: EventFacts,workerEnabled = false): AdmissionDecision[] {
  const eligible = candidates.filter(rule => BigInt(event.commitOrdinal) > BigInt(rule.afterOrdinal)
    && (rule.definition.on !== 'intake.completed' || event.type === 'intake.completed')
    && (rule.definition.trigger.mode === 'each' || (workerEnabled && rule.definition.trigger.mode === 'countBatch')) && (workerEnabled || rule.definition.tasks.length === 0));
  const plans = evaluateRuleEvents(eligible, event);
  return eligible.map((candidate, index) => {
    const plan = plans[index]!;
    return { candidate, plan, createRun: plansRun(plan, workerEnabled && candidate.definition.tasks.length > 0)
      || ['missingInput','blocked','conflict','overridden'].includes(plan.kind) };
  });
}
