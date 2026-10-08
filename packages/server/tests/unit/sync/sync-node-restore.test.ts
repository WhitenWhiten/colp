/**
 * Owner: KNS-08 (QA). Fixture: see Known-Extension/e2e/kns-08-ids.ts.
 * Run: see Known-Extension/e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import { evaluateSyncNodeRestore, SyncNodeRestoreError } from '../../../src/modules/sync/sync-node-restore.js';

function restore(overrides: Record<string, unknown> = {}): Operation {
  return {
    opId: 'op-restore-1', replicaId: 'replica-1', sequence: 2, type: 'restore_node',
    collectionId: 'collection-1', targetId: 'node-1', baseRevision: 'delete-r1',
    occurredAt: '2026-07-27T02:00:00Z', payload: {}, ...overrides,
  } as Operation;
}

describe('KNS-06 restore_node mapper', () => {
  test('maps a closed single-target restore and ignores client placement', () => {
    const mapped = evaluateSyncNodeRestore(restore({
      payload: { newParentId: 'folder-x', afterId: 'a', beforeId: 'b', reason: 'restore' },
    }));
    assert.deepEqual(mapped, {
      collectionId: 'collection-1', targetId: 'node-1', expectedDeleteRevision: 'delete-r1',
    });
  });

  test('rejects unknown payload keys and missing identity', () => {
    assert.throws(() => evaluateSyncNodeRestore(restore({ payload: { nativeId: 'chrome' } })),
      (error: unknown) => error instanceof SyncNodeRestoreError && error.code === 'invalid_document');
    assert.throws(() => evaluateSyncNodeRestore(restore({ targetId: '' })),
      (error: unknown) => error instanceof SyncNodeRestoreError && error.code === 'invalid_document');
  });

  test('rejects non-restore operations', () => {
    assert.throws(() => evaluateSyncNodeRestore(restore({ type: 'delete_node' })),
      (error: unknown) => error instanceof SyncNodeRestoreError && error.code === 'unsupported_operation');
  });
});
