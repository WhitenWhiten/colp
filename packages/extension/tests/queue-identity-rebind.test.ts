import assert from 'node:assert/strict';
import type { JsonObject } from '../src/sync-state-store.js';
import { test } from 'vitest';
import { rebindOperationIdentity } from '../src/queue-identity-rebind.js';

for (const type of ['create_node', 'move_node', 'restore_node', 'reorder_children']) test(`${type} rebinds only schema identity paths`, () => {
  const content = { title: 'old', description: 'old', tags: ['old'], extensions: { 'https://example.test/': { parentId: 'old' } } };
  const identityFields: JsonObject = type === 'create_node' ? { parentId: 'old', afterId: 'old', beforeId: 'old' }
    : type === 'move_node' ? { newParentId: 'old', afterId: 'old', beforeId: 'old', baseSourceParentRevision: 'old', baseTargetParentRevision: 'old' }
      : type === 'restore_node' ? { newParentId: 'old', afterId: 'old', beforeId: 'old' }
        : { parentId: 'old', baseChildrenRevision: 'old', childIds: ['old'] };
  const operation = { type, opId: 'own-id', targetId: 'old', baseRevision: 'old', dependencies: ['old'],
    payload: { ...identityFields, node: content, base: content, value: content, reason: 'old' } };
  const result = rebindOperationIdentity(operation, new Map([['old', 'new']]));
  assert.equal(result.targetId, 'new'); assert.equal(result.baseRevision, 'new');
  assert.deepEqual(result.dependencies, ['new']); assert.equal(result.opId, 'own-id');
  const payload = result.payload as Record<string, unknown>;
  for (const key of Object.keys(identityFields)) assert.deepEqual(payload[key], key === 'childIds' ? ['new'] : 'new');
  for (const key of ['node', 'base', 'value']) assert.deepEqual(payload[key], content);
  assert.equal(payload.reason, 'old'); assert.equal(operation.targetId, 'old');
});
