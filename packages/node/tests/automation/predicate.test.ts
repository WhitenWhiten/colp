import { test, expect } from 'vitest';
import facts from '../fixtures/automation/event-facts.json' with { type: 'json' };
import { compilePredicate } from '../../src/automation/index.js';

function decision(match: unknown, input: unknown = facts) {
  const compiled = compilePredicate(match);
  expect(compiled.valid).toBe(true);
  if (!compiled.valid) throw new Error('compile failed');
  return compiled.evaluate(input).outcome;
}
const field = (field: string, op: string, value: unknown) => ({ kind: 'field', field, op, value });
test('host suffix boundary, IDNA and exact normalized equality', () => {
  const predicate = field('bookmark.url.host', 'hostSuffix', 'ARXIV.org.');
  expect(decision(predicate)).toBe('matched');
  expect(decision(predicate, { ...facts, bookmark: { ...facts.bookmark, url: { host: 'arxiv.org.evil.example' } } })).toBe('notMatched');
  expect(decision(predicate, { ...facts, bookmark: { ...facts.bookmark, url: { host: 'sub.arxiv.org' } } })).toBe('matched');
});
test('startsWith is literal normalized path prefix with missing input propagation', () => {
  const predicate = field('bookmark.url.path', 'startsWith', '/docs/');
  for (const [path, outcome] of [['/docs/a', 'matched'], ['/other/docs/a', 'notMatched'], ['/docs', 'notMatched'], ['/Docs/a', 'notMatched']]) {
    expect(decision(predicate, { ...facts, bookmark: { ...facts.bookmark, url: { host: 'example.org', path } } })).toBe(outcome);
  }
  expect(decision(predicate, { ...facts, bookmark: { ...facts.bookmark, url: { host: 'example.org' } } })).toBe('missingInput');
});
test('typed operators and boolean profile are bounded', () => {
  for (const match of [field('bookmark.tags', 'eq', 'x'), field('bookmark.title', 'startsWith', 'a'),
    field('bookmark.title', 'in', 'x'), { kind: 'all', items: [] },
    { kind: 'cel', profile: 'colp-cel-v1', expression: 'true', dependencies: [] }]) expect(compilePredicate(match).valid).toBe(false);
  for (const op of ['eq', 'in', 'contains', 'hasTag']) {
    const compiled = compilePredicate(field('event.changedFields', op, op === 'in' ? ['title'] : 'title'));
    expect(compiled.valid ? [] : compiled.issues.map((issue) => issue.code)).toEqual(['unsupportedCapability']);
  }
  let match: unknown = field('bookmark.kind', 'eq', 'bookmark');
  for (let depth = 0; depth < 16; depth++) match = { kind: 'not', item: match };
  expect(compilePredicate(match).valid).toBe(false);
  const branch = { kind: 'all', items: Array.from({ length: 32 }, () => field('bookmark.kind', 'eq', 'bookmark')) };
  expect(compilePredicate({ kind: 'all', items: Array.from({ length: 4 }, () => branch) }).valid).toBe(false);
});
test('review: finite predicates permitted by the reviewed schema are not given an extra byte cap', () => {
  expect(compilePredicate(field('bookmark.title', 'in', Array(30).fill('x'.repeat(200)))).valid).toBe(true);
});
test('boolean decisions and CPU exhaustion isolate one invocation', () => {
  const compiled = compilePredicate({ kind: 'all', items: [field('bookmark.kind', 'eq', 'bookmark'), field('event.origin', 'in', ['user'])] });
  expect(compiled.valid).toBe(true); if (!compiled.valid) return;
  expect(compiled.dependencies).toEqual(['bookmark.kind', 'event.origin']);
  let tick = 0;
  expect(compiled.evaluate(facts, { now: () => tick++ * 51 })).toEqual({ outcome: 'error', code: 'evaluationBudgetExceeded' });
  expect(compiled.evaluate(facts).outcome).toBe('matched');
  expect(decision({ kind: 'not', item: field('bookmark.url.path', 'eq', '/') }, { ...facts, bookmark: { ...facts.bookmark, url: { host: 'e.org' } } })).toBe('missingInput');
  for (let i = 0; i < 10; i++) expect(compiled.evaluate(facts).outcome).toBe('matched');
});

test('review: compiler snapshots input and keeps its normalized export isolated from evaluation', () => {
  const input = { kind: 'field' as const, field: 'bookmark.url.host' as const, op: 'eq' as const, value: 'ARXIV.ORG.' };
  const compiled = compilePredicate(input);
  expect(compiled.valid).toBe(true); if (!compiled.valid) return;
  expect(compiled.normalizedPredicate).toMatchObject({ value: 'arxiv.org' });
  input.value = 'evil.example';
  if (compiled.normalizedPredicate.kind === 'field') compiled.normalizedPredicate.value = 'evil.example';
  expect(compiled.evaluate(facts).outcome).toBe('matched');
});
