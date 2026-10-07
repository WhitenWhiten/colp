import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import {
  evaluateSyncNodeUpdate,
  SyncNodeUpdateError,
  type TrustedSyncNodeRevision,
} from '../../../src/modules/sync/sync-node-update.js';
import { appliedPushResult } from '../../../src/infrastructure/sync/postgres/sync-push-repository-postgres.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

function operation(input: Parameters<typeof syncNodeUpdatePushRequest>[0] = {}): Operation {
  return syncNodeUpdatePushRequest(input).operations[0]!;
}

function revision(input: Partial<TrustedSyncNodeRevision> = {}): TrustedSyncNodeRevision {
  return {
    collectionId: 'update-collection-1',
    resourceId: 'update-node-1',
    revision: 'update-node-r1',
    kind: 'bookmark',
    deleted: false,
    payload: {
      schemaVersion: 1,
      resourceType: 'node',
      id: 'update-node-1',
      collectionId: 'update-collection-1',
      parentId: 'root',
      kind: 'bookmark',
      isRoot: false,
      folderRole: null,
      title: 'Before',
      url: 'https://example.test/before',
      description: null,
      tags: [],
      visibility: 'inherit',
      position: 'M',
      resourceRevision: 'update-node-r1',
      childrenRevision: 'children-r1',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      deletedAt: null,
      deletedCommitOrdinal: null,
      extensions: {},
    },
    ...input,
  };
}

function expectCode(action: () => unknown, code: SyncNodeUpdateError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof SyncNodeUpdateError && error.code === code);
}

