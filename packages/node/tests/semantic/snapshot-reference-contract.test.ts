import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assembleSnapshotPages,
  validateSnapshotSemantics,
} from '../../src/semantic/index.js';
import type { SnapshotSemanticContext } from '../../src/semantic/index.js';
import type { Attachment, Snapshot, StrictNode } from '../../src/types/index.js';

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

function folder(snapshot: Snapshot, id: string, parentId: string, position = 'A0'): StrictNode {
  return {
    ...nodeBase(snapshot, id),
    kind: 'folder',
    parentId,
    position,
    title: id,
  };
}

function alias(
  snapshot: Snapshot,
  id: string,
  parentId: string,
  targetNodeId: string,
  position = 'B0',
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

function annotation(snapshot: Snapshot, subject: { type: 'collection' | 'node'; id: string }) {
  return {
    id: 'annotation-reference',
    collectionId: snapshot.collection.id,
    subject,
    type: 'summary' as const,
    format: 'plain' as const,
    value: 'Reference contract',
    visibility: 'private' as const,
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    extensions: {},
  };
}

function attachment(
  snapshot: Snapshot,
  subject: { type: 'collection' | 'node'; id: string },
): Attachment {
  return {
    id: 'attachment-reference',
    collectionId: snapshot.collection.id,
    subject,
    rel: 'snapshot',
    url: 'https://example.com/snapshot.mhtml' as Attachment['url'],
    visibility: 'private' as const,
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    extensions: {},
  };
}

function relation(snapshot: Snapshot, fromNodeId: string, toNodeId: string) {
  return {
    id: 'relation-reference',
    collectionId: snapshot.collection.id,
    type: 'related' as const,
    fromNodeId,
    toNodeId,
    visibility: 'private' as const,
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: snapshot.revision,
    extensions: {},
  };
}

function resolverContext(
  resolveNode: (nodeId: string) => StrictNode | undefined,
): SnapshotSemanticContext {
  const context = {
    referenceResolution: { mode: 'collection', resolveNode },
  } satisfies SnapshotSemanticContext;
  return context;
}

const deferredContext = {
  referenceResolution: { mode: 'deferred' },
} satisfies SnapshotSemanticContext;

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

describe('Snapshot reference resolution contract [evidence:semantic.snapshot.references]', () => {
  it('accepts valid local Parent, Alias, Subject, Relation, and Provenance references', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const target = snapshot.nodes.find((node) => node.kind === 'bookmark');
    if (target === undefined) throw new Error('fixture must contain a bookmark');
    snapshot.nodes.push(
      folder(snapshot, 'local-folder', root.id, 'C0'),
      alias(snapshot, 'local-alias', root.id, target.id, 'D0'),
    );
    snapshot.annotations = [
      {
        ...annotation(snapshot, { type: 'node', id: target.id }),
        provenance: { kind: 'derived', sourceNodeIds: [root.id, target.id] },
      },
      { ...annotation(snapshot, { type: 'collection', id: snapshot.collection.id }), id: 'annotation-collection' },
    ];
    snapshot.attachments = [
      attachment(snapshot, { type: 'node', id: target.id }),
      { ...attachment(snapshot, { type: 'collection', id: snapshot.collection.id }), id: 'attachment-collection' },
    ];
    snapshot.relations = [relation(snapshot, root.id, target.id)];

    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('reports a missing Parent at its field', async () => {
    const snapshot = await completeSnapshot();
    snapshot.nodes.push(folder(snapshot, 'orphan', 'missing-parent'));

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'missing_parent', '/nodes/2/parentId');
  });

  it('reports a missing Alias target at its field', async () => {
    const snapshot = await completeSnapshot();
    snapshot.nodes.push(alias(snapshot, 'dangling-alias', rootOf(snapshot).id, 'missing-target'));

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'missing_alias_target',
      '/nodes/2/targetNodeId',
    );
  });

  it.each([
    ['annotations', annotation] as const,
    ['attachments', attachment] as const,
  ])('reports a missing node Subject for %s at subject.id', async (resourceType, makeResource) => {
    const snapshot = await completeSnapshot();
    snapshot[resourceType] = [makeResource(snapshot, { type: 'node', id: 'missing-subject' })] as never;

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'missing_subject',
      `/${resourceType}/0/subject/id`,
    );
  });

  it.each([
    ['annotations', annotation] as const,
    ['attachments', attachment] as const,
  ])('rejects a foreign collection Subject for %s at subject.id', async (resourceType, makeResource) => {
    const snapshot = await completeSnapshot();
    snapshot[resourceType] = [makeResource(snapshot, { type: 'collection', id: 'other-collection' })] as never;

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'missing_subject',
      `/${resourceType}/0/subject/id`,
    );
  });

  it.each([
    ['fromNodeId', 'missing-from'] as const,
    ['toNodeId', 'missing-to'] as const,
  ])('reports a missing Relation %s independently at its field', async (field, missingId) => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const endpoint = snapshot.nodes[1]?.id;
    if (endpoint === undefined) throw new Error('fixture must contain a relation endpoint');
    snapshot.relations = [
      relation(
        snapshot,
        field === 'fromNodeId' ? missingId : root.id,
        field === 'toNodeId' ? missingId : endpoint,
      ),
    ];

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'missing_relation_endpoint',
      `/relations/0/${field}`,
    );
  });

  it.each([0, 1])('reports missing Annotation Provenance sourceNodeIds[%i] independently', async (sourceIndex) => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    const source = snapshot.nodes[1]?.id;
    if (source === undefined) throw new Error('fixture must contain a provenance source');
    const sourceNodeIds = [root.id, source];
    sourceNodeIds[sourceIndex] = `missing-source-${sourceIndex}`;
    snapshot.annotations = [
      {
        ...annotation(snapshot, { type: 'node', id: source }),
        provenance: { kind: 'derived', sourceNodeIds },
      },
    ];

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'missing_provenance_source',
      `/annotations/0/provenance/sourceNodeIds/${sourceIndex}`,
    );
  });

  it.each(['cropped', 'individual-page'] as const)(
    'defers unresolved references only with explicit page deferral for a %s Snapshot',
    async (boundary) => {
      const snapshot = await completeSnapshot();
      snapshot.nodes = [
        folder(snapshot, 'partial-folder', 'outside-parent'),
        alias(snapshot, 'partial-alias', 'outside-parent', 'outside-alias-target'),
      ];
      snapshot.annotations = [
        {
          ...annotation(snapshot, { type: 'node', id: 'outside-subject' }),
          provenance: { kind: 'derived', sourceNodeIds: ['outside-provenance-source'] },
        },
      ];
      snapshot.attachments = [attachment(snapshot, { type: 'node', id: 'outside-subject' })];
      snapshot.relations = [relation(snapshot, 'outside-from', 'outside-to')];
      if (boundary === 'cropped') snapshot.complete = false;
      else snapshot.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };

      expect(validateSnapshotSemantics(snapshot, deferredContext)).toEqual({ valid: true, issues: [] });
    },
  );

  it('does not silently accept an unresolved cropped reference', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.nodes = [folder(snapshot, 'cropped-child', 'missing-cropped-parent')];

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'missing_parent', '/nodes/0/parentId');
  });

  it('does not silently defer unresolved references after cropped page assembly', async () => {
    const first = await completeSnapshot();
    first.complete = false;
    first.nodes = [folder(first, 'cropped-child', 'missing-cropped-parent')];
    first.annotations = [];
    first.attachments = [];
    first.relations = [];
    first.tombstones = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(first);
    second.nodes = [];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expectOnlyIssue(assembleSnapshotPages([first, second]), 'missing_parent', '/nodes/0/parentId');
    expect(assembleSnapshotPages([first, second], deferredContext).valid).toBe(true);
  });

  it('accepts references resolved to same-Collection resources', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.nodes = [folder(snapshot, 'resolved-child', 'resolved-parent')];
    snapshot.annotations = [
      {
        ...annotation(snapshot, { type: 'node', id: 'resolved-subject' }),
        provenance: { kind: 'derived', sourceNodeIds: ['resolved-source'] },
      },
    ];
    snapshot.attachments = [attachment(snapshot, { type: 'node', id: 'resolved-subject' })];
    snapshot.relations = [relation(snapshot, 'resolved-from', 'resolved-to')];
    const root = rootOf(await completeSnapshot());
    const resolved = (id: string): StrictNode => folder(snapshot, id, root.id);
    const references = new Map<string, StrictNode>([
      ['resolved-parent', resolved('resolved-parent')],
      ['resolved-subject', resolved('resolved-subject')],
      ['resolved-source', resolved('resolved-source')],
      ['resolved-from', resolved('resolved-from')],
      ['resolved-to', resolved('resolved-to')],
      [root.id, root],
    ]);

    expect(
      validateSnapshotSemantics(
        snapshot,
        resolverContext((nodeId) => references.get(nodeId)),
      ),
    ).toEqual({ valid: true, issues: [] });
  });

  it('rejects an explicitly unresolved reference', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.annotations = [annotation(snapshot, { type: 'node', id: 'confirmed-missing' })];

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot, resolverContext(() => undefined)),
      'missing_subject',
      '/annotations/0/subject/id',
    );
  });

  it('rejects a resolver result from another Collection', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    snapshot.complete = false;
    snapshot.nodes = [folder(snapshot, 'external-child', 'external-parent')];

    expectOnlyIssue(
      validateSnapshotSemantics(
        snapshot,
        resolverContext((nodeId) => ({
          ...folder(snapshot, nodeId, root.id),
          collectionId: 'other-collection',
        })),
      ),
      'cross_collection_reference',
      '/nodes/0/parentId',
    );
  });

  it('rejects a non-structural Parent returned by the resolver', async () => {
    const snapshot = await completeSnapshot();
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark');
    if (bookmark === undefined) throw new Error('fixture must contain a bookmark');
    snapshot.complete = false;
    snapshot.nodes = [folder(snapshot, 'resolved-child', 'resolved-bookmark')];

    expectOnlyIssue(
      validateSnapshotSemantics(
        snapshot,
        resolverContext((nodeId) => ({
          ...bookmark,
          id: nodeId,
        })),
      ),
      'invalid_parent_kind',
      '/nodes/0/parentId',
    );
  });

  it('rejects resolver identity spoofing at the referencing field', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    snapshot.complete = false;
    snapshot.nodes = [folder(snapshot, 'external-child', 'requested-parent')];

    expectOnlyIssue(
      validateSnapshotSemantics(
        snapshot,
        resolverContext(() => folder(snapshot, 'spoofed-parent', root.id)),
      ),
      'invalid_reference_resolution',
      '/nodes/0/parentId',
    );
  });

  it('turns resolver exceptions into deterministic field-level issues', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.annotations = [annotation(snapshot, { type: 'node', id: 'resolver-failure' })];

    const result = validateSnapshotSemantics(
      snapshot,
      resolverContext(() => { throw new Error('postgres://user:secret@db/internal/path'); }),
    );
    expectOnlyIssue(
      result,
      'reference_resolver_error',
      '/annotations/0/subject/id',
    );
    if (!result.valid) {
      expect(result.issues[0]?.message).toBe('Reference resolver failed for resolver-failure.');
      expect(result.issues[0]?.message).not.toContain('secret');
      expect(result.issues[0]?.message).not.toContain('internal/path');
    }
  });

  it('rejects a resolver value with an invalid node kind', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.relations = [relation(snapshot, rootOf(snapshot).id, 'invalid-kind')];
    const invalid = { ...folder(snapshot, 'invalid-kind', rootOf(snapshot).id), kind: 'collection' };

    expectOnlyIssue(
      validateSnapshotSemantics(
        snapshot,
        resolverContext(() => invalid as unknown as StrictNode),
      ),
      'invalid_reference_resolution',
      '/relations/0/toNodeId',
    );
  });

  it('uses resolved external ancestry when enforcing Subject visibility', async () => {
    const snapshot = await completeSnapshot();
    const root = rootOf(snapshot);
    snapshot.complete = false;
    snapshot.nodes = [];
    snapshot.annotations = [
      { ...annotation(snapshot, { type: 'node', id: 'external-subject' }), visibility: 'protected' },
    ];
    const privateParent = {
      ...folder(snapshot, 'external-parent', root.id),
      visibility: 'private' as const,
    } as StrictNode;
    const externalSubject = {
      ...folder(snapshot, 'external-subject', privateParent.id),
      visibility: 'inherit' as const,
    } as StrictNode;
    const references = new Map<string, StrictNode>([
      [root.id, root],
      [privateParent.id, privateParent],
      [externalSubject.id, externalSubject],
    ]);

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot, resolverContext((nodeId) => references.get(nodeId))),
      'visibility_widened',
      '/annotations/0/visibility',
    );
  });

  it('rejects a missing ancestor in resolved Subject visibility', async () => {
    const snapshot = await completeSnapshot();
    snapshot.complete = false;
    snapshot.nodes = [];
    snapshot.annotations = [annotation(snapshot, { type: 'node', id: 'external-subject' })];
    const externalSubject = folder(snapshot, 'external-subject', 'missing-external-parent');

    expectOnlyIssue(
      validateSnapshotSemantics(
        snapshot,
        resolverContext((nodeId) => nodeId === externalSubject.id ? externalSubject : undefined),
      ),
      'missing_visibility_ancestor',
      '/annotations/0/subject/id',
    );
  });

  it('resolves references across pages after assembly', async () => {
    const complete = await completeSnapshot();
    const root = rootOf(complete);
    const target = complete.nodes[1];
    if (target === undefined) throw new Error('fixture must contain a cross-page target');
    const first = structuredClone(complete);
    first.nodes = [root];
    first.annotations = [
      {
        ...annotation(first, { type: 'node', id: target.id }),
        provenance: { kind: 'derived', sourceNodeIds: [target.id] },
      },
    ];
    first.attachments = [attachment(first, { type: 'node', id: target.id })];
    first.relations = [relation(first, root.id, target.id)];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = [target];
    second.annotations = [];
    second.attachments = [];
    second.relations = [];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expect(validateSnapshotSemantics(first, deferredContext)).toEqual({ valid: true, issues: [] });
    expect(validateSnapshotSemantics(second, deferredContext)).toEqual({ valid: true, issues: [] });
    const assembled = assembleSnapshotPages([first, second]);
    expect(assembled.valid).toBe(true);
    if (assembled.valid) {
      expect(assembled.snapshot.nodes.map((node) => node.id)).toEqual([root.id, target.id]);
    }
  });
});
