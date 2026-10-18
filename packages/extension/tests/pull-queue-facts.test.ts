import assert from 'node:assert/strict';
import { test } from 'vitest';
import { pendingLocalContentFields } from '../src/pull-queue-facts.js';
import { scope } from './kns-05-pull-harness.js';

test('a local content draft beyond one page of native history still protects its changed fields', async () => {
  const after: number[] = [];
  const fields = await pendingLocalContentFields({
    listQueueByTarget: async () => [], pullOperationsCovered: async () => [],
    listBookmarkEventsByNative: async (_scope, _nativeId, ordinal) => {
      after.push(ordinal ?? 0);
      if (!ordinal) return Array.from({ length: 1_000 }, (_, i) => ({ ordinal: i + 1, status: 'processed' })) as never;
      return [{ ordinal: 1_001, status: 'pending', details: { mapping: { colpId: 'node-1' },
        draft: { type: 'update_node_content', targetId: 'pending-old', payload: {
          base: { title: 'Old' }, value: { title: 'Saved locally' } } } } }] as never;
    },
  }, scope, { colpId: 'node-1', nativeId: 'native-node' });
  assert.deepEqual(fields, { title: 'Saved locally' });
  assert.deepEqual(after, [0, 1_000]);
});
