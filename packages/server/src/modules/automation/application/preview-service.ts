import { automationDigest, compilePredicate, arbitratePlacement, type PreviewInput, type PreviewResult, type PreviewDecision, type RuleInput } from '@know-n/colp/automation';
import { AutomationError } from '../domain/errors.js';
import type { AutomationActor } from '../domain/bindings.js';
import { assertM1Input, inspectInput, parseContract } from './rule-service.js';
import { ruleInput, type AutomationPorts } from './ports.js';

export async function previewSnapshot(ports: AutomationPorts, actor: AutomationActor, input: PreviewInput) {
  assertM1Input(input.rule);
  if (input.mode === 'retainedHistory') throw new AutomationError('automation_unsupported_capability', 'Historical event-time facts are unavailable. Current state is never substituted.');
  const inspected = await inspectInput(ports, actor, input.rule);
  const sample = input.mode === 'currentState' ? await ports.sample(actor, input.rule.definition, inspected.binding.values)
    : { events: input.events!, truncated: false, revisions: {} };
  if (sample.events.some((event) => event.collectionId !== inspected.collection.id)) throw new AutomationError('invalid_request', 'Supplied facts must belong to the explicit rule scope.');
  const settings = await ports.settings.get(actor.accountId);
  const bindings = Object.fromEntries(Object.entries(inspected.resolutions).map(([role, resolution]) => [role, resolution.status === 'valid'
    ? { folder: resolution.snapshot.folder, ancestors: resolution.snapshot.ancestors, policy: resolution.snapshot.policyRevision } : resolution]));
  const competition = [];
  for (const candidate of await ports.rules.list(actor.accountId, null, 500)) {
    if (candidate.view.desiredState !== 'enabled' || automationDigest(ruleInput(candidate.view)) === automationDigest(input.rule)) continue;
    const binding = await ports.bindings.load(actor.accountId, candidate.view.bindingSetId);
    competition.push({ id: candidate.view.id, revision: candidate.view.revision, input: ruleInput(candidate.view), binding: binding ?? null });
  }
  const configDigest = automationDigest({ competition, rule: input.rule, bindingRevision: inspected.binding.revision, bindings, settingsRevision: settings.revision,
    mode: input.mode, from: input.from ?? null, to: input.to ?? null, sampleRevisions: sample.revisions,
    facts: sample.events.map(({ eventId, nodeId, type, origin, bookmark, intakeDisposition }) => ({ eventId, nodeId, type, origin, bookmark, intakeDisposition: intakeDisposition ?? 'unknown' })) });
  return { ...inspected, ...sample, configDigest };
}
export async function previewRule(ports: AutomationPorts, actor: AutomationActor, body: unknown): Promise<PreviewResult> {
  const input = parseContract<PreviewInput>('PreviewInput', body), snapshot = await previewSnapshot(ports, actor, input);
  const compiled = compilePredicate(input.rule.definition.match);
  if (!compiled.valid) throw new AutomationError('automation_invalid_graph', 'Predicate cannot compile.', compiled.issues);
  const alternatives = [];
  for (const stored of await ports.rules.list(actor.accountId, null, 500)) {
    if (stored.view.desiredState !== 'enabled' || automationDigest(ruleInput(stored.view)) === automationDigest(input.rule)) continue;
    try {
      const other = await inspectInput(ports, actor, ruleInput(stored.view));
      if (other.collection.id !== snapshot.collection.id) continue;
      const evaluator = compilePredicate(stored.view.definition.match);
      if (evaluator.valid) alternatives.push({ stored, other, evaluator });
    } catch (error) { if (!(error instanceof AutomationError)) throw error; }
  }
  const decisions: PreviewDecision[] = [];
  for (const event of snapshot.events) {
    const predicate = compiled.evaluate(event);
    const outcome = predicate.outcome === 'error' ? 'blocked' : predicate.outcome;
    const decision: PreviewDecision = { eventId: event.eventId, outcome, satisfiedTasks: [], pendingTasks: [], explanation: predicate.outcome === 'error' ? predicate.code : predicate.outcome };
    const scopeRole = input.rule.definition.scope.folderRole;
    const scope = scopeRole ? snapshot.resolutions[scopeRole] : undefined;
    if (scope?.status === 'valid') {
      const ids = input.rule.definition.scope.includeDescendants ? [event.bookmark.parent, ...(event.bookmark.ancestors ?? [])] : [event.bookmark.parent];
      if (!ids.some((ref) => ref?.nodeId === scope.snapshot.folder.nodeId && ref.collectionId === scope.snapshot.folder.collectionId && ref.serverUuid === scope.snapshot.folder.serverUuid)) decision.outcome = 'notMatched';
    }
    if (event.origin === 'restore' || (event.origin === 'import' && input.rule.definition.policy.imports === 'exclude')
      || event.origin === 'automation' || event.hopCount >= input.rule.definition.policy.maxHops) decision.outcome = 'notMatched';
    if (input.rule.definition.on === 'node.created' && event.type !== 'node.created') decision.outcome = 'notMatched';
    if (input.rule.definition.on === 'bookmark.intake' && !['node.created', 'bookmark.intake'].includes(event.type)) decision.outcome = 'notMatched';
    if (decision.outcome === 'matched') {
      const role = input.rule.definition.intake?.folderRole, resolution = role ? snapshot.resolutions[role] : undefined;
      if (Object.values(snapshot.resolutions).some((result) => result.status === 'blocked')) {
        decision.outcome = 'blocked'; decision.explanation = 'Required binding unavailable; keep original parent.';
      } else if (resolution?.status === 'valid') {
        const candidates = [{ ruleId: 'preview', priority: input.rule.definition.priority, folder: resolution.snapshot.folder, authorized: true, privacyAllowed: true }];
        for (const { stored, other, evaluator } of alternatives) {
          const target = other.resolutions[stored.view.definition.intake?.folderRole ?? ''];
          if (target?.status === 'valid' && evaluator.evaluate(event).outcome === 'matched') candidates.push({ ruleId: stored.view.id,
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
