import { automationDigest, type HealthIncident, type HealthReport, type DependencyReport } from '@know-n/colp/automation';
import type { AutomationActor } from '../domain/bindings.js';
import { scopeCollectionId } from '../domain/bindings.js';
import { AutomationError } from '../domain/errors.js';
import { resolveBindings } from './resolve-bindings.js';
import { assessIntakeBindings } from './rule-eligibility.js';
import { requireRule } from './rule-service.js';
import { inspectWorkerConfiguration } from './worker-configuration.js';
import type { AutomationPorts } from './ports.js';

/** Revalidates and records incidents and dependency snapshots. Commands and the health monitor only. */
export async function revalidateRule(ports: AutomationPorts, actor: AutomationActor, ruleId: string): Promise<HealthReport> {
  return (await inspectRuleHealth(ports, actor, ruleId, true)).report;
}

/** The same report for reads: computed from current state, nothing written. */
export async function assessRuleHealth(ports: AutomationPorts, actor: AutomationActor, ruleId: string): Promise<HealthReport> {
  return (await inspectRuleHealth(ports, actor, ruleId, false)).report;
}

async function inspectRuleHealth(ports: AutomationPorts, actor: AutomationActor, ruleId: string, persist: boolean) {
  const stored = await requireRule(ports, actor, ruleId), rule = stored.view;
  const binding = await ports.bindings.load(actor.accountId, rule.bindingSetId);
  const previous = await ports.health.dependencies(stored.definitionRevisionId);
  const resolutions = binding ? await resolveBindings(ports.reads, actor, rule.definition, binding.values) : {};
  const now = (await ports.now()).toISOString(), expected: HealthIncident[] = [];
  const incident = (code: HealthIncident['code'], role: string | undefined, severity: HealthIncident['severity'], message: string, revision: string, blockingStages: string[]) => {
    expected.push({ id: ports.id(), ruleId, code, ...(role ? { role } : {}), severity, state: 'open', blockingStages,
      message, dependencyRevision: revision, firstSeenAt: now, lastSeenAt: now });
  };
  const assessment = assessIntakeBindings(rule.definition, resolutions);
  for (const { role, resolution, severity, blockingStages } of assessment.issues)
    incident(resolution.code, role, severity, resolution.message, binding?.revision ?? 'missing', blockingStages);
  for (const role of rule.definition.roles) {
    const resolution = resolutions[role.key];
    if (resolution?.status !== 'valid') continue;
    const old = previous.find((dependency) => dependency.role === role.key && dependency.kind === 'folder');
    if (old && typeof old.snapshot.title === 'string' && old.snapshot.title !== resolution.snapshot.title)
      incident('bindingRenamed', role.key, 'info', 'Folder label refreshed; canonical identity and binding revision are unchanged.', resolution.snapshot.revision, []);
    if (old && automationDigest(old.snapshot.ancestors ?? []) !== automationDigest(resolution.snapshot.ancestors))
      incident('bindingMoved', role.key, 'info', 'Folder ancestry changed; current subtree authority has been revalidated.', resolution.snapshot.revision, []);
  }
  const collectionId = binding ? scopeCollectionId(rule.definition, binding.values) : undefined;
  const collection = collectionId ? await ports.reads.readCollection(actor, collectionId) : null;
  if (!collection)
    incident('permissionRevoked', undefined, 'error', 'Current scope/write authority is unavailable; choose an authorized scope.', binding?.revision ?? 'missing', ['intake']);
  else if (ports.runtimeEnabled && !collection.currentOwner)
    incident('permissionRevoked', undefined, 'error', 'M1 execution requires the current collection Owner; an editor grant is not runtime authority.', collection.policyRevision, ['intake']);
  if (!ports.runtimeEnabled) incident('runtimeUnsupported', undefined, 'error', 'Configuration is saved. Durable M1 execution is not installed; no bookmark effects or model tasks can run.', 'be1', ['intake']);
  const worker = await inspectWorkerConfiguration(ports, actor, rule, binding?.values ?? {});
  for (const task of worker?.tasks ?? []) {
    if (task.available) continue;
    const spec = rule.definition.tasks.find(spec => spec.id === task.taskId)!;
    incident('executorUnavailable', spec.executorRole, 'warning', task.reason,
      automationDigest({ taskId: task.taskId, policy: worker?.policy, executor: task.executor, target: task.target, reason: task.reason }), [task.taskId]);
  }
  const incidents = persist ? await ports.health.synchronize(actor.accountId, ruleId, expected) : await ports.health.preview(actor.accountId, ruleId, expected);
  if (persist && binding) await ports.dependencies.replace(stored.definitionRevisionId, resolutions, binding.values);
  const paused = (await ports.settings.get(actor.accountId)).paused;
  const intakeBlocked = expected.some(item => item.blockingStages.includes('intake'));
  const workerBlocked = worker?.tasks.some(task => !task.available) === true;
  let effectiveState: HealthReport['effectiveState'];
  if (rule.desiredState !== 'enabled') effectiveState = rule.desiredState;
  else if (paused) effectiveState = 'paused';
  else if (intakeBlocked || (workerBlocked && !rule.definition.intake)) effectiveState = 'blocked';
  // Delivery failures remain open until acknowledged even when the current dependency check is clean.
  // They need attention, but do not block intake or invalidate already pinned work.
  else effectiveState = expected.some(item => item.severity !== 'info')
    || incidents.some(item => item.state === 'open' && item.severity !== 'info') ? 'degraded' : 'active';
  const report: HealthReport = { ruleId, checkedAt: now, effectiveState, incidents: incidents.slice(0, 100) };
  return { report, stored, resolutions };
}
export async function ruleDependencies(ports: AutomationPorts, actor: AutomationActor, ruleId: string): Promise<DependencyReport> {
  const { stored, resolutions } = await inspectRuleHealth(ports, actor, ruleId, false);
  const dependencies = await ports.health.dependencies(stored.definitionRevisionId);
  if (dependencies.length >= 1000) throw new AutomationError('payload_too_large', 'Dependency report exceeds its 1000-entry bound. Reduce role count or ancestry depth.');
  return { ruleId, dependencies: [...dependencies.map((dependency) => ({ kind: dependency.kind, role: dependency.role, resourceId: dependency.resourceId,
    revision: dependency.revision, status: resolutions[dependency.role]?.status === 'valid' ? 'valid' as const : 'blocked' as const })),
    { kind: 'runtime' as const, role: 'intake', resourceId: 'automation-m1', revision: ports.runtimeEnabled ? 'm1' : 'be1', status: ports.runtimeEnabled ? 'valid' as const : 'blocked' as const }] };
}
export async function acknowledgeIncident(ports: AutomationPorts, actor: AutomationActor, id: string) {
  const incident = await ports.health.acknowledge(actor.accountId, id);
  if (!incident) throw new AutomationError('resource_not_found', 'Incident is unavailable.'); return incident;
}
export interface StageDependency { role: string; kind: 'folder' | 'ancestor'; resourceId: string; revision: string; snapshot: Record<string, unknown> }
export interface HealthStore {
  dependencies(revisionId: string): Promise<StageDependency[]>;
  synchronize(ownerId: string, ruleId: string, expected: HealthIncident[]): Promise<HealthIncident[]>;
  /** What synchronize would report, without writing. */
  preview(ownerId: string, ruleId: string, expected: HealthIncident[]): Promise<HealthIncident[]>;
  acknowledge(ownerId: string, id: string): Promise<HealthIncident | null>;
  list(ownerId: string, after: { createdAt: string; id: string } | null, limit: number): Promise<HealthIncident[]>;
}
