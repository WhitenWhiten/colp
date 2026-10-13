import { automationDigest, compilePredicate, type PreviewInput, type PreviewResult } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import type { AutomationActor } from '../domain/bindings.js';
import { inspectInput, normalizeRuleInput, parseContract } from './rule-service.js';
import { assertSupportedRule } from './worker-configuration.js';
import { bindingResolutionSignature } from './rule-eligibility.js';
import { evaluateRuleEvent, plansRun, type PreparedRule } from './rule-evaluation.js';
import { previewDecision } from './preview-decision.js';
import { intakePolicyDiagnostics, previewPlanDiagnostics } from './policy-diagnostics.js';
import { ruleInput, type AutomationPorts } from './ports.js';

export async function previewSnapshot(ports: AutomationPorts, actor: AutomationActor, input: PreviewInput) {
  input = { ...input, rule: normalizeRuleInput(input.rule) };
  assertSupportedRule(input.rule,ports.workerEnabled);
  if (input.mode === 'retainedHistory') throw new AutomationError('automation_unsupported_capability', 'Historical preview is not installed on this host. Current state is never substituted.');
  const inspected = await inspectInput(ports, actor, input.rule);
  const scopeRole = input.rule.definition.scope.folderRole;
  if (input.mode === 'currentState' && scopeRole && inspected.resolutions[scopeRole]?.status !== 'valid')
    throw new AutomationError('automation_binding_unavailable', 'Current-state scope is unavailable; sampling cannot widen to the collection.');
  const sample = input.mode === 'currentState' ? await ports.sample(actor, input.rule.definition, inspected.binding.values)
    : { events: input.events!, truncated: false, revisions: {} };
  if (sample.events.some((event) => event.collectionId !== inspected.collection.id)) throw new AutomationError('invalid_request', 'Supplied facts must belong to the explicit rule scope.');
  const settings = await ports.settings.get(actor.accountId);
  const bindings = bindingResolutionSignature(inspected.resolutions);
  const evaluator = compilePredicate(input.rule.definition.match);
  if (!evaluator.valid) throw new AutomationError('automation_invalid_graph', 'Predicate cannot compile.', evaluator.issues);
  const proposed: PreparedRule = { ruleId: 'preview', definition: input.rule.definition, resolutions: inspected.resolutions,
    bindings: inspected.bindingAssessment, predicate: evaluator };
  const competition: string[] = [], alternatives: PreparedRule[] = [];
  const proposedDigest = automationDigest(input.rule);
  for (const candidate of await ports.rules.list(actor.accountId, null, 500)) {
    if (candidate.view.desiredState !== 'enabled') continue;
    const candidateInput = normalizeRuleInput(ruleInput(candidate.view));
    if (automationDigest(candidateInput) === proposedDigest) continue;
    const binding = await ports.bindings.load(actor.accountId, candidate.view.bindingSetId);
    let signature: unknown = null;
    try {
      const other = await inspectInput(ports, actor, candidateInput);
      signature = bindingResolutionSignature(other.resolutions);
      const evaluator = compilePredicate(candidateInput.definition.match);
      if (other.collection.id === inspected.collection.id && evaluator.valid)
        alternatives.push({ ruleId: candidate.view.id, definition: candidateInput.definition, resolutions: other.resolutions,
          bindings: other.bindingAssessment, predicate: evaluator });
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      signature = { unavailable: error.code };
    }
    competition.push(automationDigest({ id: candidate.view.id, revision: candidate.view.revision, input: candidateInput, binding: binding ?? null, resolutions: signature }));
  }
  const configDigest = automationDigest({ version: 'preview-snapshot/v2', competition, rule: input.rule, bindingRevision: inspected.binding.revision, bindings,worker: inspected.worker, settingsRevision: settings.revision,
    mode: input.mode, from: input.from ?? null, to: input.to ?? null, sampleRevisions: sample.revisions,
    facts: sample.events.map(({ commitOrdinal: _ordinal, occurredAt: _time, operationId: _operation, ...facts }) => automationDigest(facts)) });
  return { ...inspected, ...sample, configDigest, proposed, alternatives };
}
export async function previewRule(ports: AutomationPorts, actor: AutomationActor, body: unknown): Promise<PreviewResult> {
  const parsed = parseContract('PreviewInput', body);
  const input: PreviewInput = { ...parsed, rule: normalizeRuleInput(parsed.rule) };
  const snapshot = await previewSnapshot(ports, actor, input);
  const plans = snapshot.events.map((event) => evaluateRuleEvent(snapshot.proposed, snapshot.alternatives, event));
  const decisions = plans.map((plan, index) => ({ ...previewDecision(snapshot.events[index]!.eventId, plan),
    ...(snapshot.events[index]!.origin === 'import' ? { explanation: 'Imports are excluded from automatic intake. Use an explicit run-once preview when that capability is available.' } : {}) }));
  const result: PreviewResult = { previewId: ports.id(), sideEffects: false, decisions,
    diagnostics: [{ code: input.mode === 'currentState' ? 'currentStateSnapshot' : 'suppliedFacts', severity: 'info', location: '/mode',
      message: input.mode === 'currentState' ? 'Current authorized rows only; these are not historical intake facts. Unknown intent preserves placement.' : 'Hypothetical supplied facts; no canonical business effects.' },
    previewPlanDiagnostics(plans), ...intakePolicyDiagnostics(input.rule.definition.policy, '/rule/definition/policy')],
    plannedRunCount: plans.filter(plansRun).length, remainderCount: 0, completeHistory: false, truncated: snapshot.truncated };
  if (!snapshot.collection.currentOwner) result.diagnostics.push({ code: 'ownerRequired', severity: 'warning', location: '/rule/definition/scope',
    message: 'M1 execution requires the current collection Owner; this preview does not grant runtime authority.' });
  await ports.previews.save(actor.accountId, { id: result.previewId, input, result, configDigest: snapshot.configDigest,
    expiresAt: new Date((await ports.now()).getTime() + 10 * 60_000) });
  return result;
}
