import assert from 'node:assert/strict';
import { test } from 'vitest';
import { planSyncConflictDecision, summarizeConflictContent } from '../../../src/infrastructure/sync/sync-conflict-decision.js';
import { selectedResolutionFields } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import type { PrivateConflictPayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';
import { validateSyncConflictResolutionCommand } from '../../../src/modules/sync/index.js';

const admission = { conflict_id: 'conflict-1', revision: 'conflict-r1', current_revision: 'node-r2',
  conflict_type: 'concurrent_field_update' as const, conflicting_fields: ['/title'],
  allowed_resolutions: ['server', 'incoming', 'custom', 'both'] as const };
const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
  base: { title: 'Base', description: 'Base note' },
  current: { title: 'Server', description: 'Base note' },
  incoming: { title: 'Incoming', description: 'Incoming note' } };
const original = { kind: 'bookmark' as const, resourceRevision: 'node-r2', deleted: false,
  payload: { ...retained.current, url: 'https://private.example/never-show' } };

test('decision fields and revision refresh together after a retained field diverges twice', () => {
  const initial = planSyncConflictDecision(admission, retained, original);
  assert.equal(initial.revision, admission.revision);
  assert.deepEqual(initial.conflictingFields, ['/title']);
  const current = { ...original, resourceRevision: 'node-r3', payload: { ...original.payload, description: 'New server note' } };
  const refreshed = planSyncConflictDecision(admission, retained, current);
  assert.notEqual(refreshed.revision, initial.revision);
  assert.deepEqual(refreshed.conflictingFields, ['/description', '/title']);
  assert.equal(refreshed.summary.current, 'Description: New server note\nTitle: Server');
  assert.equal(refreshed.summary.incoming, 'Description: Incoming note\nTitle: Incoming');
  assert.equal(JSON.stringify(refreshed).includes('private.example'), false);
  const again = planSyncConflictDecision(admission, retained,
    { ...current, resourceRevision: 'node-r4', payload: { ...current.payload, description: 'Newer server note' } });
  assert.notEqual(again.revision, refreshed.revision);
  assert.deepEqual(planSyncConflictDecision(admission, retained, current), refreshed);
  assert.deepEqual(admission.conflicting_fields, ['/title']);
  assert.equal(retained.current.description, 'Base note');
});

test.each(['server', 'incoming', 'custom'] as const)('a fresh %s decision can settle a newly competing field', resolution => {
  const current = { ...original, resourceRevision: 'node-r3', payload: { ...original.payload, description: 'Server note' } };
  const decision = planSyncConflictDecision(admission, retained, current);
  const custom = { title: 'Custom title', description: 'Custom note' };
  const command = validateSyncConflictResolutionCommand({ conflictId: admission.conflict_id,
    idempotencyKey: 'new-decision', ifMatch: [`"${decision.revision}"`],
    request: { resolution, baseConflictRevision: decision.revision, ...(resolution === 'custom' ? { value: custom } : {}) } });
  assert.deepEqual(selectedResolutionFields(command, current.payload, retained, decision.conflictingFields).value,
    resolution === 'server' ? { title: 'Server', description: 'Server note' }
      : resolution === 'incoming' ? retained.incoming : custom);
});

test('unrelated moves do not invalidate the admission decision; new namespace competition does', () => {
  const moved = planSyncConflictDecision(admission, retained,
    { ...original, resourceRevision: 'node-moved', payload: { ...original.payload, parentId: 'other-folder' } });
  assert.equal(moved.revision, admission.revision);
  const ns = 'https://example.test/feature';
  const intent = { ...retained, base: { ...retained.base, extensions: {} },
    current: { ...retained.current, extensions: {} }, incoming: { ...retained.incoming, extensions: { [ns]: 1 } } };
  const changed = planSyncConflictDecision(admission, intent,
    { ...original, resourceRevision: 'node-r3', payload: { ...original.payload, extensions: { [ns]: 2 } } });
  assert.deepEqual(changed.conflictingFields, ['/extensions', '/title']);
  assert.notEqual(changed.revision, admission.revision);
});

test('later deletion offers a separate recovery, and purged or historical server-only content stays restricted', () => {
  const deleted = { ...original, resourceRevision: 'node-deleted', deleted: true };
  const decision = planSyncConflictDecision(admission, retained, deleted);
  assert.equal(decision.type, 'delete_update');
  assert.deepEqual(decision.allowedResolutions, ['server', 'incoming']);
  assert.ok(decision.conflictingFields.includes('/deletedAt'));
  assert.notEqual(decision.revision, admission.revision);
  assert.deepEqual(planSyncConflictDecision(admission, retained, { ...deleted, payload: null }).allowedResolutions, ['server']);
  assert.deepEqual(planSyncConflictDecision({ ...admission, allowed_resolutions: ['server'] }, retained, deleted).allowedResolutions, ['server']);
  assert.deepEqual(planSyncConflictDecision(admission, { ...retained, incoming: {} }, deleted).allowedResolutions, ['server']);
});

test.each([254, 255, 256])('safe summary stays bounded without a split surrogate at prefix length %s', prefixLength => {
  const title = `${'a'.repeat(prefixLength)}😀${'z'.repeat(40)}`;
  const summary = summarizeConflictContent({ title }, ['/title'])!;
  assert.ok(summary.length <= 256);
  assert.ok(summary.endsWith('…'));
  assert.equal(summary.isWellFormed(), true);
  assert.equal(JSON.parse(JSON.stringify(summary)), summary);
  assert.equal(summarizeConflictContent({ url: title, extensions: { secret: title } }, ['/url', '/extensions']), null);
});
