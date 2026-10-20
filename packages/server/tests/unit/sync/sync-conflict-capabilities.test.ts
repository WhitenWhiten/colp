import assert from 'node:assert/strict';
import { test } from 'vitest';
import { encryptPrivatePayload } from '../../../src/infrastructure/sync/sync-conflict-postgres.js';
import { readProductConflictResolutions } from '../../../src/infrastructure/sync/sync-conflict-resolution-postgres.js';
import { selectedResolutionFields, duplicateNodeDocument } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import { stableJson } from '../../../src/infrastructure/sync/sync-conflict-json.js';
import { evaluateSyncNodeUpdate, mapSyncNodeCreateOperation, validateSyncConflictResolutionCommand } from '../../../src/modules/sync/index.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

test.each([false, true])('the decrypted decision menu is executable without fabricating missing intent (retained=%s)', retained => {
  const keyring = { active: { key: Buffer.alloc(32, 81), keyVersion: 1 }, retained: [] };
  const fields = retained ? ['/baseRevision', '/title'] : ['/baseRevision'];
  const payload = { nodeKind: 'bookmark' as const, base: retained ? { title: 'Base' } : {},
    current: retained ? { title: 'Current' } : {}, incoming: retained ? { title: 'Incoming' } : {} };
  const invalid = (): never => { throw new Error('invalid fixture'); };
  const encrypted = encryptPrivatePayload(stableJson(payload, invalid), keyring.active, {
    collectionId: 'update-collection-1', replicaId: 'replica', leaseGeneration: '1', sessionId: 'session',
    operationId: 'incoming-op', targetId: 'update-node-1', conflictId: 'conflict', commitOrdinal: '1',
    conflictType: 'unprovable_base', conflictingFields: stableJson(fields, invalid), nodeKind: 'bookmark',
    baseRevision: 'base-r1', currentRevision: 'current-r2', keyVersion: '1',
  });
  const row = { conflict_id: 'conflict', collection_id: 'update-collection-1', replica_id: 'replica',
    session_id: 'session', operation_id: 'incoming-op', target_id: 'update-node-1',
    conflict_type: 'unprovable_base', conflicting_fields: fields, commit_ordinal: 1n,
    base_revision: 'base-r1', current_revision: 'current-r2', private_payload_key_version: 1,
    private_payload_ciphertext: encrypted.ciphertext, private_payload_iv: encrypted.iv,
    private_payload_auth_tag: encrypted.authTag, private_payload_digest: encrypted.digest,
    allowed_resolutions: ['server', 'incoming', 'custom', 'both'],
  } as Parameters<typeof readProductConflictResolutions>[0];
  const menu = readProductConflictResolutions(row, keyring, 'bookmark', 1n);
  assert.deepEqual(menu, retained ? ['server', 'incoming', 'custom', 'both'] : ['server']);
  const current = { kind: 'bookmark', title: 'Current', url: 'https://example.test/current', extensions: {} };
  for (const resolution of menu) {
    if (resolution === 'both') {
      const node = duplicateNodeDocument(current, payload, fields);
      const create = syncNodeCreatePushRequest({ node }).operations[0]!;
      assert.equal(mapSyncNodeCreateOperation(create, { managedBookmarkWrites: false }).fields.kindFields.title, 'Incoming');
      continue;
    }
    const command = validateSyncConflictResolutionCommand({ conflictId: 'conflict', idempotencyKey: 'command',
      ifMatch: ['"conflict-r1"'], request: { resolution, baseConflictRevision: 'conflict-r1',
        ...(resolution === 'custom' ? { value: 'Custom' } : {}) } });
    const desired = selectedResolutionFields(command, current, payload, fields);
    const operation = syncNodeUpdatePushRequest({ baseRevision: 'current-r2', ...desired }).operations[0]!;
    const trusted = { collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: 'current-r2',
      kind: 'bookmark' as const, deleted: false, payload: current };
    const result = evaluateSyncNodeUpdate(operation, trusted, trusted);
    assert.equal(result.status, 'merged');
    assert.equal(result.fields.kindFields.title, resolution === 'server' ? 'Current' : resolution === 'custom' ? 'Custom' : 'Incoming');
  }
  assert.deepEqual(row.allowed_resolutions, ['server', 'incoming', 'custom', 'both']);
});
