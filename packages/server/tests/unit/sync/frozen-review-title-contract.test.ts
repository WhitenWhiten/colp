import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selectedResolutionFields } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import { evaluateSyncNodeUpdate, validateSyncConflictResolutionCommand } from '../../../src/modules/sync/index.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

test.each(['bookmark', 'folder'] as const)('independent frozen review: custom empty title keeps the authoritative %s rule', kind => {
  const retained = { nodeKind: kind, base: { title: 'Base' }, current: { title: 'Server' }, incoming: { title: 'Browser' } };
  const current = { collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: 'update-node-r1',
    kind, deleted: false, payload: { kind, title: 'Server', ...(kind === 'bookmark' ? { url: 'https://example.test/' } : {}) } };
  const command = validateSyncConflictResolutionCommand({ conflictId: 'title-conflict', idempotencyKey: 'title-choice',
    ifMatch: ['"conflict-r1"'], request: { resolution: 'custom', baseConflictRevision: 'conflict-r1', value: '' } });
  const desired = selectedResolutionFields(command, current.payload, retained, ['/title']);
  const run = () => evaluateSyncNodeUpdate(syncNodeUpdatePushRequest(desired).operations[0]!, current, current);
  if (kind === 'folder') assert.throws(run, /invalid_document/);
  else {
    const result = run();
    assert.equal(result.status, 'merged');
    if (result.status !== 'merged') throw new Error('expected merged bookmark resolution');
    assert.equal(result.fields.kindFields.title, '');
  }
});

test.each([1024, 1026])('independent frozen review: the server enforces the shared title byte cap at %s bytes', bytes => {
  const title = bytes === 1024 ? `${'界'.repeat(341)}a` : '界'.repeat(342);
  assert.equal(Buffer.byteLength(title, 'utf8'), bytes);
  const current = { collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: 'update-node-r1',
    kind: 'bookmark' as const, deleted: false, payload: { kind: 'bookmark', title: 'Server', url: 'https://example.test/' } };
  const run = () => evaluateSyncNodeUpdate(syncNodeUpdatePushRequest({ base: { title: 'Server' }, value: { title } }).operations[0]!, current, current);
  if (bytes > 1024) assert.throws(run, /invalid_document/);
  else {
    const result = run();
    assert.equal(result.status, 'merged');
    if (result.status !== 'merged') throw new Error('expected accepted boundary title');
    assert.equal(result.fields.kindFields.title, title);
  }
});
