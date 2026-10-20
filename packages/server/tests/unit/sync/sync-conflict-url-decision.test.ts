import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { selectedResolutionFields } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import { planSyncConflictDecision } from '../../../src/infrastructure/sync/sync-conflict-decision.js';
import { evaluateSyncNodeUpdate, validateSyncConflictResolutionCommand } from '../../../src/modules/sync/index.js';
import type { PrivateConflictPayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

const hash = (url: string) => `sha-256=:${createHash('sha256').update(url).digest('base64')}:`;
const before = 'https://example.test/before', after = 'https://example.test/after';
const serverUrl = 'https://example.test/server', customUrl = 'https://example.test/custom';
const trusted = (payload: Readonly<Record<string, unknown>>, revision = 'update-node-r2') => ({
  collectionId: 'update-collection-1', resourceId: 'update-node-1', revision,
  kind: 'bookmark' as const, deleted: false,
  payload: { kind: 'bookmark', title: 'Bookmark', url: before, ...payload },
});
const admission = { conflict_id: 'conflict', revision: 'conflict-r1', current_revision: 'update-node-r2',
  conflict_type: 'concurrent_field_update' as const,
  conflicting_fields: ['/url'], allowed_resolutions: ['server', 'incoming', 'custom', 'both'] as const };

test.each(['server', 'incoming', 'custom'] as const)(
  'the advertised %s URL decision remains executable with valid incoming URL metadata', resolution => {
    const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
      base: { url: before, urlHash: null, canonicalUrl: null }, current: { url: serverUrl },
      incoming: { url: after, urlHash: hash(after), canonicalUrl: 'https://canonical.test/after' } };
    const current = trusted(retained.current);
    const original = syncNodeUpdatePushRequest({ base: retained.base, value: retained.incoming });
    assert.equal(createValidatorRegistry().validate('syncPush', original).valid, true);
    assert.deepEqual(evaluateSyncNodeUpdate(original.operations[0]!, trusted({}, 'update-node-r1'), current),
      { status: 'conflict', code: 'sync_conflict_pending', fields: ['url'] });
    const decision = planSyncConflictDecision(admission, retained,
      { kind: 'bookmark', resourceRevision: current.revision, deleted: false, payload: current.payload });
    assert.ok(decision.allowedResolutions.includes(resolution));
    const command = validateSyncConflictResolutionCommand({ conflictId: 'conflict', idempotencyKey: 'decision',
      ifMatch: [`"${decision.revision}"`], request: { resolution, baseConflictRevision: decision.revision,
        ...(resolution === 'custom' ? { value: customUrl } : {}) } });
    const desired = selectedResolutionFields(command, current.payload, retained, decision.conflictingFields);
    const operation = syncNodeUpdatePushRequest({ baseRevision: current.revision, ...desired }).operations[0]!;
    const result = evaluateSyncNodeUpdate(operation, current, current);
    assert.equal(result.status, 'merged');
    if (result.status !== 'merged') throw new Error('expected merged decision');
    assert.equal(result.fields.kindFields.url, resolution === 'server' ? serverUrl : resolution === 'custom' ? customUrl : after);
    assert.equal(result.fields.kindFields.urlHash, resolution === 'incoming' ? hash(after) : null);
    assert.equal(result.fields.kindFields.canonicalUrl, resolution === 'incoming' ? 'https://canonical.test/after' : null);
  });

test.each(['server', 'incoming', 'custom'] as const)(
  'a %s title choice retains a separate URL edit without reauthoring Current-only metadata', resolution => {
    const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
      base: { title: 'Base', url: before, urlHash: null, canonicalUrl: null },
      current: { title: 'Server', url: before, urlHash: hash(before), canonicalUrl: 'https://canonical.test/before' },
      incoming: { title: 'Incoming', url: after, urlHash: null, canonicalUrl: null } };
    const current = trusted(retained.current);
    const command = validateSyncConflictResolutionCommand({ conflictId: 'conflict', idempotencyKey: 'decision',
      ifMatch: ['"conflict-r1"'], request: { resolution, baseConflictRevision: 'conflict-r1',
        ...(resolution === 'custom' ? { value: 'Custom' } : {}) } });
    const desired = selectedResolutionFields(command, current.payload, retained, ['/title']);
    const result = evaluateSyncNodeUpdate(syncNodeUpdatePushRequest({ baseRevision: current.revision, ...desired }).operations[0]!,
      current, current);
    assert.equal(result.status, 'merged');
    if (result.status !== 'merged') throw new Error('expected merged decision');
    assert.equal(result.fields.kindFields.url, after);
    assert.equal(result.fields.kindFields.urlHash, null);
    assert.equal(result.fields.kindFields.canonicalUrl, null);
  });

test.each(['authored', 'clear', 'current-only'] as const)(
  'an equivalent URL decision preserves %s metadata semantics', mode => {
    const spelling = 'HTTPS://EXAMPLE.TEST:443/before';
    const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
      base: { title: 'Base', url: before, urlHash: mode === 'clear' ? hash(before) : null },
      current: { title: 'Server', url: before, urlHash: hash(before) },
      incoming: { title: 'Incoming', url: spelling, urlHash: mode === 'authored' ? hash(spelling) : null } };
    const current = trusted(retained.current);
    const command = validateSyncConflictResolutionCommand({ conflictId: 'conflict', idempotencyKey: 'decision',
      ifMatch: ['"conflict-r1"'], request: { resolution: 'incoming', baseConflictRevision: 'conflict-r1' } });
    const fields = mode === 'authored' ? ['/title', '/urlHash'] : ['/title'];
    const desired = selectedResolutionFields(command, current.payload, retained, fields);
    const result = evaluateSyncNodeUpdate(syncNodeUpdatePushRequest({ baseRevision: current.revision, ...desired }).operations[0]!,
      current, current);
    assert.equal(result.status, 'merged');
    if (result.status !== 'merged') throw new Error('expected merged decision');
    assert.equal(result.fields.kindFields.url, before);
    assert.equal(result.fields.kindFields.urlHash, mode === 'clear' ? null : hash(before));
  });

test('URL decision normalization cannot silently repair an invalid original incoming digest', () => {
  const retained: PrivateConflictPayload = { nodeKind: 'bookmark', base: { url: before, urlHash: null },
    current: { url: serverUrl }, incoming: { url: after, urlHash: hash(serverUrl) } };
  const command = validateSyncConflictResolutionCommand({ conflictId: 'conflict', idempotencyKey: 'decision',
    ifMatch: ['"conflict-r1"'], request: { resolution: 'server', baseConflictRevision: 'conflict-r1' } });
  assert.throws(() => selectedResolutionFields(command, trusted(retained.current).payload, retained, ['/url']),
    /invalid_document/);
});
