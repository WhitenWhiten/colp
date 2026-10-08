import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { buildPublicationTargetAncestorRestrictionSql } from '../../../src/infrastructure/database/collection-control-sql.js';
import {
  CollectionAuthorizationError,
  createCollectionChildrenCursorSigner,
  listCollectionChildren,
  type CollectionChildrenNodeRow,
  type ListCollectionChildrenPorts,
} from '../../../src/modules/collections/index.js';

const KEY = Buffer.alloc(32, 23).toString('base64url');

function lockedCollection() {
  const now = new Date('2026-10-08T00:00:00.000Z');
  return {
    id: 'public-collection', ownerSubjectId: 'owner', title: 'Public', summary: null,
    kind: 'bookmarks' as const, visibility: 'public' as const, rootNodeId: 'root',
    resourceRevision: '1', contentRevision: '1', policyRevision: '1', commitOrdinal: 1n,
    createdAt: now, updatedAt: now, deletedAt: null,
  };
}

function portsForParent(parent: CollectionChildrenNodeRow | null, calls: Array<unknown>): ListCollectionChildrenPorts {
  return {
    collections: { async lockForShare() { return lockedCollection(); } },
    children: {
      async getLiveNode(_collectionId, _nodeId, options) {
        calls.push(options);
        return options?.publicOnly ? parent : parent;
      },
      async listLiveChildren() { return []; },
    },
    accessPolicy: { async loadCollectionFacts() { return null; } },
    cursorSigner: createCollectionChildrenCursorSigner(KEY),
    clock: { async now() { return new Date('2026-10-08T00:00:00.000Z'); } },
    faviconSources: { async findModesByNodeIds() { return new Map(); } },
    publicControls: { async isCollectionHiddenPublic() { return false; } },
  };
}

describe('public collection children visibility', () => {
  test('ancestor predicate rejects private/protected, deleted, cyclic, deep, and dangling chains', () => {
    const sql = buildPublicationTargetAncestorRestrictionSql('nodes');
    assert.match(sql, /visibility in \('private','protected'\)/u);
    assert.match(sql, /deleted_at is not null/u);
    assert.match(sql, /or cycle/u);
    assert.match(sql, /depth = 256/u);
    assert.match(sql, /target_ancestor_parent/u);
  });

  test('public parent lookup conceals missing or restricted ids without an unrestricted probe', async () => {
    const calls: Array<unknown> = [];
    const ports = portsForParent(null, calls);
    await assert.rejects(
      () => listCollectionChildren(ports, {
        actor: { principalId: null, subjectId: null },
        collectionId: 'public-collection', parentId: 'private-folder',
      }),
      (error: unknown) => error instanceof CollectionAuthorizationError && error.outcome === 'conceal',
    );
    assert.deepEqual(calls, [{ publicOnly: true }]);
  });
});
