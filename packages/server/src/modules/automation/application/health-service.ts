import { automationDigest, type HealthIncident, type HealthReport, type DependencyReport } from '@know-n/colp/automation';
import type { AutomationActor, FolderResolution } from '../domain/bindings.js';
import { scopeCollectionId } from '../domain/bindings.js';
import { AutomationError } from '../domain/errors.js';
import { resolveBindings } from './resolve-bindings.js';
import { intakeDependencyRoles } from './rule-eligibility.js';
import { requireRule } from './rule-service.js';
import type { AutomationPorts } from './ports.js';

export async function revalidateRule(ports: AutomationPorts, actor: AutomationActor, ruleId: string): Promise<HealthReport> {
  const stored = await requireRule(ports, actor, ruleId), rule = stored.view;
  const binding = await ports.bindings.load(actor.accountId, rule.bindingSetId);
  const previous = await ports.health.dependencies(stored.definitionRevisionId);
  const resolutions = binding ? await resolveBindings(ports.reads, actor, rule.definition, binding.values) : {};
  const now = (await ports.now()).toISOString(), expected: HealthIncident[] = [];
  const incident = (code: HealthIncident['code'], role: string | undefined, severity: HealthIncident['severity'], message: string, revision: string, blockingStages: string[]) => {
    expected.push({ id: ports.id(), ruleId, code, ...(role ? { role } : {}), severity, state: 'open', blockingStages,
      message, dependencyRevision: revision, firstSeenAt: now, lastSeenAt: now });
  };
  const usedRoles = intakeDependencyRoles(rule.definition);
  for (const role of rule.definition.roles) {
    const blockingStages = usedRoles.has(role.key) ? ['intake'] : [];
    const resolution = resolutions[role.key];
    if (!resolution) {
      if (role.required) incident('bindingDeleted', role.key, 'error', 'Choose a live authorized folder for the missing role.', binding?.revision ?? 'missing', blockingStages);
      continue;
    }
    if (resolution.status === 'blocked') {
      incident(resolution.code, role.key, blockingStages.length || role.required ? 'error' : 'warning', resolution.message, binding?.revision ?? 'missing', blockingStages); continue;
    }
    const old = previous.find((dependency) => dependency.role === role.key && dependency.kind === 'folder');
    if (old && typeof old.snapshot.title === 'string' && old.snapshot.title !== resolution.snapshot.title)
      incident('bindingRenamed', role.key, 'info', 'Folder label refreshed; canonical identity and binding revision are unchanged.', resolution.snapshot.revision, []);
    if (old && automationDigest(old.snapshot.ancestors ?? []) !== automationDigest(resolution.snapshot.ancestors))
      incident('bindingMoved', role.key, 'info', 'Folder ancestry changed; current subtree authority has been revalidated.', resolution.snapshot.revision, []);
  }
  const collectionId = binding ? scopeCollectionId(rule.definition, binding.values) : undefined;
  if (!collectionId || !await ports.reads.readCollection(actor, collectionId))
    incident('permissionRevoked', undefined, 'error', 'Current scope/write authority is unavailable; choose an authorized scope.', binding?.revision ?? 'missing', ['intake']);
  // No fake runtime composition or jobs are installed by BE-1.
  incident('runtimeUnsupported', undefined, 'error', 'Configuration is saved. Durable M1 execution is not installed; no bookmark effects or model tasks can run.', 'be1', ['intake']);
  const incidents = await ports.health.synchronize(actor.accountId, ruleId, expected);
  if (binding) await ports.dependencies.replace(stored.definitionRevisionId, resolutions, binding.values);
  const paused = (await ports.settings.get(actor.accountId)).paused;
  const effectiveState = rule.desiredState === 'enabled' ? (paused ? 'paused' : 'blocked') : rule.desiredState;
  return { ruleId, checkedAt: now, effectiveState, incidents: incidents.slice(0, 100) };
}
export async function ruleDependencies(ports: AutomationPorts, actor: AutomationActor, ruleId: string): Promise<DependencyReport> {
  const health = await revalidateRule(ports, actor, ruleId), stored = await requireRule(ports, actor, ruleId);
  const dependencies = await ports.health.dependencies(stored.definitionRevisionId);
  if (dependencies.length >= 1000) throw new AutomationError('payload_too_large', 'Dependency report exceeds its 1000-entry bound. Reduce role count or ancestry depth.');
  return { ruleId, dependencies: [...dependencies.map((dependency) => ({ kind: dependency.kind, role: dependency.role, resourceId: dependency.resourceId,
    revision: dependency.revision, status: health.incidents.some((incident) => incident.role === dependency.role && incident.blockingStages.length)
      ? 'blocked' as const : 'valid' as const })), { kind: 'runtime' as const, role: 'intake', resourceId: 'automation-m1', revision: 'be1', status: 'blocked' as const }] };
}
export async function acknowledgeIncident(ports: AutomationPorts, actor: AutomationActor, id: string) {
  const incident = await ports.health.acknowledge(actor.accountId, id);
  if (!incident) throw new AutomationError('resource_not_found', 'Incident is unavailable.'); return incident;
}
export interface StageDependency { role: string; kind: 'folder' | 'ancestor'; resourceId: string; revision: string; snapshot: Record<string, unknown> }
export interface HealthStore {
  dependencies(revisionId: string): Promise<StageDependency[]>;
  synchronize(ownerId: string, ruleId: string, expected: HealthIncident[]): Promise<HealthIncident[]>;
  acknowledge(ownerId: string, id: string): Promise<HealthIncident | null>;
  list(ownerId: string, after: { createdAt: string; id: string } | null, limit: number): Promise<HealthIncident[]>;
}
