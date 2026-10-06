import { describe, expect, it } from 'vitest';

import * as packageBoundary from '../../src/semantic/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  assembleSnapshotPages,
  validateSnapshotSemantics,
} from '../../src/semantic/index.js';
import type { Snapshot, StrictNode } from '../../src/types/index.js';

const evidence = '[evidence:core.snapshot-derived-index]';
const maximumIndex = Number.MAX_SAFE_INTEGER;

type IndexedNode = StrictNode & { readonly index?: number | null };
type IndexedSnapshot = Omit<Snapshot, 'nodes'> & { readonly nodes: readonly IndexedNode[] };
type DeriveSnapshotIndexes = (snapshot: Snapshot) => IndexedSnapshot;
type WithoutSnapshotIndexes = (snapshot: Snapshot) => Snapshot;
type DerivedIndexApi = {
  readonly deriveSnapshotIndexes?: DeriveSnapshotIndexes;
  readonly withoutSnapshotIndexes?: WithoutSnapshotIndexes;
};

const deriveSnapshotIndexes = (packageBoundary as DerivedIndexApi).deriveSnapshotIndexes;
const withoutSnapshotIndexes = (packageBoundary as DerivedIndexApi).withoutSnapshotIndexes;
const validators = createValidatorRegistry();

function snapshot(): Snapshot {
  const generatedAt = '2026-07-17T05:00:00Z';
  const collectionId = 'collection-indexes';
  const rootId = 'root-indexes';
  return {
    protocolVersion: '0.1',
    snapshotId: 'snapshot-indexes',
    mode: 'sync',
    complete: true,
    collection: {
      schemaVersion: '0.1',
      id: collectionId,
      kind: 'bookmarks',
      title: 'Index contract',
      rootNodeId: rootId,
      visibility: 'private',
      publication: {
        feedMode: 'disabled',
        includeNodeContent: 'metadata',
        includeRelations: false,
      },
      createdAt: generatedAt,
      updatedAt: generatedAt,
      revision: 'revision-indexes',
    },
    nodes: [
      {
        id: rootId,
        collectionId,
        kind: 'root',
        parentId: null,
        position: null,
        folderRole: 'root',
        title: 'Root',
        createdAt: generatedAt,
        updatedAt: generatedAt,
        revision: 'node-root-revision',
      },
    ],
    annotations: [],
    attachments: [],
    relations: [],
    tombstones: [],
    revision: 'revision-indexes',
    syncCursor: 'cursor-indexes',
    generatedAt,
    page: { nextCursor: null, hasMore: false, sequence: 1 },
    warnings: [],
  };
}

function folder(source: Snapshot, id: string, parentId: string, position: string): StrictNode {
  return {
    id,
    collectionId: source.collection.id,
    kind: 'folder',
    parentId,
    position,
    title: id,
    createdAt: source.generatedAt,
    updatedAt: source.generatedAt,
    revision: `revision-${id}`,
  };
}

function bookmark(source: Snapshot, id: string, parentId: string, position: string): StrictNode {
  return {
    id,
    collectionId: source.collection.id,
    kind: 'bookmark',
    parentId,
    position,
    title: id,
    url: `https://example.com/${id}`,
    createdAt: source.generatedAt,
    updatedAt: source.generatedAt,
    revision: `revision-${id}`,
  };
}

function withIndex(node: StrictNode, index: unknown): StrictNode {
  return { ...node, index } as unknown as StrictNode;
}

function indexById(value: IndexedSnapshot): Record<string, number | null | undefined> {
  return Object.fromEntries(value.nodes.map((node) => [node.id, node.index]));
}

