import { arbitratePlacement, type CompiledPredicate, type EventFacts, type FolderRef, type PlacementCandidate, type RuleDefinition } from '@know-n/colp/automation';
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

type AssessedRule =
  | { kind: 'terminal'; plan: RuleEventPlan }
  | { kind: 'placement'; candidate: PlacementCandidate; satisfiedTasks: string[] };

function assessRule(rule: PreparedRule, event: EventFacts): AssessedRule {
  const terminal = (plan: RuleEventPlan): AssessedRule => ({ kind: 'terminal', plan });
  if (!eventEligible(rule.definition, rule.resolutions, event)) {
    return terminal({ kind: 'notMatched', reason: 'Outside rule scope, source policy, trigger or hop bound.' });
  }
  const predicate = rule.predicate.evaluate(event);
  if (predicate.outcome === 'error') return terminal({ kind: 'blocked', reason: predicate.code });
  if (predicate.outcome !== 'matched') return terminal({ kind: predicate.outcome, reason: predicate.outcome });
  if (!rule.bindings.available) {
    return terminal({ kind: 'blocked', reason: 'Required binding unavailable; keep original parent.' });
  }
  const intake = rule.definition.intake;
  if (!intake) return terminal({ kind: 'matched' });
  const destination = rule.resolutions[intake.folderRole];
  if (destination?.status !== 'valid') return terminal({ kind: 'blocked', reason: 'Intake destination unavailable.' });
  return {
    kind: 'placement',
    candidate: { ruleId: rule.ruleId, priority: rule.definition.priority, folder: destination.snapshot.folder,
      authorized: true, privacyAllowed: true },
    satisfiedTasks: [...intake.satisfies],
  };
}

/**
 * One immutable event, one predicate invocation per eligible rule, one arbitration.
 * Return plans in input order. Compatible rules can share an effect, but a blocked
 * rule never borrows a sibling's authority or loses its own diagnostic.
 */
export function evaluateRuleEvents(rules: readonly PreparedRule[], event: EventFacts): RuleEventPlan[] {
  const assessments = rules.map(rule => assessRule(rule, event));
  const candidates = assessments.flatMap(assessment => assessment.kind === 'placement' ? [assessment.candidate] : []);
  const placement = arbitratePlacement(candidates, event.intakeDisposition ?? 'unknown');
  return assessments.map(assessment => {
    if (assessment.kind === 'terminal') return assessment.plan;
    switch (placement.kind) {
      case 'place':
        return sameFolder(placement.folder, assessment.candidate.folder)
          ? { kind: 'placed', folder: placement.folder, satisfiedTasks: assessment.satisfiedTasks }
          : { kind: 'overridden', folder: placement.folder, ruleIds: placement.ruleIds };
      case 'conflict': return { kind: 'conflict', ruleIds: placement.ruleIds };
      case 'blocked': return { kind: 'blocked', reason: placement.reason };
      case 'keepParent':
      case 'review': return { kind: 'preserved', reason: placement.reason };
    }
  });
}

/** Preview/receipt compatibility entry point; uses the same batch evaluation. */
export function evaluateRuleEvent(rule: PreparedRule, competitors: readonly PreparedRule[], event: EventFacts): RuleEventPlan {
  return evaluateRuleEvents([rule, ...competitors], event)[0]!;
}

export const blocksActivation = (plan: RuleEventPlan): boolean => plan.kind === 'blocked' || plan.kind === 'conflict';
export const plansRun = (plan: RuleEventPlan): boolean => plan.kind === 'matched' || plan.kind === 'placed';
