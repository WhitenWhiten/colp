import { arbitratePlacement, type CompiledPredicate, type EventFacts, type FolderRef, type RuleDefinition } from '@know-n/colp/automation';
import { sameFolder, type FolderResolution } from '../domain/bindings.js';
import { eventEligible, type BindingAssessment } from './rule-eligibility.js';

export interface PreparedRule {
  ruleId: string;
  definition: RuleDefinition;
  resolutions: Record<string, FolderResolution>;
  bindings: BindingAssessment;
  predicate: Extract<CompiledPredicate, { valid: true }>;
}

/** Evaluation retains business meaning; wire outcome labels never authorize activation. */
export type RuleEventPlan =
  | { kind: 'notMatched' | 'missingInput' | 'blocked' | 'preserved'; reason: string }
  | { kind: 'matched' }
  | { kind: 'placed'; folder: FolderRef; satisfiedTasks: string[] }
  | { kind: 'overridden'; folder: FolderRef; ruleIds: string[] }
  | { kind: 'conflict'; ruleIds: string[] };

export function evaluateRuleEvent(rule: PreparedRule, competitors: readonly PreparedRule[], event: EventFacts): RuleEventPlan {
  if (!eventEligible(rule.definition, rule.resolutions, event))
    return { kind: 'notMatched', reason: 'Outside rule scope, source policy, trigger or hop bound.' };
  const predicate = rule.predicate.evaluate(event);
  if (predicate.outcome === 'error') return { kind: 'blocked', reason: predicate.code };
  if (predicate.outcome !== 'matched') return { kind: predicate.outcome, reason: predicate.outcome };
  if (!rule.bindings.available) return { kind: 'blocked', reason: 'Required binding unavailable; keep original parent.' };
  const intake = rule.definition.intake;
  if (!intake) return { kind: 'matched' };
  const target = rule.resolutions[intake.folderRole];
  if (target?.status !== 'valid') return { kind: 'blocked', reason: 'Intake destination unavailable.' };
  const candidates = [{ ruleId: rule.ruleId, priority: rule.definition.priority, folder: target.snapshot.folder, authorized: true, privacyAllowed: true }];
  for (const other of competitors) {
    const destination = other.resolutions[other.definition.intake?.folderRole ?? ''];
    if (destination?.status !== 'valid' || !other.bindings.available
      || !eventEligible(other.definition, other.resolutions, event) || other.predicate.evaluate(event).outcome !== 'matched') continue;
    candidates.push({ ruleId: other.ruleId, priority: other.definition.priority, folder: destination.snapshot.folder, authorized: true, privacyAllowed: true });
  }
  const placement = arbitratePlacement(candidates, event.intakeDisposition ?? 'unknown');
  switch (placement.kind) {
    case 'place': return sameFolder(placement.folder, target.snapshot.folder)
      ? { kind: 'placed', folder: placement.folder, satisfiedTasks: [...intake.satisfies] }
      : { kind: 'overridden', folder: placement.folder, ruleIds: placement.ruleIds };
    case 'conflict': return { kind: 'conflict', ruleIds: placement.ruleIds };
    case 'blocked': return { kind: 'blocked', reason: placement.reason };
    case 'keepParent':
    case 'review': return { kind: 'preserved', reason: placement.reason };
  }
}

export const blocksActivation = (plan: RuleEventPlan): boolean => plan.kind === 'blocked' || plan.kind === 'conflict';
export const plansRun = (plan: RuleEventPlan): boolean => plan.kind === 'matched' || plan.kind === 'placed';
