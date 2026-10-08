import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { decodeTrashDeletionId, encodeTrashDeletionId } from '../../../src/modules/sync/product-sync-trash.js';

describe('KNS-06 trash deletionId encoding', () => {
  test('round-trips operation and target identities', () => {
    const deletionId = encodeTrashDeletionId('op-delete-1', 'node-1');
    assert.deepEqual(decodeTrashDeletionId(deletionId), { operationId: 'op-delete-1', targetId: 'node-1' });
  });

  test('rejects truncated, padded, or extra-null encodings', () => {
    assert.equal(decodeTrashDeletionId(''), null);
    assert.equal(decodeTrashDeletionId('%%%%'), null);
    assert.equal(decodeTrashDeletionId(encodeTrashDeletionId('op', 'node') + 'x'), null);
  });
});
