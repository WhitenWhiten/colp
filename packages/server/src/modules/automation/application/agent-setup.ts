import type { AgentSetupResult, Executor, ConnectionProfile, RoleBindings } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import type { AutomationActor } from '../domain/bindings.js';
import type { AutomationPorts } from './ports.js';
import { createRule, parseContract, replaceRule, requireEtag, requireRule, saveBinding } from './rule-service.js';
import { saveConnectionProfile, saveTarget, type ConfigurationStore } from './target-service.js';
import { saveExecutionPolicy } from './executor-policy.js';

/** The enclosing command transaction owns all setup writes, including the draft. */
export async function prepareAutomationAgent(ports: AutomationPorts, actor: AutomationActor, body: unknown): Promise<AgentSetupResult> {
  const input = parseContract('AgentSetupInput', body);
  if (!ports.workerEnabled) throw new AutomationError('automation_unsupported_capability', 'Agent tasks are unavailable on this server.');
  if (!input.definition.tasks.length) throw new AutomationError('invalid_request', 'Choose at least one agent task.');
  if (input.ruleId) requireEtag((await requireRule(ports, actor, input.ruleId)).view.revision, `"${input.ruleRevision}"`);
  if (input.definition.policy.privacy !== 'standard' || input.definition.route.execution !== 'single')
    throw new AutomationError('automation_unsupported_capability', 'Guided setup supports standard rules with one agent. Use advanced configuration for restricted rules.');

  let target = input.targetId ? await ports.targets.targets.load(input.targetId) : null;
  if (input.targetId && (!target || target.status === 'revoked')) throw new AutomationError('resource_not_found', 'This agent connection is unavailable.');
  if (!target) {
    const agent = input.agent!;
    const profiles = await configurations(ports.targets.profiles);
    const profile = profiles.find(p => p.configuration.authorizedClientId === agent.clientId && p.configuration.automationEnabled
      && p.configuration.catalogs.includes('automationWorker')) ?? await saveConnectionProfile(ports.targets, {
      name: agent.name, authorizedClientId: agent.clientId, credentialBindingId: `pending-${ports.id()}`,
      automationEnabled: true, catalogs: ['standard', 'automationWorker'],
    });
    // Reconnect/reload should find the same pending or paired target instead of leaving another one behind.
    const targets = await configurations(ports.targets.targets);
    target = targets.find(t => t.configuration.connectionProfileId === profile.id && t.status !== 'revoked'
      && t.configuration.privacy === 'standard') ?? await saveTarget(ports.targets, {
      name: agent.name, providerLabel: '', broadcastOptIn: false, privacy: 'standard', connectionProfileId: profile.id,
      wakeMode: input.wakeMode ?? (ports.eventsEnabled ? 'events' : 'poll'), pollIntervalMinutes: 1,
    });
  }
  const profile: ConnectionProfile | null = await ports.targets.profiles.load(target.configuration.connectionProfileId);
  if (!profile?.configuration.automationEnabled || !profile.configuration.catalogs.includes('automationWorker') || target.configuration.privacy !== 'standard')
    throw new AutomationError('automation_binding_unavailable', 'This agent is not authorized for standard rule tasks.');
  const executor: Executor | undefined = (await configurations(ports.targets.executors)).find(e => e.configuration.targetId === target!.id);
  if (!executor) throw new AutomationError('automation_binding_unavailable', 'The agent executor is unavailable.');

  const values: RoleBindings = { ...input.bindings.values };
  for (const role of input.definition.roles) if (role.kind === 'executor') values[role.key] = { kind: 'executor', executorId: executor.id };
  const binding = await saveBinding(ports, actor, { ...input.bindings, values });
  const tasks = [...new Map(input.definition.tasks.map(task => [task.type, task])).values()];
  if (tasks.some(task => input.definition.tasks.some(other => other.type === task.type && other.executorRole !== task.executorRole)))
    throw new AutomationError('invalid_request', 'Tasks of the same type must use one executor role.');
  const policy = await saveExecutionPolicy(ports.policies, {
    name: input.definition.name, maxDailyCostMicros: 0, externalCosts: 'unknownDisclosed', allowAutomaticWrites: false,
    assignments: tasks.map(task => ({ taskType: task.type, primaryRole: task.executorRole, fallbackRoles: [], fallbackOn: [],
      allowedData: [...new Set(input.definition.tasks.filter(t => t.type === task.type).flatMap(t => t.inputFields))],
      allowedDestinations: [executor.id], destinationScope: 'explicit', maxCalls: 1, maxCostMicros: 0, currency: 'USD',
      onUnknownOutcome: 'holdForReconciliation', onInsufficientResult: 'review' })),
  });
  const ruleInput = { definition: { ...input.definition, route: { mode: 'targets', execution: 'single', targetIds: [target.id] } },
    bindingSetId: binding.id, executionPolicyId: policy.id };
  const rule = input.ruleId ? await replaceRule(ports, actor, input.ruleId, { ...ruleInput, pendingRuns: 'hold', counterPolicy: 'resetOnSemanticChange' }, `"${input.ruleRevision}"`)
    : await createRule(ports, actor, ruleInput);
  const pairing = target.wakeReadiness === 'waitingForPairing' ? await ports.targets.issuePairing(target.id) : null;
  // Issuing the grant advances the target ETag. Return its current revision for a safe retry.
  target = (await ports.targets.targets.load(target.id))!;
  return { rule, binding, target, pairing };
}

async function configurations<View extends { id: string }, Input>(store: ConfigurationStore<View, Input>): Promise<View[]> {
  const result: View[] = [];
  let after: { id: string; createdAt: string } | null = null;
  for (;;) {
    const rows = await store.list(after, 100);
    result.push(...rows.map(row => row.view));
    const last = rows.at(-1);
    if (rows.length < 100 || !last) return result;
    after = { id: last.view.id, createdAt: last.createdAt };
  }
}
