import { describe, test, expect } from 'vitest';
import rule from '../fixtures/automation/m1-placement.json' with { type: 'json' };
import facts from '../fixtures/automation/event-facts.json' with { type: 'json' };
import { normalizeUrl, normalizeHost, normalizeEventFacts, normalizePathText, compilePredicate, taskInputDigest, automationDigest, normalizeRuleDefinition, ruleSemanticDigest, type RuleDefinition } from '../../src/automation/index.js';

describe('normalization and canonical digests', () => {
  test('host case, IDNA, terminal dot, query spoof and malformed URLs', () => {
    expect(normalizeUrl('https://ARXIV.org./abs/a?host=evil.org')).toEqual({ status: 'available', host: 'arxiv.org', path: '/abs/a' });
    expect(normalizeHost('[::1]')).toBe('[::1]');
    expect(normalizeHost('BÜCHER.example.')).toBe('xn--bcher-kva.example');
    expect(normalizeHost('arxiv.org.evil.example')).toBe('arxiv.org.evil.example');
    for (const url of ['not a url', 'file:///a', 'javascript:alert(1)', 'https://', 'https://u:p@arxiv.org']) {
      expect(normalizeUrl(url).status).toBe('missingInput');
    }
    expect(normalizeHost('arxiv.org/?evil')).toBeUndefined();
  });
  test('facts versions and unavailable paths stay explicit', () => {
    const path = normalizeEventFacts({ ...facts, bookmark: { ...facts.bookmark, url: { host: 'example.org', path: '/a/../docs/b' } } });
    if (path.status === 'available') expect(path.facts.bookmark.url.path).toBe('/docs/b');
    expect(normalizeEventFacts(facts, 99).status).toBe('missingInput');
    const noPath = { ...facts, bookmark: { ...facts.bookmark, url: { host: 'ARXIV.ORG.' } } };
    const result = normalizeEventFacts(noPath);
    expect(result.status).toBe('available');
    if (result.status === 'available') expect(result.facts.bookmark.url.path).toBeUndefined();
  });
  test('placement digest ignores note but binds canonical identity, allowlist, revisions and URL', () => {
    const identity = { serverUuid: 's', collectionId: 'c', nodeId: 'n', taskId: 'intake', outputContract: 'placement.subtree.v1',
      revisions: { url: 'r1', binding: '1', policy: null }, inputFields: ['url'], acceptedPredecessors: {} };
    const original = taskInputDigest(identity, { url: 'https://arxiv.org/a', note: 'a' });
    expect(taskInputDigest(identity, { url: 'https://arxiv.org/a', note: 'b' })).toBe(original);
    expect(taskInputDigest(identity, { url: 'https://arxiv.org/b', note: 'a' })).not.toBe(original);
    expect(taskInputDigest({ ...identity, nodeId: 'other' }, { url: 'https://arxiv.org/a' })).not.toBe(original);
    const ref = { nodeId: 'same' };
    expect(automationDigest({ a: ref, b: ref })).toBe(automationDigest({ a: { nodeId: 'same' }, b: { nodeId: 'same' } }));
    expect(automationDigest({ b: 1, a: 2 })).toBe(automationDigest({ a: 2, b: 1 }));
    expect(automationDigest({ a: 2, b: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

test('review: semantic digests share compiler normalization and ignore display labels', () => {
  const definition = structuredClone(rule) as RuleDefinition;
  definition.match = { kind: 'field', field: 'bookmark.url.host', op: 'in', value: ['BÜCHER.example.', 'ARXIV.ORG.'] };
  const normalized = normalizeRuleDefinition(definition);
  expect(normalized.match).toMatchObject({ value: ['xn--bcher-kva.example', 'arxiv.org'] });
  expect(definition.match).toMatchObject({ value: ['BÜCHER.example.', 'ARXIV.ORG.'] });
  expect(ruleSemanticDigest(definition)).toBe(ruleSemanticDigest({ ...normalized, name: 'Another display label' }));
  expect(ruleSemanticDigest({ ...normalized, priority: normalized.priority + 1 })).not.toBe(ruleSemanticDigest(normalized));
});

test('review: rule path and host values share the bookmark URL normalizer', () => {
  const at = (url: { host: string; path: string }) => ({ ...facts, bookmark: { ...facts.bookmark, url } });
  const outcome = (match: unknown, url: { host: string; path: string }) => {
    const compiled = compilePredicate(match);
    if (!compiled.valid) throw new Error(JSON.stringify(compiled.issues));
    return compiled.evaluate(at(url)).outcome;
  };
  const path = (op: string, value: string) => ({ kind: 'field', field: 'bookmark.url.path', op, value });
  expect(outcome(path('startsWith', '/papers/日本'), { host: 'example.org', path: '/papers/日本語/x' })).toBe('matched');
  expect(outcome(path('startsWith', '/a b'), { host: 'example.org', path: '/a b/c' })).toBe('matched');
  expect(outcome(path('eq', '/a/../docs'), { host: 'example.org', path: '/docs' })).toBe('matched');
  expect(outcome(path('contains', '日本'), { host: 'example.org', path: '/papers/日本語' })).toBe('matched');
  expect(outcome(path('contains', '../x'), { host: 'example.org', path: '/a/../x' })).toBe('notMatched');
  expect(outcome({ kind: 'field', field: 'bookmark.url.host', op: 'contains', value: 'ArXiv' }, { host: 'ARXIV.org', path: '/' })).toBe('matched');
  expect(normalizePathText('/a b/日', true)).toBe('/a%20b/%E6%97%A5');
  expect(normalizePathText('a\\b#c', false)).toBe('a/b%23c');
});

test('review: a bookmark without an http URL only misses its URL facts', () => {
  const bookmarklet = { ...facts, bookmark: { ...facts.bookmark, url: { host: '' }, title: 'Bookmarklet' } };
  expect(normalizeEventFacts(bookmarklet).status).toBe('available');
  const evaluate = (match: unknown) => { const compiled = compilePredicate(match); return compiled.valid ? compiled.evaluate(bookmarklet).outcome : 'invalid'; };
  expect(evaluate({ kind: 'field', field: 'bookmark.title', op: 'contains', value: 'Bookmarklet' })).toBe('matched');
  expect(evaluate({ kind: 'field', field: 'bookmark.url.host', op: 'hostSuffix', value: 'arxiv.org' })).toBe('missingInput');
  expect(evaluate({ kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/' })).toBe('missingInput');
  expect(normalizeEventFacts({ ...bookmarklet, bookmark: { ...bookmarklet.bookmark, url: { host: '', path: '/x' } } }).status).toBe('missingInput');
});
