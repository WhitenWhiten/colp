import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot, StrictNode } from '../../src/types/index.js';

const deferredContext = { referenceResolution: { mode: 'deferred' as const } };

const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'sync-snapshot.json',
);

async function completeSnapshot(): Promise<Snapshot> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Snapshot;
}

function rootOf(snapshot: Snapshot): Extract<StrictNode, { kind: 'root' }> {
  const root = snapshot.nodes.find((node) => node.kind === 'root');
  if (root === undefined) throw new Error('fixture must contain a root node');
  return root;
}

function nodeBase(snapshot: Snapshot, id: string) {
  return {
    id,
    collectionId: snapshot.collection.id,
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    extensions: {},
  };
}

function folder(snapshot: Snapshot, id: string, parentId: string, position: string): StrictNode {
  return {
    ...nodeBase(snapshot, id),
    kind: 'folder',
    parentId,
    position,
    title: id,
  };
}

function bookmark(snapshot: Snapshot, id: string, parentId: string, position: string): StrictNode {
  return {
    ...nodeBase(snapshot, id),
    kind: 'bookmark',
    parentId,
    position,
    title: id,
    url: `https://example.com/${id}`,
  };
}

function separator(snapshot: Snapshot, id: string, parentId: string, position: string): StrictNode {
  return {
    ...nodeBase(snapshot, id),
    kind: 'separator',
    parentId,
    position,
  };
}

function alias(
  snapshot: Snapshot,
  id: string,
  parentId: string,
  position: string,
  targetNodeId: string,
): StrictNode {
  return {
    ...nodeBase(snapshot, id),
    kind: 'alias',
    parentId,
    position,
    title: id,
    targetNodeId,
  };
}

function expectOnlyIssue(
  result: { readonly valid: boolean; readonly issues: readonly { code: string; path: string }[] },
  code: string,
  path: string,
): void {
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => ({ code: issue.code, path: issue.path }))).toEqual([
    { code, path },
  ]);
}

