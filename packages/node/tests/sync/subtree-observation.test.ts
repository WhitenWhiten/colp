import { describe, expect, test } from 'vitest';
import { subtreeDeleteSource } from '../../src/sync/subtree-observation.js';
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
