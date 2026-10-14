import type { Diagnostic, RuleDefinition } from '@know-n/colp/automation';
import type { RuleEventPlan } from './rule-evaluation.js';

/** One explanation for editor validation and preview; neither endpoint spends capacity. */
export function intakePolicyDiagnostics(policy: RuleDefinition['policy'], location = '/definition/policy'): Diagnostic[] {
  const diagnostics: Diagnostic[] = [{ code: 'dailyAdmissionLimit', severity: 'info', location: `${location}/maxRunsPerDay`,
    message: `At most ${policy.maxRunsPerDay} runnable server admissions per logical rule and UTC day. Overflow keeps its original pins and waits for a durable wake. Already-committed device effects remain visible and count toward later server admissions; this is not a retroactive offline-device limit.` }];
  if (policy.missingInput === 'defer') diagnostics.push({ code: 'immutableInputDeferred', severity: 'warning', location: `${location}/missingInput`,
    message: 'Missing immutable input is retained as an inspectable, cancellable waiting run. Continuing pinned work cannot invent input or substitute a later bookmark revision. M1 does not fetch missing data or automatically rebind deferred work.' });
  return diagnostics;
}

/** Preserve the distinction between a match, consent to place, and an actual effect. */
export function previewPlanDiagnostics(plans: readonly RuleEventPlan[]): Diagnostic {
  const counts: Record<RuleEventPlan['kind'], number> = {
    matched: 0, placed: 0, preserved: 0, overridden: 0, blocked: 0, conflict: 0, notMatched: 0, missingInput: 0,
  };
  for (const plan of plans) counts[plan.kind]++;
  return { code: 'previewDecisionCounts', severity: 'info', location: '/decisions',
    message: `Placement plans: ${counts.placed}; match-only: ${counts.matched}; preserved explicit/unknown intent: ${counts.preserved}; overridden: ${counts.overridden}; blocked: ${counts.blocked}; conflicts: ${counts.conflict}; missing input: ${counts.missingInput}; not matched: ${counts.notMatched}. These are hypothetical decisions, not committed effects or quota reservations.` };
}