describe('P3-13 typed Node update evaluator', () => {
  test('uses the public COLP three-way merge for Base=Current and marks a stale automatic merge rebased', () => {
    const direct = evaluateSyncNodeUpdate(operation({
      base: { title: 'Before', url: 'https://example.test/before' },
      value: { title: 'After', url: 'https://example.test/before' },
    }), revision(), revision());
    assert.equal(direct.status, 'merged');
    assert.equal(direct.resultStatus, 'applied');
    assert.deepEqual(direct.fields.kindFields, { title: 'After', url: 'https://example.test/before' });

    const current = revision({ revision: 'update-node-r2', payload: {
      ...revision().payload, resourceRevision: 'update-node-r2',
      url: 'https://example.test/current',
    } });
    const rebased = evaluateSyncNodeUpdate(operation({
      base: { title: 'Before', url: 'https://example.test/before' },
      value: { title: 'Incoming title', url: 'https://example.test/before' },
    }), revision(), current);
    assert.equal(rebased.status, 'merged');
    assert.equal(rebased.resultStatus, 'rebased');
    assert.deepEqual(rebased.fields.kindFields,
      { title: 'Incoming title', url: 'https://example.test/current' });
    // F011: the merged result must carry the authoritative post-merge field
    // values so the receipt can reflow them into the client's projection.
    assert.deepEqual(JSON.parse(JSON.stringify(rebased.merged)),
      { title: 'Incoming title', url: 'https://example.test/current' });
  });

  test('the applied Push receipt reflows the authoritative merged fields as transform', () => {
    const op = operation({
      base: { title: 'Before' }, value: { title: 'After' },
    });
    const merged = { title: 'After', url: 'https://example.test/current' };
    const { status, result } = appliedPushResult('batch-1', op, 'rebased', 'update-node-1',
      'update-node-r2', 'cursor-2', [], merged);
    assert.equal(status, 'rebased');
    assert.equal(result.results[0]?.status, 'rebased');
    assert.deepEqual(
      (result.results[0] as { readonly transform?: unknown }).transform, merged);
    // Replays without a transform keep the field absent rather than null.
    const plain = appliedPushResult('batch-1', op, 'applied', 'update-node-1',
      'update-node-r2', 'cursor-2');
    assert.equal('transform' in (plain.result.results[0] ?? {}), false);
  });

  test('returns an explicit deferred Conflict plan for divergent fields and unprovable Base', () => {
    const current = revision({ revision: 'update-node-r2', payload: {
      ...revision().payload, resourceRevision: 'update-node-r2', title: 'Server title',
    } });
    const conflicted = evaluateSyncNodeUpdate(operation({
      base: { title: 'Before' }, value: { title: 'Incoming title' },
    }), revision(), current);
    assert.deepEqual(conflicted, {
      status: 'conflict', code: 'sync_conflict_pending', fields: ['title'],
    });

    const unavailable = evaluateSyncNodeUpdate(operation({ baseRevision: 'unknown-r9' }), undefined, current);
    assert.deepEqual(unavailable, {
      status: 'conflict', code: 'sync_base_unavailable', fields: [],
    });
    const forged = evaluateSyncNodeUpdate(operation({ base: { title: 'Forged' }, value: { title: 'After' } }),
      revision(), revision());
    assert.deepEqual(forged, {
      status: 'conflict', code: 'sync_base_untrusted', fields: ['title'],
    });
  });

  test('enforces closed fields for Folder, Bookmark, and Separator', () => {
    const folder = revision({ kind: 'folder', payload: {
      ...revision().payload, kind: 'folder', title: 'Folder', url: null,
    } });
    assert.equal(evaluateSyncNodeUpdate(operation({ base: { title: 'Folder' }, value: { title: 'Renamed' } }),
      folder, folder).status, 'merged');
    expectCode(() => evaluateSyncNodeUpdate(operation({ base: { url: null }, value: { url: 'https://example.test' } }),
      folder, folder), 'invalid_document');

    const separator = revision({ kind: 'separator', payload: {
      ...revision().payload, kind: 'separator',
      title: undefined, url: undefined, folderRole: undefined,
    } });
    assert.equal(evaluateSyncNodeUpdate(operation({ base: { description: null }, value: { description: 'line' } }),
      separator, separator).status, 'merged');
    expectCode(() => evaluateSyncNodeUpdate(operation({ base: { title: null }, value: { title: 'fake' } }),
      separator, separator), 'invalid_document');

    expectCode(() => evaluateSyncNodeUpdate(operation({
      base: { title: 'Before', targetNodeId: null },
      value: { title: 'After', targetNodeId: 'alias-target' },
    }), revision(), revision()), 'unsupported_operation');
    expectCode(() => evaluateSyncNodeUpdate(operation({
      base: { title: 'Before', folderRole: null },
      value: { title: 'After', folderRole: 'managed-bookmarks' },
    }), revision(), revision()), 'invalid_document');
  });

  test('merges unknown extension namespaces intact and enforces aggregate budgets', () => {
    const namespace = 'https://extensions.example/p3-13';
    const base = revision({ payload: {
      ...revision().payload,
      extensions: { [namespace]: { left: { stable: true }, right: 'base' } },
    } });
    const current = revision({ revision: 'update-node-r2', payload: {
      ...base.payload, resourceRevision: 'update-node-r2',
      extensions: { [namespace]: { left: { stable: true }, right: 'server' } },
    } });
    const merged = evaluateSyncNodeUpdate(operation({
      baseRevision: base.revision,
      base: { title: 'Before', extensions: base.payload.extensions as Record<string, unknown> },
      value: { title: 'Incoming', extensions: base.payload.extensions as Record<string, unknown> },
    }), base, current);
    assert.equal(merged.status, 'merged');
    assert.deepEqual(
      JSON.parse(JSON.stringify(merged.fields.extensions)),
      current.payload.extensions,
    );

    expectCode(() => evaluateSyncNodeUpdate(operation({
      base: { extensions: { [namespace]: { deep: { value: 'x' } } } },
      value: { extensions: { [namespace]: { deep: { value: 'x'.repeat(2_000) } } } },
    }), revision({ payload: { ...revision().payload,
      extensions: { [namespace]: { deep: { value: 'x' } } } } }), revision(), {
      maxBytes: 512, maxDepth: 8, maxMembers: 32,
    }), 'payload_too_large');
  });

  test('accepts the bookmark pin only as the exact two-state value on bookmarks', () => {
    const pin = 'https://known.example/extensions/bookmark-pin-v1';
    const pinned = evaluateSyncNodeUpdate(operation({
      base: { extensions: {} }, value: { extensions: { [pin]: { pinned: true } } },
    }), revision(), revision());
    assert.equal(pinned.status, 'merged');
    assert.deepEqual(JSON.parse(JSON.stringify(pinned.fields.extensions)), { [pin]: { pinned: true } });
    for (const value of [{ pinned: false }, { pinned: true, order: 1 }, true, null]) {
      expectCode(() => evaluateSyncNodeUpdate(operation({
        base: { extensions: {} }, value: { extensions: { [pin]: value } },
      }), revision(), revision()), 'invalid_document');
    }
    const folder = { ...revision().payload, kind: 'folder', url: undefined };
    expectCode(() => evaluateSyncNodeUpdate(operation({
      base: { extensions: {} }, value: { extensions: { [pin]: { pinned: true } } },
    }), revision({ kind: 'folder', payload: folder }), revision({ kind: 'folder', payload: folder })), 'invalid_document');
  });

  test('merges extension namespaces one at a time, so a pin lands beside another device\'s change', () => {
    const pin = 'https://known.example/extensions/bookmark-pin-v1';
    const other = 'https://example.test/extensions/other-v1';
    const base = revision({ payload: { ...revision().payload, extensions: { [other]: { value: 1 } } } });
    const current = revision({ revision: 'update-node-r2',
      payload: { ...revision().payload, resourceRevision: 'update-node-r2', extensions: { [other]: { value: 2 } } } });
    const pinned = evaluateSyncNodeUpdate(operation({
      base: { extensions: { [other]: { value: 1 } } }, value: { extensions: { [other]: { value: 1 }, [pin]: { pinned: true } } },
    }), base, current);
    assert.equal(pinned.status, 'merged');
    assert.deepEqual(JSON.parse(JSON.stringify(pinned.fields.extensions)), { [other]: { value: 2 }, [pin]: { pinned: true } });
    assert.equal(pinned.status === 'merged' && pinned.resultStatus, 'rebased');

    // The same namespace changed differently on both sides is still a Conflict.
    const clash = evaluateSyncNodeUpdate(operation({
      base: { extensions: { [other]: { value: 1 } } }, value: { extensions: { [other]: { value: 3 } } },
    }), base, current);
    assert.deepEqual(clash, { status: 'conflict', code: 'sync_conflict_pending', fields: ['extensions'] });
  });

  test('rejects kind mismatch and malformed input while routing deleted Current to Conflict', () => {
    expectCode(() => evaluateSyncNodeUpdate(operation(), revision({ kind: 'folder' }), revision()),
      'invalid_document');
    assert.deepEqual(evaluateSyncNodeUpdate(operation(), revision(), revision({ deleted: true })), {
      status: 'conflict', code: 'sync_conflict_pending', fields: ['deletedAt'],
    });
    expectCode(() => evaluateSyncNodeUpdate(operation({
      base: { url: 'https://example.test/before' }, value: { url: 'javascript:alert(1)' as never },
    }), revision(), revision()), 'invalid_document');
    expectCode(() => evaluateSyncNodeUpdate(operation({
      base: { title: 'Before' }, value: { url: 'https://example.test/other' },
    }), revision(), revision()), 'invalid_document');
  });

  test('validates the merged Bookmark URL and hash as one canonical result', () => {
    const beforeUrl = 'https://example.test/before';
    const beforeHash = `sha-256=:${createHash('sha256').update(beforeUrl).digest('base64')}:`;
    const hashed = revision({ payload: { ...revision().payload, url: beforeUrl, urlHash: beforeHash } });
    expectCode(() => evaluateSyncNodeUpdate(operation({
      base: { url: beforeUrl }, value: { url: 'https://example.test/after' },
    }), hashed, hashed), 'invalid_document');

    const cleared = evaluateSyncNodeUpdate(operation({
      base: { url: beforeUrl, urlHash: beforeHash },
      value: { url: 'https://example.test/after', urlHash: null },
    }), hashed, hashed);
    assert.equal(cleared.status, 'merged');
    assert.deepEqual(cleared.fields.kindFields, {
      url: 'https://example.test/after', urlHash: null,
    });
  });

  test('a normalization-equivalent merged url pins the stored spelling and hash pair', () => {
    const beforeUrl = 'https://example.test/before';
    const beforeHash = `sha-256=:${createHash('sha256').update(beforeUrl).digest('base64')}:`;
    const hashed = revision({ payload: { ...revision().payload, url: beforeUrl, urlHash: beforeHash } });
    const equivalent = 'HTTPS://EXAMPLE.TEST:443/before/#frag';
    const foreignHash = `sha-256=:${createHash('sha256').update(equivalent).digest('base64')}:`;

    // Equivalent spelling carrying its own digest: both pin back to the stored
    // pair so the projection hash stays bound to the persisted raw url.
    const merged = evaluateSyncNodeUpdate(operation({
      base: { url: beforeUrl, urlHash: beforeHash },
      value: { url: equivalent, urlHash: foreignHash },
    }), hashed, hashed);
    assert.equal(merged.status, 'merged');
    assert.deepEqual(merged.fields.kindFields, { url: beforeUrl, urlHash: beforeHash });
    assert.deepEqual(JSON.parse(JSON.stringify(merged.merged)), { url: beforeUrl, urlHash: beforeHash });

    // Equivalent spelling with no hash field keeps the stored hash.
    const noHash = evaluateSyncNodeUpdate(operation({
      base: { url: beforeUrl },
      value: { url: equivalent },
    }), hashed, hashed);
    assert.equal(noHash.status, 'merged');
    assert.deepEqual(noHash.fields.kindFields, { url: beforeUrl });

    // Equivalent spelling on a node with no stored hash drops a foreign digest
    // rather than binding it to a different byte string.
    const bare = revision();
    const pinnedBare = evaluateSyncNodeUpdate(operation({
      base: { url: beforeUrl, urlHash: null },
      value: { url: equivalent, urlHash: foreignHash },
    }), bare, bare);
    assert.equal(pinnedBare.status, 'merged');
    assert.deepEqual(pinnedBare.fields.kindFields, { url: beforeUrl });
  });
});
