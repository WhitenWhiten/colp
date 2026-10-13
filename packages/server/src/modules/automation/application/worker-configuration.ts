import { compilePredicate,validateM1Rule,validateTaskGraph,type RuleInput,type ContractIssue } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import type { AutomationActor } from '../domain/bindings.js';
import type { AutomationPorts } from './ports.js';
import { taskExecutionAssignment } from './executor-policy.js';

export function supportedRuleIssues(input: RuleInput,workerEnabled = false): ContractIssue[] {
  if (!workerEnabled || !input.definition.tasks.length) {
    const issues = validateM1Rule(input.definition);
    if (input.executionPolicyId) issues.push({ path: '/executionPolicyId',code: 'unsupportedCapability',message: 'A deterministic rule does not use an execution policy.' });
    return issues;
  }
  const d = input.definition,issues = validateTaskGraph(d),compiled = compilePredicate(d.match);
  if (!compiled.valid) issues.push(...compiled.issues);
  if (!['each','countBatch'].includes(d.trigger.mode) || !['bookmark.intake','node.created','intake.completed'].includes(d.on) || d.route.mode !== 'targets'
    || d.route.execution !== 'single' || (d.route.targetIds?.length ?? 0)>1 || d.policy.broadcastAllowed
    || d.roles.some(r => !['folder','executor'].includes(r.kind)) || d.tasks.some(t => t.allowCreateFolder))
    issues.push({ path: '/definition',code: 'unsupportedCapability',message: 'This host installs each/countBatch single-target tasks; scheduled batches, broadcast, taxonomy creation and mapping roles are unavailable.' });
  if(d.trigger.mode==='countBatch' && (d.intake || d.tasks.some(t=>!['digest.generate','review.generate'].includes(t.type))))
    issues.push({path:'/definition/trigger',code:'unsupportedCapability',message:'Count batches support run-level digest/review tasks without per-bookmark placement.'});
  return issues;
}
export function assertSupportedRule(input: RuleInput,workerEnabled = false): void {
  const issues = supportedRuleIssues(input,workerEnabled);
  if (issues.length) throw new AutomationError(issues.some(i => i.code === 'unsupportedCapability') ? 'automation_unsupported_capability' : 'automation_invalid_graph','Rule exceeds the installed execution profile.',issues);
}

/** Missing execution permission holds optional tasks, never the deterministic intake stage. */
export async function inspectWorkerConfiguration(ports: AutomationPorts,actor: AutomationActor,input: RuleInput,values: import('@know-n/colp/automation').RoleBindings) {
  if (!input.definition.tasks.length) return null;
  const policy = input.executionPolicyId ? await ports.policies.load(input.executionPolicyId) : null;
  const tasks = [];
  for (const task of input.definition.tasks) {
    const assignment = taskExecutionAssignment(policy,task),binding = values[task.executorRole];
    const executor = binding?.kind === 'executor' && binding.executorId ? await ports.targets.executors.load(binding.executorId) : null;
    const target = executor?.configuration.targetId ? await ports.targets.targets.load(executor.configuration.targetId) : null;
    const config = assignment.available ? assignment.assignment : null;
    const allowed = !!config && !!executor && executor.configuration.kind === 'mcpEventsBot' && !!target
      && (!input.definition.route.targetIds?.length || input.definition.route.targetIds.includes(target.id))
      && (config.destinationScope !== 'explicit' || config.allowedDestinations.includes(executor.id));
    tasks.push({ taskId: task.id,available: !!ports.workerEnabled && allowed && target?.wakeReadiness === 'active',
      reason: !ports.workerEnabled ? 'Worker execution is not installed on this host.' : !assignment.available ? assignment.reason : !allowed ? 'An explicit authorized executor/target destination is required.'
        : target?.wakeReadiness !== 'active' ? 'The assigned worker target is not ready: it is unpaired, revoked or still waiting for its Events subscription.' : 'Explicit worker assignment is available.',
      executor: executor ? { id: executor.id,configuration: executor.configuration } : null,
      target: target ? { id: target.id,configuration: target.configuration,revision: target.revision,wakeReadiness: target.wakeReadiness } : null });
  }
  return { policy: policy ? { id: policy.id,revision: policy.revision,configuration: policy.configuration } : null,tasks };
}
