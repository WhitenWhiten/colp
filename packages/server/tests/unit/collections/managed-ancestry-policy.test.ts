import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  assertManagedAncestryWritable,
  ManagedAncestryPolicyError,
  managedAncestryNodeFact,
  type ManagedAncestryNodeFact,
} from '../../../src/infrastructure/sync/managed-ancestry-policy.js';

function fact(input: Partial<ManagedAncestryNodeFact> = {}): ManagedAncestryNodeFact {
  return {
    id: 'node-1',
    parentId: 'root',
    isRoot: false,
    deleted: false,
    kind: 'bookmark',
    folderRole: null,
    ...input,
  };
}

function row(input: { readonly folderRole?: unknown } = {}) {
  return {
    id: 'node-1', parent_id: 'root', is_root: false, kind: 'bookmark' as const,
    deleted_at: null, payload_json: input.folderRole === undefined ? null : { folderRole: input.folderRole },
  };
}

function expectReadOnly(action: () => unknown, label: string): void {
  assert.throws(action, (error: unknown) => error instanceof ManagedAncestryPolicyError
    && error.code === 'node_read_only', label);
}

describe('SYNC-R02 managed ancestry policy guard', () => {
  test('allows ordinary chains under every capability combination', () => {
    const chain = [
      fact({ id: 'target', parentId: 'folder-1' }),
      fact({ id: 'folder-1', parentId: 'root', kind: 'folder' }),
      fact({ id: 'root', parentId: null, isRoot: true, kind: 'folder' }),
    ];
    for (const managedBookmarkWrites of [false, true]) {
      for (const replicaWrite of [false, true]) {
        assert.doesNotThrow(() => assertManagedAncestryWritable(chain, { managedBookmarkWrites, replicaWrite }));
      }
    }
  });

  test('rejects the managed folder itself unless both capabilities allow', () => {
    const chain = [
      fact({ id: 'managed', parentId: 'root', kind: 'folder', folderRole: 'managed-bookmarks' }),
      fact({ id: 'root', parentId: null, isRoot: true, kind: 'folder' }),
    ];
    expectReadOnly(() => assertManagedAncestryWritable(chain,
      { managedBookmarkWrites: false, replicaWrite: true }), 'deployment capability off');
    expectReadOnly(() => assertManagedAncestryWritable(chain,
      { managedBookmarkWrites: true, replicaWrite: false }), 'replica write capability off');
    assert.doesNotThrow(() => assertManagedAncestryWritable(chain,
      { managedBookmarkWrites: true, replicaWrite: true }));
  });

  test('rejects direct children and deep descendants of a managed folder', () => {
    const chains: ReadonlyArray<readonly [string, readonly ManagedAncestryNodeFact[]]> = [
      ['direct child', [
        fact({ id: 'child', parentId: 'managed', kind: 'bookmark' }),
        fact({ id: 'managed', parentId: 'root', kind: 'folder', folderRole: 'managed-bookmarks' }),
        fact({ id: 'root', parentId: null, isRoot: true, kind: 'folder' }),
      ]],
      ['deep descendant', [
        fact({ id: 'deep', parentId: 'nested', kind: 'bookmark' }),
        fact({ id: 'nested', parentId: 'managed', kind: 'folder' }),
        fact({ id: 'managed', parentId: 'root', kind: 'folder', folderRole: 'managed-bookmarks' }),
        fact({ id: 'root', parentId: null, isRoot: true, kind: 'folder' }),
      ]],
    ];
    for (const [label, chain] of chains) {
      expectReadOnly(() => assertManagedAncestryWritable(chain,
        { managedBookmarkWrites: false, replicaWrite: true }), label);
      assert.doesNotThrow(() => assertManagedAncestryWritable(chain,
        { managedBookmarkWrites: true, replicaWrite: true }), label);
    }
  });

  test('converts locked Node rows into ancestry facts with exact folderRole extraction', () => {
    assert.deepEqual(managedAncestryNodeFact(row()), {
      id: 'node-1', parentId: 'root', isRoot: false, deleted: false, kind: 'bookmark', folderRole: null,
    });
    assert.deepEqual(managedAncestryNodeFact(row({ folderRole: 'managed-bookmarks' })).folderRole,
      'managed-bookmarks');
    assert.deepEqual(managedAncestryNodeFact(row({ folderRole: 'something-else' })).folderRole, null);
    assert.deepEqual(managedAncestryNodeFact(row({ folderRole: null })).folderRole, null);
    assert.equal(managedAncestryNodeFact({
      ...row(), deleted_at: new Date('2026-07-26T00:00:00.000Z'),
    }).deleted, true);
    assert.equal(managedAncestryNodeFact({
      ...row(), is_root: true, parent_id: null,
    }).isRoot, true);
  });
});
