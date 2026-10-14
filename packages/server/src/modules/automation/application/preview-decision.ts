import type { PreviewDecision, TaskSpec } from '@know-n/colp/automation';
import type { RuleEventPlan } from './rule-evaluation.js';
import { plansRun } from './rule-evaluation.js';

/** Keep the reviewed wire contract, including its broad conflict group, out of lifecycle policy. */
export function previewDecision(eventId: string, plan: RuleEventPlan, tasks: readonly TaskSpec[] = []): PreviewDecision {
  const satisfied = plan.kind === 'placed' ? plan.satisfiedTasks : [];
  const pendingTasks = plansRun(plan, tasks.length > 0)
    ? tasks.filter(task => !satisfied.includes(task.type)
      && !(plan.kind === 'preserved' && task.type.startsWith('classify.'))).map(task => task.type) : [];
  const base = { eventId, satisfiedTasks: [], pendingTasks };
  switch (plan.kind) {
    case 'notMatched':
    case 'missingInput':
    case 'blocked': return { ...base, outcome: plan.kind, explanation: plan.reason };
    case 'matched': return { ...base, outcome: 'matched', explanation: 'matched' };
    case 'preserved': return { ...base, outcome: 'matched', explanation: `${plan.reason}; original location preserved.` };
    case 'placed': return { ...base, outcome: 'matched', satisfiedTasks: plan.satisfiedTasks,
      explanation: `Would place in canonical folder ${plan.folder.nodeId}; preview only; no effect.` };
    case 'overridden': return { ...base, outcome: 'conflict', explanation:
      `Higher-priority rules ${describeRules(plan.ruleIds)} select canonical folder ${plan.folder.nodeId}; proposed placement would not run; no effect.` };
    case 'conflict': return { ...base, outcome: 'conflict', explanation:
      `conflict: equalPriorityDestinations; rules ${describeRules(plan.ruleIds)}; original location preserved.` };
  }
}

function describeRules(ids: readonly string[]): string {
  return ids.slice(0, 10).join(', ') + (ids.length > 10 ? ` (+${ids.length - 10} more)` : '');
}
