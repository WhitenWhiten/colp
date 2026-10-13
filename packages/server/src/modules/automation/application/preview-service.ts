import { automationDigest, compilePredicate, arbitratePlacement, type PreviewInput, type PreviewResult, type PreviewDecision } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import type { AutomationActor } from '../domain/bindings.js';
import { assertM1Input, inspectInput, normalizeRuleInput, parseContract } from './rule-service.js';
import { bindingResolutionSignature, eventEligible, intakeBindingsAvailable } from './rule-eligibility.js';
import { ruleInput, type AutomationPorts } from './ports.js';

export async function previewSnapshot(ports: AutomationPorts, actor: AutomationActor, input: PreviewInput) {
  input = { ...input, rule: normalizeRuleInput(input.rule) };
  assertM1Input(input.rule);
  if (input.mode === 'retainedHistory') throw new AutomationError('automation_unsupported_capability', 'Historical event-time facts are unavailable. Current state is never substituted.');
  const inspected = await inspectInput(ports, actor, input.rule);
  const scopeRole = input.rule.definition.scope.folderRole;
  if (input.mode === 'currentState' && scopeRole && inspected.resolutions[scopeRole]?.status !== 'valid')
    throw new AutomationError('automation_binding_unavailable', 'Current-state scope is unavailable; sampling cannot widen to the collection.');
  const sample = input.mode === 'currentState' ? await ports.sample(actor, input.rule.definition, inspected.binding.values)
    : { events: input.events!, truncated: false, revisions: {} };
  if (sample.events.some((event) => event.collectionId !== inspected.collection.id)) throw new AutomationError('invalid_request', 'Supplied facts must belong to the explicit rule scope.');
  const settings = await ports.settings.get(actor.accountId);
  const bindings = bindingResolutionSignature(inspected.resolutions);
  const competition = [], alternatives = [];
  for (const candidate of await ports.rules.list(actor.accountId, null, 500)) {
    const candidateInput = normalizeRuleInput(ruleInput(candidate.view));
    if (candidate.view.desiredState !== 'enabled' || automationDigest(candidateInput) === automationDigest(input.rule)) continue;
    const binding = await ports.bindings.load(actor.accountId, candidate.view.bindingSetId);
    let signature: unknown = null;
    try {
      const other = await inspectInput(ports, actor, candidateInput);
      signature = bindingResolutionSignature(other.resolutions);
      const evaluator = compilePredicate(candidateInput.definition.match);
      if (other.collection.id === inspected.collection.id && evaluator.valid)
        alternatives.push({ stored: candidate, other, evaluator });
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      signature = { unavailable: error.code };
    }
    competition.push({ id: candidate.view.id, revision: candidate.view.revision, input: candidateInput, binding: binding ?? null, resolutions: signature });
  }
  const configDigest = automationDigest({ competition, rule: input.rule, bindingRevision: inspected.binding.revision, bindings, settingsRevision: settings.revision,
    mode: input.mode, from: input.from ?? null, to: input.to ?? null, sampleRevisions: sample.revisions,
    facts: sample.events.map(({ commitOrdinal: _ordinal, occurredAt: _time, operationId: _operation, ...facts }) => facts) });
  return { ...inspected, ...sample, configDigest, alternatives };
}
export async function previewRule(ports: AutomationPorts, actor: AutomationActor, body: unknown): Promise<PreviewResult> {
  const parsed = parseContract('PreviewInput', body);
  const input: PreviewInput = { ...parsed, rule: normalizeRuleInput(parsed.rule) };
  const snapshot = await previewSnapshot(ports, actor, input);
  const compiled = compilePredicate(input.rule.definition.match);
  if (!compiled.valid) throw new AutomationError('automation_invalid_graph', 'Predicate cannot compile.', compiled.issues);
  const decisions: PreviewDecision[] = [];
  for (const event of snapshot.events) {
    const predicate = compiled.evaluate(event);
    const outcome = predicate.outcome === 'error' ? 'blocked' : predicate.outcome;
    const decision: PreviewDecision = { eventId: event.eventId, outcome, satisfiedTasks: [], pendingTasks: [], explanation: predicate.outcome === 'error' ? predicate.code : predicate.outcome };
    if (!eventEligible(input.rule.definition, snapshot.resolutions, event)) {
      decision.outcome = 'notMatched'; decision.explanation = 'Outside rule scope, source policy, trigger or hop bound.';
    }
    if (decision.outcome === 'matched') {
      const role = input.rule.definition.intake?.folderRole, resolution = role ? snapshot.resolutions[role] : undefined;
      if (!intakeBindingsAvailable(input.rule.definition, snapshot.resolutions)) {
        decision.outcome = 'blocked'; decision.explanation = 'Required binding unavailable; keep original parent.';
      } else if (resolution?.status === 'valid') {
        const candidates = [{ ruleId: 'preview', priority: input.rule.definition.priority, folder: resolution.snapshot.folder, authorized: true, privacyAllowed: true }];
        for (const { stored, other, evaluator } of snapshot.alternatives) {
          const target = other.resolutions[stored.view.definition.intake?.folderRole ?? ''];
          if (target?.status === 'valid' && intakeBindingsAvailable(stored.view.definition, other.resolutions)
            && eventEligible(stored.view.definition, other.resolutions, event) && evaluator.evaluate(event).outcome === 'matched') candidates.push({ ruleId: stored.view.id,
            priority: stored.view.definition.priority, folder: target.snapshot.folder, authorized: true, privacyAllowed: true });
        }
        const placement = arbitratePlacement(candidates, { explicitSelection: event.intakeDisposition === 'userSelected',
          intentKnown: event.intakeDisposition === 'userDefault' || event.intakeDisposition === 'rulePlacement' });
        if (placement.kind === 'conflict') decision.outcome = 'conflict';
        decision.satisfiedTasks = placement.satisfiedTasks;
        decision.explanation = placement.kind === 'place' ? `Would place in canonical folder ${placement.folder.nodeId}; runtime unavailable; no effect.`
          : `${placement.kind}: ${placement.reason}; rules ${placement.ruleIds.join(', ')}; original location preserved.`;
      }
    }
    decisions.push(decision);
  }
  const result: PreviewResult = { previewId: ports.id(), sideEffects: false, decisions,
    diagnostics: [{ code: input.mode === 'currentState' ? 'currentStateSnapshot' : 'suppliedFacts', severity: 'info', location: '/mode',
      message: input.mode === 'currentState' ? 'Current authorized rows only; these are not historical intake facts. Unknown intent preserves placement.' : 'Hypothetical supplied facts; no canonical business effects.' }],
    plannedRunCount: decisions.filter((decision) => decision.outcome === 'matched').length, remainderCount: 0, completeHistory: false, truncated: snapshot.truncated };
  await ports.previews.save(actor.accountId, { id: result.previewId, input, result, configDigest: snapshot.configDigest,
    expiresAt: new Date((await ports.now()).getTime() + 10 * 60_000) }); return result;
}
