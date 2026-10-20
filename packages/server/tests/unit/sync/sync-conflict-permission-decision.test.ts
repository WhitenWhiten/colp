import assert from 'node:assert/strict';
import { test } from 'vitest';
import { planSyncConflictDecision } from '../../../src/infrastructure/sync/sync-conflict-decision.js';
import type { PrivateConflictPayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';

const admission = { conflict_id: 'permission-conflict', revision: 'conflict-r1', current_revision: 'node-r1',
  conflict_type: 'concurrent_field_update' as const, conflicting_fields: ['/title'],
  allowed_resolutions: ['server', 'incoming', 'custom', 'both'] as const };
const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
  base: { title: 'Base', description: null }, current: { title: 'Server', description: null },
  incoming: { title: 'Incoming', description: 'Independent offline note' } };
const current = { kind: 'bookmark' as const, resourceRevision: 'node-r1', deleted: false,
  payload: { ...retained.current, url: 'https://example.test/' }, resolutionWriteBlockedReason: null };

test.each(['node_read_only', 'resource_not_found'] as const)(
  'a current %s write policy blocks all live choices, including server with independent incoming intent', reason => {
    const original = structuredClone({ admission, retained });
    const writable = planSyncConflictDecision(admission, retained, current);
    const blocked = planSyncConflictDecision(admission, retained,
      { ...current, resolutionWriteBlockedReason: reason });
    assert.deepEqual(blocked.allowedResolutions, []);
    assert.equal(blocked.resolutionBlockedReason, reason);
    assert.notEqual(blocked.revision, writable.revision);
    assert.deepEqual({ admission, retained }, original);
    assert.equal(planSyncConflictDecision(admission, retained, current).revision, writable.revision);
  });

test('a protected tombstone only allows its originally advertised canonical no-op server dismissal', () => {
  const deleted = { ...current, deleted: true, resolutionWriteBlockedReason: 'node_read_only' as const };
  const decision = planSyncConflictDecision(admission, retained, deleted);
  assert.deepEqual(decision.allowedResolutions, ['server']);
  assert.equal(decision.resolutionBlockedReason, undefined);
  assert.deepEqual(planSyncConflictDecision({ ...admission, allowed_resolutions: ['incoming'] }, retained,
    deleted).allowedResolutions, []);
});

test('a live node with unavailable canonical content cannot advertise an executable server write', () => {
  const blocked = planSyncConflictDecision(admission, retained, { ...current, payload: null });
  assert.deepEqual(blocked.allowedResolutions, []);
  assert.equal(blocked.resolutionBlockedReason, 'resource_not_found');
});
