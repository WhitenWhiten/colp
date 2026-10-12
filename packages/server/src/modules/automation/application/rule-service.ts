import { validateAutomation, validateM1Rule, ruleSemanticDigest, type RuleInput, type ChangeInput, type BindingSetInput,
  type ValidationResult, type Diagnostic, type AutomationSchemaName } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import { scopeCollectionId, type AutomationActor } from '../domain/bindings.js';
import { resolveBindings } from './resolve-bindings.js';
import { etag, nextRevision, type AutomationPorts, type StoredRule } from './ports.js';

export function parseContract<T>(name: AutomationSchemaName, value: unknown): T {
  const shape = validateAutomation(name, value);
  if (!shape.valid) throw new AutomationError('invalid_request', 'Input violates the closed Automation schema.', shape.issues);
  return value as T;
}
export function requireEtag(actual: string, supplied: string): void {
  if (supplied !== etag(actual)) throw new AutomationError('precondition_failed', 'Configuration changed. Read the current resource and retry.', [], etag(actual));
}
export async function requireRule(ports: AutomationPorts, actor: AutomationActor, id: string): Promise<StoredRule> {
  const rule = await ports.rules.load(actor.accountId, id);
  if (!rule) throw new AutomationError('resource_not_found', 'Rule is unavailable.'); return rule;
}
export async function requireBinding(ports: AutomationPorts, actor: AutomationActor, id: string) {
  const binding = await ports.bindings.load(actor.accountId, id);
  if (!binding) throw new AutomationError('resource_not_found', 'Binding set is unavailable.'); return binding;
}
export function assertM1Input(input: RuleInput): void {
  const issues = validateM1Rule(input.definition);
  if (input.executionPolicyId) issues.push({ path: '/executionPolicyId', code: 'unsupportedCapability', message: 'M1 has no execution policy.' });
  if (issues.length) throw new AutomationError(issues.some((issue) => issue.code === 'unsupportedCapability')
    ? 'automation_unsupported_capability' : 'automation_invalid_graph', 'Rule is not supported by the finite M1 profile.', issues);
}
export async function inspectInput(ports: AutomationPorts, actor: AutomationActor, input: RuleInput) {
  const binding = await requireBinding(ports, actor, input.bindingSetId);
  const collectionId = scopeCollectionId(input.definition, binding.values);
  const collection = collectionId ? await ports.reads.readCollection(actor, collectionId) : null;
  if (!collection) throw new AutomationError('resource_not_found', 'Explicit authorized collection scope is required.');
  const resolutions = await resolveBindings(ports.reads, actor, input.definition, binding.values);
  return { binding, collection, resolutions };
}
export async function validateRule(ports: AutomationPorts, actor: AutomationActor, body: unknown): Promise<ValidationResult> {
  const input = parseContract<RuleInput>('RuleInput', body);
  const issues = validateM1Rule(input.definition);
  if (input.executionPolicyId) issues.push({ path: '/executionPolicyId', code: 'unsupportedCapability', message: 'Execution policies are unavailable in M1.' });
  const diagnostics: Diagnostic[] = issues.map((issue) => ({ code: issue.code, severity: 'error', location: issue.path, message: issue.message }));
  const inspected = await inspectInput(ports, actor, input);
  for (const [role, resolution] of Object.entries(inspected.resolutions)) if (resolution.status === 'blocked')
    diagnostics.push({ code: resolution.code, severity: 'error', location: `/bindings/${role}`, role, message: resolution.message });
  return { valid: diagnostics.length === 0, normalizedDefinition: input.definition, semanticDigest: ruleSemanticDigest(input.definition),
    diagnostics: diagnostics.slice(0, 100), supportedHosts: issues.length ? [] : ['browser', 'server'] };
}
export async function createRule(ports: AutomationPorts, actor: AutomationActor, body: unknown) {
  const input = parseContract<RuleInput>('RuleInput', body); assertM1Input(input);
  if ((await ports.rules.list(actor.accountId, null, 500)).length >= 500) throw new AutomationError('invalid_request', 'Maximum 500 rules per owner.');
  const inspected = await inspectInput(ports, actor, input), now = (await ports.now()).toISOString();
  const rule: StoredRule = { definitionRevisionId: ports.id(), definitionRevision: '1', sortCreatedAt: now, view: { ...input, id: ports.id(), revision: '1',
    desiredState: 'draft', effectiveState: 'draft', createdAt: now, updatedAt: now } };
  await ports.rules.save(actor.accountId, rule); await ports.dependencies.replace(rule.definitionRevisionId, inspected.resolutions); return rule.view;
}
export async function replaceRule(ports: AutomationPorts, actor: AutomationActor, id: string, body: unknown, ifMatch: string) {
  const previous = await requireRule(ports, actor, id); requireEtag(previous.view.revision, ifMatch);
  if (previous.view.desiredState === 'archived') throw new AutomationError('automation_rule_conflict', 'Archived rules are immutable.');
  const input = parseContract<ChangeInput>('ChangeInput', body);
  const ruleInput: RuleInput = { definition: input.definition, bindingSetId: input.bindingSetId,
    ...(input.executionPolicyId ? { executionPolicyId: input.executionPolicyId } : {}), ...(previous.view.templateRef ? { templateRef: previous.view.templateRef } : {}) };
  assertM1Input(ruleInput); const inspected = await inspectInput(ports, actor, ruleInput);
  // Editing an enabled revision requires fresh preview/activation. It never silently activates new logic.
  const desiredState = previous.view.desiredState === 'enabled' ? 'paused' : previous.view.desiredState;
  await ports.activation(previous, inspected.collection.id, inspected.collection.commitOrdinal, false);
  const rule: StoredRule = { sortCreatedAt: previous.sortCreatedAt, definitionRevisionId: ports.id(), definitionRevision: nextRevision(previous.definitionRevision),
    view: { ...previous.view, ...ruleInput, revision: nextRevision(previous.view.revision), desiredState, effectiveState: desiredState,
      updatedAt: (await ports.now()).toISOString() } };
  await ports.rules.save(actor.accountId, rule); await ports.dependencies.replace(rule.definitionRevisionId, inspected.resolutions); return rule.view;
}
export async function saveBinding(ports: AutomationPorts, actor: AutomationActor, body: unknown, id?: string, ifMatch?: string) {
  const input = parseContract<BindingSetInput>('BindingSetInput', body);
  const previous = id ? await requireBinding(ports, actor, id) : null;
  if (previous) requireEtag(previous.revision, ifMatch ?? '');
  for (const binding of Object.values(input.values).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) {
    if (binding.kind !== 'folder') throw new AutomationError('automation_unsupported_capability', 'Only folder bindings are available in M1.');
    const result = await ports.reads.readFolder(actor, binding.folder);
    if (result.status !== 'valid') throw new AutomationError('automation_binding_unavailable', result.message);
    if (binding.allowedAncestor) {
      const ancestor = await ports.reads.readFolder(actor, binding.allowedAncestor);
      if (ancestor.status !== 'valid' || ![result.snapshot.folder, ...result.snapshot.ancestors].some((ref) =>
        ref.serverUuid === binding.allowedAncestor!.serverUuid && ref.collectionId === binding.allowedAncestor!.collectionId && ref.nodeId === binding.allowedAncestor!.nodeId))
        throw new AutomationError('automation_binding_unavailable', 'Binding is outside the allowed live ancestor.');
    }
  }
  const view = { ...input, id: id ?? ports.id(), revision: previous ? nextRevision(previous.revision) : '1', updatedAt: (await ports.now()).toISOString() };
  await ports.bindings.save(actor.accountId, view); return view;
}
