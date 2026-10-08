import { describe, expect, test } from 'vitest';
import { classifyParentAncestry, type ParentAncestryRow } from '../../../src/modules/collections/application/ancestry-validation.js';

const valid: ParentAncestryRow[] = [
  { id: 'parent', parentId: 'root', depth: 0, isRoot: false, kind: 'folder', collectionId: 'c', deletedAt: null },
  { id: 'root', parentId: null, depth: 1, isRoot: true, kind: 'folder', collectionId: 'c', deletedAt: null },
];

describe('classifyParentAncestry', () => {
  test('accepts a complete chain that reaches root', () => {
    expect(classifyParentAncestry(valid, 'c', 'node', 'parent', true)).toEqual({ ok: true });
  });
  test('accepts the root node itself as the direct parent', () => {
    const rootRows: ParentAncestryRow[] = [
      { id: 'root', parentId: null, depth: 0, isRoot: true, kind: 'folder', collectionId: 'c', deletedAt: null },
    ];
    expect(classifyParentAncestry(rootRows, 'c', 'node', 'root', true)).toEqual({ ok: true });
  });
  test('rejects moving an ancestor beneath its own descendant as a target cycle', () => {
    // Moving 'parent' beneath 'leaf', where 'leaf' descends from 'parent'.
    const descendantRows: ParentAncestryRow[] = [
      { id: 'leaf', parentId: 'parent', depth: 0, isRoot: false, kind: 'folder', collectionId: 'c', deletedAt: null },
      { id: 'parent', parentId: 'root', depth: 1, isRoot: false, kind: 'folder', collectionId: 'c', deletedAt: null },
      { id: 'root', parentId: null, depth: 2, isRoot: true, kind: 'folder', collectionId: 'c', deletedAt: null },
    ];
    expect(classifyParentAncestry(descendantRows, 'c', 'parent', 'leaf', true)).toEqual({ ok: false, code: 'target' });
    expect(classifyParentAncestry(descendantRows, 'c', 'parent', 'leaf', true)).not.toEqual({ ok: false, code: 'depth' });
  });
  test('accepts complete chains at depths 255 and 256, rejects 257 without root', () => {
    const chain = (depth: number, reachesRoot: boolean): ParentAncestryRow[] =>
      Array.from({ length: depth + 1 }, (_, index) => ({
        id: `node-${index}`,
        parentId: index === depth ? (reachesRoot ? null : `missing-${index}`) : `node-${index + 1}`,
        depth: index,
        isRoot: reachesRoot && index === depth,
        kind: 'folder',
        collectionId: 'c',
        deletedAt: null,
      }));
    expect(classifyParentAncestry(chain(255, true), 'c', 'moved', 'node-0', true)).toEqual({ ok: true });
    expect(classifyParentAncestry(chain(256, true), 'c', 'moved', 'node-0', true)).toEqual({ ok: true });
    expect(classifyParentAncestry(chain(256, false), 'c', 'moved', 'node-0', true)).toMatchObject({ code: 'depth' });
  });

  test('rejects target in ancestry and duplicate ids', () => {
    expect(classifyParentAncestry([{ ...valid[0], id: 'node' }], 'c', 'node', 'parent', true)).toMatchObject({ code: 'target' });
    expect(classifyParentAncestry([valid[0], valid[0]], 'c', 'node', 'parent', true)).toMatchObject({ code: 'cycle' });
  });
  test('rejects exactly one invalid ancestor field', () => {
    expect(classifyParentAncestry([{ ...valid[0], deletedAt: new Date() }, valid[1]], 'c', 'node', 'parent', true)).toMatchObject({ code: 'invalid' });
    expect(classifyParentAncestry([{ ...valid[0], kind: 'bookmark' }, valid[1]], 'c', 'node', 'parent', true)).toMatchObject({ code: 'invalid' });
    expect(classifyParentAncestry([{ ...valid[0], collectionId: 'other' }, valid[1]], 'c', 'node', 'parent', true)).toMatchObject({ code: 'invalid' });
  });
  test('create validation does not require walking to root', () => {
    expect(classifyParentAncestry([valid[0]], 'c', 'new', 'parent', false)).toEqual({ ok: true });
  });
});
