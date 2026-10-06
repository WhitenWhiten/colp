import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Attachment, Relation, Snapshot, SyncTombstone } from '../../src/types/index.js';

const deferredContext = { referenceResolution: { mode: 'deferred' as const } };

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: 'collection-snapshot.json' | 'sync-snapshot.json'): Promise<Snapshot> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as Snapshot;
}

function tombstone(snapshot: Snapshot, targetId: string): SyncTombstone {
  return {
    resourceType: 'node',
    targetId,
    collectionId: snapshot.collection.id,
    scope: 'single',
    deletedAt: snapshot.generatedAt,
    deleteRevision: 'delete-revision-1',
    operationId: 'delete-operation-1',
    deleteCursor: 'delete-cursor-1',
    affectedCount: 1,
    purgeAfter: snapshot.generatedAt,
  };
}

function addAllLiveResourceTypes(snapshot: Snapshot): void {
  const subjectId = snapshot.nodes[1]?.id;
  if (subjectId === undefined) throw new Error('fixture must contain a subject node');
  snapshot.annotations.push({
    id: 'annotation-identity-1',
    collectionId: snapshot.collection.id,
    subject: { type: 'node', id: subjectId },
    type: 'note',
    value: 'Identity test annotation',
    visibility: 'private',
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: 'annotation-revision-1',
  });
  snapshot.attachments.push({
    id: 'attachment-identity-1',
    collectionId: snapshot.collection.id,
    subject: { type: 'node', id: subjectId },
    rel: 'alternate',
    url: 'https://example.com/attachment' as Attachment['url'],
    visibility: 'private',
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: 'attachment-revision-1',
  });
  snapshot.relations.push({
    id: 'relation-identity-1',
    collectionId: snapshot.collection.id,
    type: 'related',
    fromNodeId: snapshot.nodes[0]?.id ?? subjectId,
    toNodeId: subjectId,
    visibility: 'private',
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    revision: 'relation-revision-1',
  });
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

describe('Snapshot identity contract', () => {
  it('accepts distinct live and Tombstone target IDs [evidence:semantic.snapshot.identity]', async () => {
    const snapshot = await fixture('sync-snapshot.json');
    snapshot.tombstones.push(tombstone(snapshot, 'deleted-node-1'));

    const liveIds = [
      snapshot.collection.id,
      ...snapshot.nodes.map((resource) => resource.id),
      ...snapshot.annotations.map((resource) => resource.id),
      ...snapshot.attachments.map((resource) => resource.id),
      ...snapshot.relations.map((resource) => resource.id),
    ];

    expect(new Set(liveIds).size).toBe(liveIds.length);
    expect(liveIds).not.toContain(snapshot.tombstones[0]?.targetId);
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('rejects duplicate live IDs within one resource type [evidence:semantic.snapshot.identity]', async () => {
    const snapshot = await fixture('collection-snapshot.json');
    const annotation = snapshot.annotations[0];
    if (annotation === undefined) throw new Error('fixture must contain an annotation');
    snapshot.annotations.push(structuredClone(annotation));

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'duplicate_live_id', '/annotations/1/id');
  });

  it.each([
    ['node', '/nodes/2/id'],
    ['annotation', '/annotations/1/id'],
    ['attachment', '/attachments/1/id'],
    ['relation', '/relations/1/id'],
  ] as const)(
    'rejects same-type duplicate %s IDs [evidence:semantic.snapshot.identity]',
    async (resourceType, expectedPath) => {
      const snapshot = await fixture('sync-snapshot.json');
      addAllLiveResourceTypes(snapshot);

      if (resourceType === 'node') {
        const original = snapshot.nodes[1];
        if (original === undefined || original.kind === 'root') throw new Error('fixture must contain a child node');
        snapshot.nodes.push({ ...structuredClone(original), position: 'B0' });
      } else {
        const resources = snapshot[`${resourceType}s`];
        resources.push(structuredClone(resources[0] as never) as never);
      }

      expectOnlyIssue(validateSnapshotSemantics(snapshot), 'duplicate_live_id', expectedPath);
    },
  );

  it('rejects a Collection ID reused by another live resource type [evidence:semantic.snapshot.identity]', async () => {
    const snapshot = await fixture('collection-snapshot.json');
    const annotation = snapshot.annotations[0];
    if (annotation === undefined) throw new Error('fixture must contain an annotation');
    (annotation as { id: string }).id = snapshot.collection.id;

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'duplicate_live_id', '/annotations/0/id');
  });

  it.each([
    ['node', '/nodes/1/id'],
    ['annotation', '/annotations/0/id'],
    ['attachment', '/attachments/0/id'],
    ['relation', '/relations/0/id'],
  ] as const)(
    'rejects the Collection ID reused by a %s [evidence:semantic.snapshot.identity]',
    async (resourceType, expectedPath) => {
      const snapshot = await fixture('sync-snapshot.json');
      addAllLiveResourceTypes(snapshot);
      const resource =
        resourceType === 'node'
          ? snapshot.nodes[1]
          : snapshot[`${resourceType}s`][0] as Attachment | Relation | Snapshot['annotations'][number];
      if (resource === undefined) throw new Error(`fixture must contain a ${resourceType}`);
      (resource as { id: string }).id = snapshot.collection.id;
      if (resourceType === 'node') {
        snapshot.annotations[0]!.subject.id = resource.id;
        snapshot.attachments[0]!.subject.id = resource.id;
        snapshot.relations[0]!.toNodeId = resource.id;
      }

      expectOnlyIssue(validateSnapshotSemantics(snapshot), 'duplicate_live_id', expectedPath);
    },
  );

  it('rejects a live ID overlapping a Tombstone target [evidence:semantic.snapshot.identity]', async () => {
    const snapshot = await fixture('sync-snapshot.json');
    const liveNode = snapshot.nodes[1];
    if (liveNode === undefined) throw new Error('fixture must contain a live node');
    snapshot.tombstones.push(tombstone(snapshot, liveNode.id));

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'live_tombstone_overlap',
      '/tombstones/0/targetId',
    );
  });

  it('rejects a repeated Tombstone target at its second occurrence [evidence:semantic.snapshot.identity]', async () => {
    const snapshot = await fixture('sync-snapshot.json');
    const deleted = tombstone(snapshot, 'deleted-node-1');
    snapshot.tombstones.push(deleted, {
      ...structuredClone(deleted),
      deleteRevision: 'delete-revision-2',
      operationId: 'delete-operation-2',
      deleteCursor: 'delete-cursor-2',
    });

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot),
      'duplicate_tombstone',
      '/tombstones/1/targetId',
    );
  });

  it('enforces live identity uniqueness in a cropped Snapshot [evidence:semantic.snapshot.identity]', async () => {
    const snapshot = await fixture('sync-snapshot.json');
    const root = snapshot.nodes.find((node) => node.kind === 'root');
    if (root === undefined) throw new Error('fixture must contain a root node');
    snapshot.complete = false;
    (root as { id: string }).id = snapshot.collection.id;

    expectOnlyIssue(
      validateSnapshotSemantics(snapshot, deferredContext),
      'duplicate_live_id',
      '/nodes/0/id',
    );
  });

  it('enforces live identity uniqueness on an individual Snapshot page [evidence:semantic.snapshot.identity]', async () => {
    const snapshot = await fixture('collection-snapshot.json');
    const annotation = snapshot.annotations[0];
    if (annotation === undefined) throw new Error('fixture must contain an annotation');
    snapshot.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    (annotation as { id: string }).id = snapshot.collection.id;

    expectOnlyIssue(validateSnapshotSemantics(snapshot), 'duplicate_live_id', '/annotations/0/id');
  });

  it('rejects a live ID duplicated across resource types on separate pages [evidence:semantic.snapshot.identity]', async () => {
    const complete = await fixture('collection-snapshot.json');
    const root = complete.nodes.find((node) => node.kind === 'root');
    const bookmark = complete.nodes.find((node) => node.kind !== 'root');
    const annotation = complete.annotations[0];
    if (root === undefined || bookmark === undefined || annotation === undefined) {
      throw new Error('fixture must contain a root, non-root node, and annotation');
    }

    const first = structuredClone(complete);
    first.nodes = [root];
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };

    const second = structuredClone(complete);
    second.nodes = [bookmark];
    second.annotations = [{ ...annotation, id: root.id }];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expect(validateSnapshotSemantics(first, deferredContext)).toEqual({ valid: true, issues: [] });
    expect(validateSnapshotSemantics(second, deferredContext)).toEqual({ valid: true, issues: [] });
    expectOnlyIssue(
      assembleSnapshotPages([first, second]),
      'duplicate_snapshot_page_id',
      '/pages/1/annotations/0/id',
    );
  });

  it.each(['live-first', 'tombstone-first'] as const)(
    'rejects cross-page live/Tombstone overlap with %s ordering [evidence:semantic.snapshot.identity]',
    async (ordering) => {
      const complete = await fixture('sync-snapshot.json');
      const root = complete.nodes[0];
      const child = complete.nodes[1];
      if (root === undefined || child === undefined) throw new Error('fixture must contain two nodes');

      const first = structuredClone(complete);
      const second = structuredClone(complete);
      first.nodes = ordering === 'live-first' ? [root, child] : [root];
      first.tombstones = ordering === 'tombstone-first' ? [tombstone(first, child.id)] : [];
      first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
      second.nodes = ordering === 'live-first' ? [] : [child];
      second.tombstones = ordering === 'live-first' ? [tombstone(second, child.id)] : [];
      second.page = { nextCursor: null, hasMore: false, sequence: 2 };

      expectOnlyIssue(
        assembleSnapshotPages([first, second]),
        'live_tombstone_overlap',
        ordering === 'live-first'
          ? '/pages/1/tombstones/0/targetId'
          : '/pages/1/nodes/0/id',
      );
    },
  );

  it('reports a repeated Tombstone target on its second page occurrence [evidence:semantic.snapshot.identity]', async () => {
    const complete = await fixture('sync-snapshot.json');
    const root = complete.nodes[0];
    const child = complete.nodes[1];
    if (root === undefined || child === undefined) throw new Error('fixture must contain two nodes');

    const first = structuredClone(complete);
    first.nodes = [root];
    first.tombstones = [tombstone(first, 'deleted-node-1')];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = [child];
    second.tombstones = [tombstone(second, 'deleted-node-1')];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    expectOnlyIssue(
      assembleSnapshotPages([first, second]),
      'duplicate_tombstone',
      '/pages/1/tombstones/0/targetId',
    );
  });
});
