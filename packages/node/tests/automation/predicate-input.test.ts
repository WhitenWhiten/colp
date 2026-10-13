import { afterEach, expect, test, vi } from 'vitest';
import { compilePredicate, preparePredicateInput, type PreparedPredicateInput } from '../../src/automation/index.js';
import * as normalization from '../../src/automation/normalize.js';
import facts from '../fixtures/automation/event-facts.json' with { type: 'json' };

const compiled = compilePredicate({ kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' });
if (!compiled.valid) throw new Error('Invalid predicate fixture');
const evaluate = compiled.evaluate;
afterEach(() => vi.restoreAllMocks());

test('one batch normalizes facts once rather than once per competing rule', () => {
  const normalize = vi.spyOn(normalization, 'normalizeEventFacts');
  const inputSnapshot = preparePredicateInput(facts);
  for (let index = 0; index < 500; index++) expect(evaluate(facts, { inputSnapshot }).outcome).toBe('matched');
  expect(normalize).toHaveBeenCalledTimes(1);
});

test('prepared facts are private snapshots, not references to mutable caller fields', () => {
  const source = structuredClone(facts);
  const inputSnapshot = preparePredicateInput(source);
  source.bookmark.url.host = 'other.example';
  expect(evaluate(source, { inputSnapshot }).outcome).toBe('matched');
  expect(evaluate(source).outcome).toBe('notMatched');
  expect(Object.isFrozen(inputSnapshot)).toBe(true);
});

test('forged handles and mismatched source/version cannot bypass normalization', () => {
  const inputSnapshot = preparePredicateInput(facts);
  for (const options of [{ inputSnapshot: {} as PreparedPredicateInput }, { inputSnapshot, factsVersion: 99 }]) {
    expect(evaluate(facts, options)).toEqual({ outcome: 'error', code: 'evaluationFailed' });
  }
  expect(evaluate(structuredClone(facts), { inputSnapshot })).toEqual({ outcome: 'error', code: 'evaluationFailed' });
});

test('prepared input cost cannot evade an invocation deadline', () => {
  let tick = 0;
  const inputSnapshot = preparePredicateInput(facts, { now: () => tick++ * 51 });
  expect(evaluate(facts, { inputSnapshot, now: () => 0 })).toEqual({ outcome: 'error', code: 'evaluationBudgetExceeded' });
});
