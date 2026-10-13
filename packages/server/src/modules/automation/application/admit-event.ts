import type { EventFacts } from '@know-n/colp/automation';
import { evaluateRuleEvent, type PreparedRule, type RuleEventPlan } from './rule-evaluation.js';

export interface AdmissionCandidate extends PreparedRule { revisionId: string; afterOrdinal: string; epoch: string }
export interface AdmissionDecision { candidate: AdmissionCandidate; plan: RuleEventPlan; createRun: boolean }
/** Pure M1 admission. The caller owns the source lock and atomic receipt/run writes. */
export function admitEvent(candidates: readonly AdmissionCandidate[], event: EventFacts,workerEnabled = false): AdmissionDecision[] {
  const eligible = candidates.filter(rule => BigInt(event.commitOrdinal) > BigInt(rule.afterOrdinal)
    && rule.definition.trigger.mode === 'each' && (workerEnabled || rule.definition.tasks.length === 0));
  return eligible.map(candidate => {
    const plan = evaluateRuleEvent(candidate, eligible.filter(other => other.ruleId !== candidate.ruleId), event);
    return { candidate, plan, createRun: ['placed', 'matched', 'conflict', 'blocked', 'overridden'].includes(plan.kind) || (workerEnabled && candidate.definition.tasks.length > 0 && plan.kind === 'preserved') };
  });
}

/** M3 primitive only. M1 admission never calls this or enables countBatch. */
export function appendCountBatch<T extends { eventId: string }>(remainder: readonly T[], incoming: readonly T[], size: number) {
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Error('Invalid batch size');
  const members = [...remainder], seen = new Set(members.map(member => member.eventId));
  for (const member of incoming) if (!seen.has(member.eventId)) { seen.add(member.eventId); members.push(member); }
  const batches: T[][] = [];
  while (members.length >= size) batches.push(members.splice(0, size));
  return { batches, remainder: members };
}
