import { expect, test, vi } from 'vitest';
import fixture from '../../../../node/tests/fixtures/automation/m1-placement.json' with { type: 'json' };
import facts from '../../../../node/tests/fixtures/automation/event-facts.json' with { type: 'json' };
import { compilePredicate, type EventFacts, type RuleDefinition } from '@know-n/colp/automation';
import { admitEvent } from '../../../src/modules/automation/application/admit-event.js';
import { evaluateRuleEvents, type PreparedRule } from '../../../src/modules/automation/application/rule-evaluation.js';

const event = { ...facts, commitOrdinal: '10', intakeDisposition: 'userDefault' } as EventFacts;
function rule(ruleId: string, nodeId = 'destination', priority = 100): PreparedRule {
  const definition = { ...fixture, priority, scope: { collectionId: event.collectionId } } as RuleDefinition;
  const predicate = compilePredicate(definition.match);
  if (!predicate.valid) throw new Error('Invalid rule fixture');
  const folder = { serverUuid: 'server', collectionId: event.collectionId, nodeId };
  return { ruleId, definition, predicate: { ...predicate, evaluate: vi.fn(predicate.evaluate) },
    resolutions: { academicRoot: { status: 'valid', snapshot: { folder, ancestors: [], title: nodeId, revision: '1', policyRevision: '1' } } },
    bindings: { available: true, issues: [] } };
}

test('500 matching candidates are evaluated once each through admission, not once per competitor', () => {
  const candidates = Array.from({ length: 500 }, (_, index) => ({ ...rule(`rule-${index}`),
    revisionId: `revision-${index}`, afterOrdinal: '0', epoch: '1' }));
  const decisions = admitEvent(candidates, event);
  expect(decisions).toHaveLength(500);
  expect(decisions.every(decision => decision.createRun && decision.plan.kind === 'placed')).toBe(true);
  for (const candidate of candidates) expect(candidate.predicate.evaluate).toHaveBeenCalledTimes(1);
});

test('priority, compatible effects and conflicts are independent of candidate iteration order', () => {
  const candidates = [rule('low', 'other', 1), rule('winner', 'destination', 2), rule('compatible', 'destination', 1)];
  for (const ordered of [candidates, [...candidates].reverse()]) {
    const plans = evaluateRuleEvents(ordered, event);
    const byId = Object.fromEntries(ordered.map((candidate, index) => [candidate.ruleId, plans[index]!.kind]));
    expect(byId).toEqual({ low: 'overridden', winner: 'placed', compatible: 'placed' });
  }
  expect(evaluateRuleEvents([rule('a', 'a'), rule('b', 'b')], event).map(plan => plan.kind)).toEqual(['conflict', 'conflict']);
});

test('one failed rule cannot borrow a sibling authority or prevent a healthy placement', () => {
  const broken = rule('broken');
  broken.predicate.evaluate = () => ({ outcome: 'error', code: 'evaluationBudgetExceeded' });
  expect(evaluateRuleEvents([broken, rule('healthy')], event).map(plan => plan.kind)).toEqual(['blocked', 'placed']);
  const unavailable = rule('unavailable');
  unavailable.bindings = { available: false, issues: [] };
  expect(evaluateRuleEvents([unavailable, rule('healthy')], event).map(plan => plan.kind)).toEqual(['blocked', 'placed']);
});

test.each(['unknown', 'userSelected'] as const)('%s intent is preserved even with competing rules', intakeDisposition => {
  expect(evaluateRuleEvents([rule('a'), rule('b')], { ...event, intakeDisposition }).map(plan => plan.kind)).toEqual(['preserved', 'preserved']);
});
