import type { Run } from '@know-n/colp/automation';
import type { RuleEventPlan } from './rule-evaluation.js';

/** Expose a bounded business explanation, never the private canonical facts document. */
export function explainRun(status: Run['status'], held: boolean, evidence: {
  explanation?: string; plan?: RuleEventPlan; verifiedDevicePlacement?: boolean;
}): string {
  if (status === 'cancelled') return 'Cancelled by the Owner; recorded effects are retained.';
  if (held && ['waiting', 'running'].includes(status)) return 'Explicit hold: awaiting an Owner decision to continue the original pinned work.';
  if (evidence.explanation) return evidence.explanation.slice(0, 1000);
  if (evidence.verifiedDevicePlacement) return 'Canonical device placement verified against the pinned rule and binding.';
  const plan = evidence.plan;
  if (!plan) return 'No retained execution explanation is available.';
  switch (plan.kind) {
    case 'placed': return `Waiting to place in canonical folder ${plan.folder.nodeId} using the pinned rule and binding.`;
    case 'matched': return 'The pinned rule matched; no placement effect was required.';
    case 'overridden': return `A higher-priority rule selected canonical folder ${plan.folder.nodeId}; this placement did not run.`;
    case 'conflict': return 'Equal-priority rules selected incompatible destinations; the original location was preserved.';
    case 'notMatched':
    case 'missingInput':
    case 'blocked':
    case 'preserved': return plan.reason.slice(0, 1000);
  }
}