describe('Snapshot parent and alias graph contract', () => {
  it('accepts a nested structural parent chain and an acyclic alias chain [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const firstFolder = folder(snapshot, 'folder-a', root.id, 'A0');
    const secondFolder = folder(snapshot, 'folder-b', firstFolder.id, 'A0');
    const target = bookmark(snapshot, 'bookmark-a', secondFolder.id, 'A0');
    const firstAlias = alias(snapshot, 'alias-a', secondFolder.id, 'B0', target.id);
    const secondAlias = alias(snapshot, 'alias-b', firstFolder.id, 'B0', firstAlias.id);
    snapshot.nodes = [root, firstFolder, secondFolder, target, firstAlias, secondAlias];

    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it.each(['bookmark', 'separator', 'alias'] as const)(
    'rejects a %s as a non-structural parent [evidence:semantic.snapshot.graph]',
    async (parentKind) => {
      const snapshot = await completeSnapshot();
      const root = rootOf(snapshot);
      const parent =
        parentKind === 'bookmark'
          ? bookmark(snapshot, 'non-structural-parent', root.id, 'A0')
          : parentKind === 'separator'
            ? separator(snapshot, 'non-structural-parent', root.id, 'A0')
            : alias(snapshot, 'non-structural-parent', root.id, 'A0', root.id);
      const child = folder(snapshot, 'child-folder', parent.id, 'A0');
      snapshot.nodes = [root, parent, child];

      expectOnlyIssue(
        validateSnapshotSemantics(snapshot),
        'invalid_parent_kind',
        '/nodes/2/parentId',
      );
    },
  );

  it('rejects a Parent self-cycle [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const cyclic = folder(snapshot, 'folder-self', 'folder-self', 'A0');
    snapshot.nodes = [root, cyclic];

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'parent_cycle', '/nodes/1/parentId');
  });

  it('rejects a multi-node Parent cycle [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const first = folder(snapshot, 'folder-a', 'folder-b', 'A0');
    const second = folder(snapshot, 'folder-b', 'folder-a', 'A0');
    snapshot.nodes = [root, first, second];

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'parent_cycle', '/nodes/2/parentId');
  });

  it('rejects an Alias self-cycle [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const cyclic = alias(snapshot, 'alias-self', root.id, 'A0', 'alias-self');
    snapshot.nodes = [root, cyclic];

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'alias_cycle', '/nodes/1/targetNodeId');
  });

  it('rejects a multi-node Alias cycle [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const first = alias(snapshot, 'alias-a', root.id, 'A0', 'alias-b');
    const second = alias(snapshot, 'alias-b', root.id, 'B0', 'alias-a');
    snapshot.nodes = [root, first, second];

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'alias_cycle', '/nodes/2/targetNodeId');
  });

  it('validates a deep Parent graph without recursive stack exhaustion [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const depth = 12_000;
    const folders: StrictNode[] = [];
    let parentId = root.id;
    for (let index = 0; index < depth; index += 1) {
      const node = folder(snapshot, `deep-folder-${index}`, parentId, 'A0');
      folders.push(node);
      parentId = node.id;
    }
    snapshot.nodes = [root, ...folders];

    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('validates a deep Alias graph without recursive stack exhaustion [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const target = bookmark(snapshot, 'deep-alias-target', root.id, 'target');
    const depth = 12_000;
    const aliases: StrictNode[] = [];
    for (let index = 0; index < depth; index += 1) {
      const targetNodeId = index === depth - 1 ? target.id : `deep-alias-${index + 1}`;
      aliases.push(alias(snapshot, `deep-alias-${index}`, root.id, `alias-${index}`, targetNodeId));
    }
    snapshot.nodes = [root, target, ...aliases];

    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('defers unresolved Parent and Alias references in a cropped Snapshot [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.nodes = [
      folder(snapshot, 'cropped-folder', 'parent-outside-crop', 'A0'),
      alias(snapshot, 'cropped-alias', 'parent-outside-crop', 'B0', 'target-outside-crop'),
    ];

    expect(validateSnapshotSemantics(snapshot, deferredContext)).toEqual({ valid: true, issues: [] });
  });

  it('detects a Parent cycle through collection-resolved nodes', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.nodes = [folder(snapshot, 'local-folder', 'external-folder', 'A0')];
    const external = folder(snapshot, 'external-folder', 'local-folder', 'A0');

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot, {
        referenceResolution: {
          mode: 'collection',
          resolveNode: (nodeId) => nodeId === external.id ? external : undefined,
        },
      }),
      'parent_cycle',
      '/nodes/0/parentId',
    );
  });

  it('detects an Alias cycle through collection-resolved nodes', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    snapshot.complete = false;
    snapshot.nodes = [root, alias(snapshot, 'local-alias', root.id, 'A0', 'external-alias')];
    const external = alias(snapshot, 'external-alias', root.id, 'A0', 'local-alias');

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot, {
        referenceResolution: {
          mode: 'collection',
          resolveNode: (nodeId) => nodeId === external.id ? external : undefined,
        },
      }),
      'alias_cycle',
      '/nodes/1/targetNodeId',
    );
  });

  it.each([
    ['Parent', 'missing'] as const,
    ['Parent', 'foreign'] as const,
    ['Parent', 'malformed'] as const,
    ['Alias', 'missing'] as const,
    ['Alias', 'foreign'] as const,
    ['Alias', 'malformed'] as const,
  ])('fails closed on a %s chain with a %s transitive resolution', async (graph, failure) => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    snapshot.complete = false;
    snapshot.nodes = graph === 'Parent'
      ? [folder(snapshot, 'local-folder', 'external-first', 'A0')]
      : [root, alias(snapshot, 'local-alias', root.id, 'A0', 'external-first')];
    const first = graph === 'Parent'
      ? folder(snapshot, 'external-first', 'external-failure', 'A0')
      : alias(snapshot, 'external-first', root.id, 'A0', 'external-failure');
    const malformed = graph === 'Parent'
      ? { ...folder(snapshot, 'external-failure', root.id, 'A0'), parentId: undefined }
      : { ...alias(snapshot, 'external-failure', root.id, 'A0', root.id), targetNodeId: undefined };
    const foreign = {
      ...(graph === 'Parent'
        ? folder(snapshot, 'external-failure', root.id, 'A0')
        : alias(snapshot, 'external-failure', root.id, 'A0', root.id)),
      collectionId: 'foreign-collection',
    };
    const result = validateSnapshotSemantics(snapshot, {
      referenceResolution: {
        mode: 'collection',
        resolveNode: (nodeId) => nodeId === first.id
          ? first
          : failure === 'missing'
            ? undefined
            : failure === 'foreign'
              ? foreign
              : malformed as unknown as StrictNode,
      },
    });
    const expectedCode = failure === 'missing'
      ? graph === 'Parent' ? 'missing_parent' : 'missing_alias_target'
      : failure === 'foreign'
        ? 'cross_collection_reference'
        : 'invalid_reference_resolution';
    const expectedPath = graph === 'Parent' ? '/nodes/0/parentId' : '/nodes/1/targetNodeId';
    expectOnlyIssue(result, expectedCode, expectedPath);
  });

  it.each(['Parent', 'Alias'] as const)(
    'bounds a collection-resolved %s chain',
    async (graph) => {
      const snapshot = await completeSnapshot();
      const root = rootOf(snapshot);
      snapshot.complete = false;
      snapshot.nodes = graph === 'Parent'
        ? [folder(snapshot, 'local-folder', 'external-0', 'A0')]
        : [root, alias(snapshot, 'local-alias', root.id, 'A0', 'external-0')];
      const result = validateSnapshotSemantics(snapshot, {
        referenceResolution: {
          mode: 'collection',
          resolveNode: (nodeId) => {
            const index = Number(nodeId.slice('external-'.length));
            return graph === 'Parent'
              ? folder(snapshot, nodeId, `external-${index + 1}`, 'A0')
              : alias(snapshot, nodeId, root.id, 'A0', `external-${index + 1}`);
          },
        },
      });

      expectOnlyIssue(
        result,
        'reference_resolution_limit',
        graph === 'Parent' ? '/nodes/0/parentId' : '/nodes/1/targetNodeId',
      );
    },
    20_000,
  );

  it('defers unresolved Parent and Alias references on an individual page [evidence:semantic.snapshot.graph]', async () => {
    const snapshot = await completeSnapshot();
    snapshot.nodes = [
      folder(snapshot, 'page-folder', 'parent-on-another-page', 'A0'),
      alias(snapshot, 'page-alias', 'parent-on-another-page', 'B0', 'target-on-another-page'),
    ];
    snapshot.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };

    expect(validateSnapshotSemantics(snapshot, deferredContext)).toEqual({ valid: true, issues: [] });
  });

  it('detects a cross-page Parent cycle after completed assembly [evidence:semantic.snapshot.graph]', async () => {
    const complete = await completeSnapshot();
    const root = rootOf(complete);
    const first = structuredClone(complete);
    first.nodes = [root, folder(first, 'folder-a', 'folder-b', 'A0')];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = [folder(second, 'folder-b', 'folder-a', 'A0')];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expect(validateSnapshotSemantics(first, deferredContext)).toEqual({ valid: true, issues: [] });
    expect(validateSnapshotSemantics(second, deferredContext)).toEqual({ valid: true, issues: [] });
    expectOnlyIssue(assembleSnapshotPages([first, second]), 'parent_cycle', '/nodes/2/parentId');
  });

  it('detects a cross-page Alias cycle after completed assembly [evidence:semantic.snapshot.graph]', async () => {
    const complete = await completeSnapshot();
    const root = rootOf(complete);
    const first = structuredClone(complete);
    first.nodes = [root, alias(first, 'alias-a', root.id, 'A0', 'alias-b')];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = [alias(second, 'alias-b', root.id, 'B0', 'alias-a')];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expect(validateSnapshotSemantics(first, deferredContext)).toEqual({ valid: true, issues: [] });
    expect(validateSnapshotSemantics(second, deferredContext)).toEqual({ valid: true, issues: [] });
    expectOnlyIssue(
      assembleSnapshotPages([first, second]),
      'alias_cycle',
      '/nodes/2/targetNodeId',
    );
  });

  it('detects a cross-page non-structural parent after completed assembly [evidence:semantic.snapshot.graph]', async () => {
    const complete = await completeSnapshot();
    const root = rootOf(complete);
    const first = structuredClone(complete);
    const nonStructuralParent = bookmark(first, 'bookmark-parent', root.id, 'A0');
    first.nodes = [root, nonStructuralParent];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = [folder(second, 'folder-child', nonStructuralParent.id, 'A0')];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expect(validateSnapshotSemantics(first, deferredContext)).toEqual({ valid: true, issues: [] });
    expect(validateSnapshotSemantics(second, deferredContext)).toEqual({ valid: true, issues: [] });
    expectOnlyIssue(
      assembleSnapshotPages([first, second]),
      'invalid_parent_kind',
      '/nodes/2/parentId',
    );
  });
});
