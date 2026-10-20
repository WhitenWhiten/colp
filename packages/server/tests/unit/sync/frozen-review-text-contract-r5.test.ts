import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selectedResolutionFields } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import { evaluateSyncNodeUpdate, validateSyncConflictResolutionCommand } from '../../../src/modules/sync/index.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

const cases = [
  { field: 'description', cap: 16384, accepted: `${'界'.repeat(5461)}a`, rejected: '界'.repeat(5462) },
  { field: 'url', cap: 4096, accepted: `https://example.test/${'界'.repeat(1358)}a`,
    rejected: `https://example.test/${'界'.repeat(1359)}` },
  { field: 'canonicalUrl', cap: 4096, accepted: `https://example.test/${'界'.repeat(1358)}a`,
    rejected: `https://example.test/${'界'.repeat(1359)}` },
] as const;

for (const entry of cases) {
  for (const boundary of ['accepted', 'rejected'] as const) {
    test(`R5: real custom ${entry.field} resolution ${boundary} UTF-8 boundary is authoritative`, () => {
      const value = entry[boundary], field = entry.field;
      const baseValue = field === 'description' ? 'Base description' : 'https://base.test/';
      const currentValue = field === 'description' ? 'Current description' : 'https://current.test/';
      const incomingValue = field === 'description' ? 'Browser description' : 'https://browser.test/';
      const current = { collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: 'update-node-r1',
        kind: 'bookmark' as const, deleted: false,
        payload: { kind: 'bookmark', title: 'Server', url: 'https://current.test/', [field]: currentValue } };
      const retained = { nodeKind: 'bookmark' as const, base: { [field]: baseValue },
        current: { [field]: currentValue }, incoming: { [field]: incomingValue },
        bookmarkUrlContext: { baseUrl: field === 'url' ? baseValue : current.payload.url } };
      const command = validateSyncConflictResolutionCommand({ conflictId: 'text-conflict', idempotencyKey: 'text-choice',
        ifMatch: ['"conflict-r1"'], request: { resolution: 'custom', baseConflictRevision: 'conflict-r1', value } });
      const desired = selectedResolutionFields(command, current.payload, retained, [`/${field}`]);
      const run = () => evaluateSyncNodeUpdate(syncNodeUpdatePushRequest(desired).operations[0]!, current, current);
      if (boundary === 'rejected') {
        assert.ok(Buffer.byteLength(value, 'utf8') > entry.cap);
        assert.throws(run, /invalid_document/);
      } else {
        assert.equal(Buffer.byteLength(value, 'utf8'), entry.cap);
        const result = run();
        assert.equal(result.status, 'merged');
        if (result.status !== 'merged') throw new Error('expected accepted exact byte boundary');
        assert.equal(result.fields.kindFields[field], value);
      }
    });
  }
}
