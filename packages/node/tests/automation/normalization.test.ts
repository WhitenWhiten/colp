import { describe, test, expect } from 'vitest';
import facts from '../fixtures/automation/event-facts.json' with { type: 'json' };
import { normalizeUrl, normalizeHost, normalizeEventFacts, taskInputDigest, automationDigest } from '../../src/automation/index.js';

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
