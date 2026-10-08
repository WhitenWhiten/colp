import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'vitest';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { Operation } from '@know-n/colp/types';
import { canonicalJson } from '../../../src/modules/commands/index.js';
import {
  SyncNodeCreateError,
  mapSyncNodeCreateOperation,
} from '../../../src/modules/sync/sync-node-create.js';
import {
  syncNodeCreatePushRequest,
  syncPushAdmissionRequest,
} from '../../fixtures/phase3/sync-push-admission.js';

function operation(request = syncNodeCreatePushRequest()): Operation {
  return request.operations[0]!;
}

describe('P3-12 COLP create_node canonical mapping', () => {
  test('maps Folder, Bookmark, and Separator without accepting relational authority', () => {
    const cases = [
      {
        node: { kind: 'folder', title: 'Folder', description: 'nested', tags: ['a'],
          visibility: 'protected', extensions: { 'https://example.test/ext': { deep: [1, 2] } } },
        expected: { kind: 'folder', title: 'Folder', url: null, description: 'nested',
          tags: ['a'], visibility: 'protected' },
      },
      {
        node: { kind: 'bookmark', title: 'Bookmark', url: 'https://example.test/path?q=1',
          description: null, tags: [], visibility: 'inherit', extensions: {} },
        expected: { kind: 'bookmark', title: 'Bookmark', url: 'https://example.test/path?q=1',
          description: null, tags: [], visibility: 'inherit' },
      },
      {
        node: { kind: 'separator', description: null, tags: [], visibility: 'private',
          extensions: { 'https://example.test/separator': { marker: true } } },
        expected: { kind: 'separator', title: null, url: null, description: null,
          tags: [], visibility: 'private' },
      },
    ] as const;

    for (const item of cases) {
      const mapped = mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
        parentId: 'canonical-parent', afterId: 'left', beforeId: 'right', node: item.node,
      })), { managedBookmarkWrites: false });
      assert.equal(mapped.collectionId, 'push-collection-1');
      assert.equal(mapped.operationId, 'push-create-operation-1');
      assert.equal(mapped.parentId, 'canonical-parent');
      assert.deepEqual(mapped.relativePosition, { afterId: 'left', beforeId: 'right' });
      assert.deepEqual(mapped.fields.kindFields, item.expected);
      assert.equal(canonicalJson(mapped.fields.extensions), canonicalJson(item.node.extensions));
      assert.equal(Object.hasOwn(mapped.fields.kindFields, 'id'), false);
      assert.equal(Object.hasOwn(mapped.fields.kindFields, 'collectionId'), false);
      assert.equal(Object.hasOwn(mapped.fields.kindFields, 'parentId'), false);
      assert.equal(Object.hasOwn(mapped.fields.kindFields, 'position'), false);
    }
  });

  test('applies protocol defaults while preserving unknown extension namespaces exactly', () => {
    const extensions = {
      'https://vendor.example/one': { nested: [{ truth: true }, null, 'exact'] },
      'https://vendor.example/two': [0, false, { member: 'value' }],
    };
    const mapped = mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
      node: { kind: 'folder', title: 'Defaults', extensions },
    })), { managedBookmarkWrites: false });
    assert.deepEqual(mapped.fields.kindFields, {
      kind: 'folder', title: 'Defaults', url: null, description: null, tags: [], visibility: 'inherit',
    });
    assert.equal(canonicalJson(mapped.fields.extensions), canonicalJson(extensions));
    assert.notEqual(mapped.fields.extensions, extensions);
  });

  test('keeps legal update/move/delete and non-Node create operations on unsupported_operation', () => {
    for (const candidate of [
      syncPushAdmissionRequest({ type: 'update_node_content' }).operations[0]!,
      syncPushAdmissionRequest({ type: 'delete_node' }).operations[0]!,
      { ...syncPushAdmissionRequest().operations[0]!, type: 'move_node' },
      { ...operation(), type: 'create_annotation' },
      { ...operation(), payload: { ...operation().payload, node: { kind: 'alias', title: 'Alias', targetNodeId: 'target' } } },
    ]) {
      assert.throws(
        () => mapSyncNodeCreateOperation(candidate as Operation, { managedBookmarkWrites: false }),
        (error: unknown) => error instanceof SyncNodeCreateError
          && error.code === 'unsupported_operation',
      );
    }
  });

  test('managed-bookmarks is deployment-gated and never enabled by operation self-report', () => {
    const managed = operation(syncNodeCreatePushRequest({
      node: { kind: 'folder', title: 'Managed', folderRole: 'managed-bookmarks' },
    }));
    assert.throws(
      () => mapSyncNodeCreateOperation(managed, { managedBookmarkWrites: false }),
      (error: unknown) => error instanceof SyncNodeCreateError && error.code === 'node_read_only',
    );
    const enabled = mapSyncNodeCreateOperation(managed, { managedBookmarkWrites: true });
    assert.equal(enabled.folderRole, 'managed-bookmarks');

    const spoofed = { ...operation(), managedBookmarkWrites: true };
    assert.equal(createValidatorRegistry().validate('operation', spoofed).valid, false);
  });

  test('schema rejects closed documents, identity fields, Separator extras, and root folderRole', () => {
    const base = operation();
    const payload = base.payload as { readonly parentId: string; readonly node: Record<string, unknown> };
    for (const forbidden of ['id', 'nativeId', 'owner', 'principalId', 'accountId', 'collectionId', 'position', 'ordinal']) {
      const candidate = { ...base, payload: { ...payload, node: { ...payload.node, [forbidden]: 'attacker' } } };
      assert.equal(createValidatorRegistry().validate('operation', candidate).valid, false, forbidden);
    }
    const rejectedNodes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['unknown node property in a closed document',
        { kind: 'bookmark', title: 'Closed probe', url: 'https://example.test/', unknownProperty: 'probe' }],
      ['separator with title', { kind: 'separator', title: 'not allowed' }],
      ['separator with url', { kind: 'separator', url: 'https://example.test/' }],
      ['folder with root folderRole', { kind: 'folder', title: 'Folder', folderRole: 'root' }],
    ];
    for (const [label, node] of rejectedNodes) {
      const candidate = operation(syncNodeCreatePushRequest({ node: node as never }));
      assert.equal(createValidatorRegistry().validate('operation', candidate).valid, false, label);
    }
  });

  test('mapper rejects every malformed node directly, including schema-admitted values (overlong title, userinfo URL, forbidden folderRole)', () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['bookmark with userinfo URL', { kind: 'bookmark', title: 'userinfo', url: 'https://secret@example.test/' }],
      ['bookmark with empty title', { kind: 'bookmark', title: '', url: 'https://example.test/' }],
      ['folder with overlong title', { kind: 'folder', title: 'x'.repeat(513) }],
      ['separator with title', { kind: 'separator', title: 'not allowed' }],
      ['separator with url', { kind: 'separator', url: 'https://example.test/' }],
      ['folder with root folderRole', { kind: 'folder', title: 'Folder', folderRole: 'root' }],
      ['folder with archive folderRole', { kind: 'folder', title: 'Folder', folderRole: 'archive' }],
      ['folder with inbox folderRole', { kind: 'folder', title: 'Folder', folderRole: 'inbox' }],
    ];
    for (const [label, node] of cases) {
      const candidate = operation(syncNodeCreatePushRequest({ node: node as never }));
      assert.throws(
        () => mapSyncNodeCreateOperation(candidate, { managedBookmarkWrites: false }),
        (error: unknown) => error instanceof SyncNodeCreateError,
        label,
      );
    }
  });

  test('enforces the Bookmark urlHash binding contract on create (same semantics as update)', () => {
    const url = 'https://example.test/hash-me';
    const matchingHash = `sha-256=:${createHash('sha256').update(url).digest('base64')}:`;

    // urlHash matching the preserved url → accepted and carried into canonical fields.
    const mapped = mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
      node: { kind: 'bookmark', title: 'Hashed', url, urlHash: matchingHash },
    })), { managedBookmarkWrites: false });
    assert.equal(mapped.fields.kindFields.urlHash, matchingHash);
    assert.equal(mapped.fields.kindFields.url, url);

    // urlHash absent → allowed (extension never sends it today).
    const bare = mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
      node: { kind: 'bookmark', title: 'Bare', url: 'https://example.test/bare' },
    })), { managedBookmarkWrites: false });
    assert.equal(Object.hasOwn(bare.fields.kindFields, 'urlHash'), false);

    // urlHash that does not match the url → invalid_document, never persisted.
    const mismatched = `sha-256=:${createHash('sha256')
      .update('https://example.test/other').digest('base64')}:`;
    assert.throws(
      () => mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
        node: { kind: 'bookmark', title: 'Bad hash', url, urlHash: mismatched },
      })), { managedBookmarkWrites: false }),
      (error: unknown) => error instanceof SyncNodeCreateError
        && error.code === 'invalid_document',
    );

    // Malformed urlHash (not the sha-256 envelope) → invalid_document.
    assert.throws(
      () => mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
        node: { kind: 'bookmark', title: 'Bad format', url, urlHash: 'not-a-sha256-envelope' },
      })), { managedBookmarkWrites: false }),
      (error: unknown) => error instanceof SyncNodeCreateError
        && error.code === 'invalid_document',
    );

    // urlHash on a non-Bookmark kind → invalid_document (update path is identical).
    assert.throws(
      () => mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
        node: { kind: 'folder', title: 'Folder', urlHash: matchingHash } as never,
      })), { managedBookmarkWrites: false }),
      (error: unknown) => error instanceof SyncNodeCreateError
        && error.code === 'invalid_document',
    );
  });

  test('accepts KNS-00 folderRole allow-list on Folder creates', () => {
    for (const folderRole of ['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks', 'custom', 'recovered'] as const) {
      const mapped = mapSyncNodeCreateOperation(operation(syncNodeCreatePushRequest({
        parentId: 'canonical-root',
        node: { kind: 'folder', title: 'Mount', folderRole },
      })), { managedBookmarkWrites: false });
      assert.equal(mapped.folderRole, folderRole);
      assert.equal(mapped.fields.kindFields.folderRole, folderRole);
    }
  });
});
