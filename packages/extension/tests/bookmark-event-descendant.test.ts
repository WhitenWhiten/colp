import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isDescendant, isDescendantIn, nativeParentIndex } from '../src/bookmark-event-codec.js';
import { subtreeSelector } from '../src/bookmark-event-eligibility.js';
import type { MappingInput } from '../src/sync-state-store.js';

function row(nativeId: string, parentNativeId?: string): MappingInput {
  return {
    nativeId, colpId: `colp-${nativeId}`, rootNativeId: 'root',
    ...(parentNativeId === undefined ? {} : { parentNativeId }),
    projection: { revision: 'r1', digest: 'sha256:x' },
  };
}

test('a child is a descendant, a sibling is not, and a cycle is not', () => {
  const root = row('root');
  const child = row('child', 'root');
  const sibling = row('sibling', 'root');
  const leaf = row('leaf', 'child');
  const orphan = row('orphan', 'missing');
  const all = [root, child, sibling, leaf, orphan];
  const parents = nativeParentIndex(all);
  const expectSame = (candidate: MappingInput, ancestor: string, expected: boolean) => {
    assert.equal(isDescendant(candidate, ancestor, all), expected);
    assert.equal(isDescendantIn(candidate, ancestor, parents), expected);
  };
  expectSame(child, 'root', true);
  expectSame(leaf, 'root', true);
  expectSame(sibling, 'child', false);
  expectSame(child, 'child', false);
  expectSame(root, 'root', false);
  expectSame(orphan, 'root', false);
  const loopA = row('a', 'b');
  const loopB = row('b', 'a');
  const loop = [loopA, loopB];
  assert.equal(isDescendant(loopA, 'root', loop), false);
  assert.equal(isDescendantIn(loopA, 'root', nativeParentIndex(loop)), false);
  assert.equal(isDescendant(loopA, 'b', loop), true);
  const underChild = subtreeSelector('child');
  assert.equal(underChild(leaf, all), true);
  assert.equal(underChild(sibling, all), false);
  assert.equal(subtreeSelector('root')(loopA, loop), false);
});

test('subtree selection keeps the first parent index when all is replaced', () => {
  const root = row('root');
  const child = row('child', 'root');
  const leaf = row('leaf', 'child');
  const mid = row('mid', 'other');
  const otherLeaf = row('other-leaf', 'mid');
  const sibling = row('sibling', 'root');
  const select = subtreeSelector('root');
  const first = [root, child, leaf, mid, otherLeaf, sibling];
  assert.equal(select(child, first), true);
  assert.equal(select(sibling, first), true);
  assert.equal(select(leaf, first), true);
  assert.equal(select(otherLeaf, first), false);
  const replaced = [
    root, row('child', 'elsewhere'), leaf, row('mid', 'root'), otherLeaf, sibling,
  ];
  assert.equal(select(leaf, replaced), true);
  assert.equal(select(otherLeaf, replaced), false);
  assert.equal(isDescendant(leaf, 'root', replaced), false);
  assert.equal(isDescendant(otherLeaf, 'root', replaced), true);
});