describe(`CORE-0027 optional Snapshot-derived sibling indexes ${evidence}`, () => {
  it('exports derivation and authoritative-state stripping APIs', () => {
    expect(deriveSnapshotIndexes).toBeTypeOf('function');
    expect(withoutSnapshotIndexes).toBeTypeOf('function');
  });

  it('keeps a Snapshot with every index omitted structurally and semantically valid', () => {
    const value = snapshot();
    value.nodes.push(bookmark(value, 'bookmark-a', value.collection.rootNodeId, 'A'));

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(value)).toEqual({ valid: true, issues: [] });
    expect(value.nodes.every((node) => !Object.hasOwn(node, 'index'))).toBe(true);
  });

  it.each([0, 1, maximumIndex])('accepts optional non-root integer index %s on the wire', (index) => {
    const value = snapshot();
    value.nodes.push(withIndex(bookmark(value, 'bookmark-a', value.collection.rootNodeId, 'A'), index));

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
  });

  it('allows the root to omit index', () => {
    const value = snapshot();

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
    expect(value.nodes[0]).not.toHaveProperty('index');
  });

  it('allows a provided root index to be null rather than inventing a sibling ordinal', () => {
    const value = snapshot();
    value.nodes[0] = withIndex(value.nodes[0]!, null);

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(value)).toEqual({ valid: true, issues: [] });
  });

  it.each([
    ['negative integer', -1],
    ['fraction', 1.5],
    ['unsafe integer', maximumIndex + 1],
    ['numeric string', '0'],
    ['boolean', false],
    ['null non-root index', null],
    ['array', [0]],
    ['object', { value: 0 }],
  ])('rejects %s as a non-root wire index', (_label, index) => {
    const value = snapshot();
    value.nodes.push(withIndex(bookmark(value, 'bookmark-a', value.collection.rootNodeId, 'A'), index));

    expect(validators.validate('snapshot', value).valid).toBe(false);
  });

  it.each([0, -1, '0', false])('rejects root index %j instead of treating the root as a sibling', (index) => {
    const value = snapshot();
    value.nodes[0] = withIndex(value.nodes[0]!, index);

    expect(validators.validate('snapshot', value).valid).toBe(false);
  });

  it('accepts stale, duplicated, and gapped indexes in a Sync Snapshot', () => {
    const value = snapshot();
    const rootId = value.collection.rootNodeId;
    value.nodes.push(
      withIndex(bookmark(value, 'bookmark-a', rootId, 'A'), 40),
      withIndex(bookmark(value, 'bookmark-b', rootId, 'B'), 40),
      withIndex(bookmark(value, 'bookmark-c', rootId, 'C'), 900),
    );

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(value)).toEqual({ valid: true, issues: [] });
  });

  it('accepts mixed index presence in one sibling set', () => {
    const value = snapshot();
    const rootId = value.collection.rootNodeId;
    value.nodes.push(
      withIndex(bookmark(value, 'bookmark-a', rootId, 'A'), 0),
      bookmark(value, 'bookmark-b', rootId, 'B'),
      withIndex(bookmark(value, 'bookmark-c', rootId, 'C'), 2),
    );

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(value)).toEqual({ valid: true, issues: [] });
  });

  it('keeps authoritative Node and closed Snapshot shapes free of unrelated properties', () => {
    const value = snapshot();
    const indexed = withIndex(bookmark(value, 'bookmark-a', value.collection.rootNodeId, 'A'), 0);

    expect(validators.validate('node', indexed).valid).toBe(false);
    expect(validators.validate('snapshot', { ...value, unrelated: true }).valid).toBe(false);
  });

  it('strips every received index before authoritative state without mutating the Snapshot', () => {
    const value = snapshot();
    value.nodes[0] = withIndex(value.nodes[0]!, null);
    value.nodes.push(withIndex(bookmark(value, 'bookmark-a', value.collection.rootNodeId, 'A'), 99));
    const before = structuredClone(value);

    const stripped = (withoutSnapshotIndexes as WithoutSnapshotIndexes)(value);

    expect(value).toEqual(before);
    expect(stripped).not.toBe(value);
    expect(stripped.nodes).not.toBe(value.nodes);
    expect(stripped.nodes.every((node) => !Object.hasOwn(node, 'index'))).toBe(true);
    expect(validators.validate('node', stripped.nodes[1]).valid).toBe(true);
  });

  it('does not let tampered indexes override canonical Position validity', () => {
    const value = snapshot();
    const rootId = value.collection.rootNodeId;
    value.nodes.push(
      withIndex(bookmark(value, 'position-a', rootId, 'A'), 2),
      withIndex(bookmark(value, 'position-b', rootId, 'B'), 1),
      withIndex(bookmark(value, 'position-c', rootId, 'C'), 0),
    );

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(value)).toEqual({ valid: true, issues: [] });
  });

  it('regresses concurrent insertion without requiring old sibling indexes to shift atomically', () => {
    const value = snapshot();
    const rootId = value.collection.rootNodeId;
    value.nodes.push(
      withIndex(bookmark(value, 'existing-a', rootId, 'A'), 0),
      bookmark(value, 'concurrent-b', rootId, 'B'),
      withIndex(bookmark(value, 'existing-c', rootId, 'C'), 1),
    );

    expect(validators.validate('snapshot', value)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(value)).toEqual({ valid: true, issues: [] });
  });

  it('assembles pages despite page-local, stale, or omitted indexes', () => {
    const complete = snapshot();
    const root = complete.nodes[0]!;
    const rootId = complete.collection.rootNodeId;
    const first = structuredClone(complete);
    first.nodes = [root, withIndex(bookmark(first, 'position-a', rootId, 'A'), 0)];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = [
      withIndex(bookmark(second, 'position-b', rootId, 'B'), 0),
      bookmark(second, 'position-c', rootId, 'C'),
    ];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const result = assembleSnapshotPages([first, second]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.snapshot.nodes.map((node) => node.id)).toEqual([
        rootId,
        'position-a',
        'position-b',
        'position-c',
      ]);
      expect(result.snapshot.nodes.map((node) => (node as IndexedNode).index)).toEqual([
        undefined,
        0,
        0,
        undefined,
      ]);
    }
  });

  describe('optional public derivation API', () => {
    function derive(value: Snapshot): IndexedSnapshot {
      return (deriveSnapshotIndexes as DeriveSnapshotIndexes)(value);
    }

    it('derives zero-based indexes by unsigned ASCII Position order, not input array order', () => {
      const value = snapshot();
      const rootId = value.collection.rootNodeId;
      value.nodes.push(
        bookmark(value, 'lowercase', rootId, 'a'),
        bookmark(value, 'hyphen', rootId, '-'),
        bookmark(value, 'uppercase', rootId, 'A'),
      );

      expect(indexById(derive(value))).toMatchObject({
        [rootId]: null,
        hyphen: 0,
        uppercase: 1,
        lowercase: 2,
      });
    });

    it('resets indexes independently for every parent', () => {
      const value = snapshot();
      const rootId = value.collection.rootNodeId;
      const folderA = folder(value, 'folder-a', rootId, 'A');
      const folderB = folder(value, 'folder-b', rootId, 'B');
      value.nodes.push(
        folderB,
        bookmark(value, 'child-b-2', folderB.id, 'Z'),
        folderA,
        bookmark(value, 'child-a-1', folderA.id, 'A'),
        bookmark(value, 'child-b-1', folderB.id, 'A'),
        bookmark(value, 'child-a-2', folderA.id, 'Z'),
      );

      expect(indexById(derive(value))).toMatchObject({
        [rootId]: null,
        'folder-a': 0,
        'folder-b': 1,
        'child-a-1': 0,
        'child-a-2': 1,
        'child-b-1': 0,
        'child-b-2': 1,
      });
    });

    it('numbers only represented siblings in a sparse single-page projection', () => {
      const value = snapshot();
      value.complete = false;
      const rootId = value.collection.rootNodeId;
      value.nodes.push(
        bookmark(value, 'represented-z', rootId, 'Z'),
        bookmark(value, 'represented-a', rootId, 'A'),
      );

      expect(indexById(derive(value))).toMatchObject({
        'represented-a': 0,
        'represented-z': 1,
      });
    });

    it.each([
      ['first page', { nextCursor: 'page-2', hasMore: true, sequence: 1 }],
      ['later page', { nextCursor: null, hasMore: false, sequence: 2 }],
    ] as const)('refuses derivation on an unassembled %s', (_label, page) => {
      const value = snapshot();
      value.page = page;

      expect(() => derive(value)).toThrow(/logical page assembly/u);
    });

    it('rejects duplicate sibling Positions rather than inventing a tie-breaker', () => {
      const value = snapshot();
      const rootId = value.collection.rootNodeId;
      value.nodes.push(
        bookmark(value, 'duplicate-a', rootId, 'A'),
        bookmark(value, 'duplicate-b', rootId, 'A'),
      );

      expect(() => derive(value)).toThrow(/duplicate Position A/u);
    });

    it('recomputes stale indexes after a concurrent insertion from Position alone', () => {
      const value = snapshot();
      const rootId = value.collection.rootNodeId;
      value.nodes.push(
        withIndex(bookmark(value, 'existing-a', rootId, 'A'), 0),
        bookmark(value, 'concurrent-b', rootId, 'B'),
        withIndex(bookmark(value, 'existing-c', rootId, 'C'), 1),
      );

      expect(indexById(derive(value))).toMatchObject({
        'existing-a': 0,
        'concurrent-b': 1,
        'existing-c': 2,
      });
    });

    it('overwrites tampered, duplicate, and gapped indexes instead of using them as authority', () => {
      const value = snapshot();
      const rootId = value.collection.rootNodeId;
      value.nodes.push(
        withIndex(bookmark(value, 'position-c', rootId, 'C'), 0),
        withIndex(bookmark(value, 'position-a', rootId, 'A'), 40),
        withIndex(bookmark(value, 'position-b', rootId, 'B'), 40),
      );

      expect(indexById(derive(value))).toMatchObject({
        'position-a': 0,
        'position-b': 1,
        'position-c': 2,
      });
    });

    it('is deterministic and does not mutate the Snapshot or its Nodes', () => {
      const value = snapshot();
      const rootId = value.collection.rootNodeId;
      value.nodes.push(
        withIndex(bookmark(value, 'position-b', rootId, 'B'), 99),
        bookmark(value, 'position-a', rootId, 'A'),
      );
      const before = structuredClone(value);

      const first = derive(value);
      const second = derive(value);

      expect(value).toEqual(before);
      expect(first).toEqual(second);
      expect(first).not.toBe(value);
      expect(first.nodes).not.toBe(value.nodes);
      expect(first.nodes.every((node, index) => node !== value.nodes[index])).toBe(true);
    });
  });
});
