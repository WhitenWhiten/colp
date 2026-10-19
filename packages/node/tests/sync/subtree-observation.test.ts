import { describe, expect, test } from 'vitest';
import { subtreeDeleteSource, subtreeMemberIdsDigest, subtreeObservationSummary } from '../../src/sync/subtree-observation.js';
import { canonicalOperationDigest } from '../../src/sync/canonical.js';

describe('subtree deletion observation', () => {
  test('order independent, membership and descendant content sensitive', () => {
    const root = { id: 'root', revision: 'r1' }; const child = { id: 'child', revision: 'r2' };
    const original = subtreeDeleteSource('root', [root, child]);
    expect(original).toEqual(subtreeDeleteSource('root', [child, root]));
    expect(original).not.toEqual(subtreeDeleteSource('root', [root]));
    expect(original).not.toEqual(subtreeDeleteSource('root', [root, { ...child, revision: 'r3' }]));
    expect(() => subtreeDeleteSource('root', [root, root])).toThrow();
    expect(() => subtreeDeleteSource('root', [child])).toThrow();
  });
  test('streaming encoding matches canonical JSON and supports a large subtree', () => {
    const source = subtreeDeleteSource('root', [{ id: 'root', revision: 'r1' }]);
    expect(Object.values(source.extensions)[0]!.digest).toBe(canonicalOperationDigest({ rootId: 'root', members: [['root', 'r1']] }));
    const members = Array.from({ length: 10_000 }, (_, i) => ({ id: `n${i}`, revision: `r${i}` }));
    expect(Object.values(subtreeDeleteSource('n0', members).extensions)[0]!.count).toBe(10_000);
  });
});

describe('subtree observation summary', () => {
  test('member-id digest ignores revisions and reports both digests of the current members', () => {
    const members = [{ id: 'root', revision: 'r1' }, { id: 'child', revision: 'r2' }];
    const summary = subtreeObservationSummary('root', members);
    expect(summary.version).toBe(1);
    expect(summary.count).toBe(2);
    expect(summary.digest).toBe(Object.values(subtreeDeleteSource('root', members).extensions)[0]!.digest);
    expect(summary.memberIdsDigest).toBe(subtreeMemberIdsDigest('root', ['child', 'root']));
    expect(summary.memberIdsDigest).toBe(subtreeObservationSummary('root',
      [{ id: 'child', revision: 'r9' }, { id: 'root', revision: 'r8' }]).memberIdsDigest);
    expect(summary.memberIdsDigest).not.toBe(subtreeMemberIdsDigest('root', ['root']));
    expect(summary.memberIdsDigest).not.toBe(summary.digest);
    expect(summary.memberIdsDigest).toBe(canonicalOperationDigest({ rootId: 'root', members: [['child'], ['root']] }));
    expect(() => subtreeMemberIdsDigest('root', ['child'])).toThrow();
    expect(() => subtreeMemberIdsDigest('root', ['root', 'root'])).toThrow();
  });
});
