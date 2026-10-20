import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { duplicateNodeDocument, selectedResolutionFields } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import { planSyncConflictDecision } from '../../../src/infrastructure/sync/sync-conflict-decision.js';
import { withHistoricalBookmarkUrlContext, type PrivateConflictPayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';
import { evaluateSyncNodeUpdate, validateSyncConflictResolutionCommand, validIncomingBookmarkUrlHash } from '../../../src/modules/sync/index.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

const urlA = 'https://example.test/a', urlB = 'https://example.test/b';
const hash = (url: string) => `sha-256=:${createHash('sha256').update(url).digest('base64')}:`;
const hashA = hash(urlA), hashB = hash(urlB);
const base = { collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: 'update-node-r1',
  kind: 'bookmark' as const, deleted: false, payload: { kind: 'bookmark', title: 'Base', url: urlA } };

const admission = { conflict_id: 'conflict', revision: 'conflict-r1', current_revision: 'update-node-r2',
  conflict_type: 'concurrent_field_update' as const, conflicting_fields: ['/title'],
  allowed_resolutions: ['server', 'incoming', 'custom', 'both'] as const };
const command = (resolution: 'server' | 'incoming' | 'custom' | 'both', revision: string) =>
  validateSyncConflictResolutionCommand({ conflictId: 'conflict', idempotencyKey: 'metadata-choice',
    ifMatch: [`"${revision}"`], request: { resolution, baseConflictRevision: revision,
      ...(resolution === 'custom' ? { value: 'Custom' } : {}) } });

test.each([false, true])('a metadata-only refresh keeps Current\'s independent URL and enrichment (enriched=%s)', enriched => {
  const request = syncNodeUpdatePushRequest({ base: { urlHash: null, canonicalUrl: null },
    value: { urlHash: hashA, canonicalUrl: 'https://canonical.test/a' } });
  assert.equal(createValidatorRegistry().validate('syncPush', request).valid, true);
  const current = { ...base, revision: 'update-node-r2', payload: { ...base.payload, url: urlB,
    ...(enriched ? { urlHash: hashB, canonicalUrl: 'https://canonical.test/b' } : {}) } };
  const evaluated = evaluateSyncNodeUpdate(request.operations[0]!, base, current);
  assert.equal(evaluated.status, 'merged');
  if (evaluated.status !== 'merged') throw new Error('expected merged metadata refresh');
  assert.equal(Object.hasOwn(evaluated.merged, 'url'), false, 'metadata does not author a URL');
  assert.equal({ ...current.payload, ...evaluated.fields.kindFields }.url, urlB);
  assert.equal(evaluated.fields.kindFields.urlHash, enriched ? hashB : null);
  assert.equal(evaluated.fields.kindFields.canonicalUrl, enriched ? 'https://canonical.test/b' : null);
});

test('an advertised server title decision cannot revalidate a retained hash-only edit against a later URL', () => {
  const request = syncNodeUpdatePushRequest({ base: { title: 'Base', urlHash: null },
    value: { title: 'Incoming', urlHash: hashA } });
  assert.equal(createValidatorRegistry().validate('syncPush', request).valid, true);
  const atAdmission = { ...base, revision: 'update-node-r2', payload: { ...base.payload, title: 'Server' } };
  assert.deepEqual(evaluateSyncNodeUpdate(request.operations[0]!, base, atAdmission),
    { status: 'conflict', code: 'sync_conflict_pending', fields: ['title'] });
  const retained = { nodeKind: 'bookmark' as const, bookmarkUrlContext: { baseUrl: urlA },
    base: request.operations[0]!.payload!.base as Record<string, unknown>,
    current: { title: 'Server', urlHash: null }, incoming: request.operations[0]!.payload!.value as Record<string, unknown> };
  const current = { ...atAdmission, revision: 'update-node-r3', payload: { ...atAdmission.payload, url: urlB } };
  const decision = planSyncConflictDecision(admission, retained,
  { kind: 'bookmark', resourceRevision: current.revision, deleted: false, payload: current.payload, resolutionWriteBlockedReason: null });
  assert.ok(decision.allowedResolutions.includes('server'));
  assert.notEqual(decision.revision, admission.revision);
  assert.deepEqual(decision.conflictingFields, ['/title']);
  const desired = selectedResolutionFields(command('server', decision.revision), current.payload, retained, decision.conflictingFields);
  assert.equal(Object.hasOwn(desired.value, 'url'), false);
  assert.equal(desired.value.urlHash, null);
});

test('including the unchanged Base URL alongside metadata does not turn the refresh into a URL edit', () => {
  const current = { ...base, revision: 'update-node-r2', payload: { ...base.payload, url: urlB, urlHash: hashB } };
  const result = evaluateSyncNodeUpdate(syncNodeUpdatePushRequest({ base: { url: urlA, urlHash: null },
    value: { url: urlA, urlHash: hashA } }).operations[0]!, base, current);
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged') throw new Error('expected merged refresh');
  assert.equal(result.fields.kindFields.url, urlB);
  assert.equal(result.fields.kindFields.urlHash, hashB);
});

test.each(['server', 'incoming', 'custom', 'both'] as const)(
  'old and new retained payloads make the advertised %s title choice executable after a URL change', resolution => {
    const original: PrivateConflictPayload = { nodeKind: 'bookmark', base: { title: 'Base', urlHash: null, canonicalUrl: null },
      current: { title: 'Server', urlHash: null, canonicalUrl: null },
      incoming: { title: 'Incoming', urlHash: hashA, canonicalUrl: 'https://canonical.test/a' } };
    for (const retained of [withHistoricalBookmarkUrlContext(original, urlA),
      { ...original, bookmarkUrlContext: { baseUrl: urlA } }]) {
      const current = { ...base, revision: 'update-node-r3', payload: { ...base.payload,
        title: 'Server', url: urlB, urlHash: hashB, canonicalUrl: 'https://canonical.test/b' } };
      const decision = planSyncConflictDecision(admission, retained, { kind: 'bookmark', resourceRevision: current.revision,
        deleted: false, payload: current.payload, resolutionWriteBlockedReason: null });
      assert.ok(decision.allowedResolutions.includes(resolution));
      assert.deepEqual(decision.conflictingFields, ['/title']);
      let content: Readonly<Record<string, unknown>>;
      if (resolution === 'both') content = duplicateNodeDocument(current.payload, retained, decision.conflictingFields);
      else {
        const desired = selectedResolutionFields(command(resolution, decision.revision), current.payload, retained, decision.conflictingFields);
        assert.equal(Object.hasOwn(desired.value, 'url'), false);
        const result = evaluateSyncNodeUpdate(syncNodeUpdatePushRequest({ baseRevision: current.revision, ...desired }).operations[0]!,
          current, current);
        assert.equal(result.status, 'merged');
        if (result.status !== 'merged') throw new Error('expected executable decision');
        content = { ...current.payload, ...result.fields.kindFields };
      }
      assert.equal(content.title, resolution === 'server' ? 'Server' : resolution === 'custom' ? 'Custom' : 'Incoming');
      assert.equal(content.url, urlB);
      assert.equal(content.urlHash, hashB);
      assert.equal(content.canonicalUrl, 'https://canonical.test/b');
      assert.equal(Object.hasOwn(retained.incoming, 'url'), false);
    }
    assert.equal(original.bookmarkUrlContext, undefined, 'legacy history hydration does not mutate encrypted content');
  });

test('missing historical URL context preserves the conflict with no live choices, including a valid-looking Current digest', () => {
  const retained: PrivateConflictPayload = { nodeKind: 'bookmark', base: { title: 'Base', urlHash: null },
    current: { title: 'Server', urlHash: null }, incoming: { title: 'Incoming', urlHash: hashB } };
  const current = { kind: 'bookmark' as const, resourceRevision: 'node-current', deleted: false,
    payload: { ...base.payload, title: 'Server', url: urlB }, resolutionWriteBlockedReason: null };
  const unchanged = structuredClone(retained);
  const unavailable = withHistoricalBookmarkUrlContext(retained, null);
  const decision = planSyncConflictDecision(admission, unavailable, current);
  assert.deepEqual(decision.allowedResolutions, []);
  assert.equal(decision.resolutionBlockedReason, 'resource_not_found');
  assert.equal(decision.summary.incoming, 'Incoming');
  assert.throws(() => selectedResolutionFields(command('server', decision.revision), current.payload, unavailable, ['/title']),
    /resource_not_found/);
  const deleted = planSyncConflictDecision(admission, unavailable, { ...current, deleted: true,
    resolutionWriteBlockedReason: 'node_read_only' });
  assert.deepEqual(deleted.allowedResolutions, ['server']);
  assert.equal(deleted.resolutionBlockedReason, undefined);
  assert.deepEqual(retained, unchanged);
});

test.each(['hash', 'canonical'] as const)('the %s-only dependency fences later URL edits without adding a URL choice', field => {
  const incoming = field === 'hash' ? { urlHash: hashA } : { canonicalUrl: 'https://canonical.test/a' };
  const retained: PrivateConflictPayload = { nodeKind: 'bookmark', bookmarkUrlContext: { baseUrl: urlA },
    base: { title: 'Base', urlHash: null, canonicalUrl: null }, current: { title: 'Server' },
    incoming: { title: 'Incoming', ...incoming } };
  const current = { kind: 'bookmark' as const, resourceRevision: 'r2', deleted: false,
    payload: { ...base.payload, title: 'Server' }, resolutionWriteBlockedReason: null };
  const initial = planSyncConflictDecision(admission, retained, current);
  const later = planSyncConflictDecision(admission, retained, { ...current, resourceRevision: 'r3',
    payload: { ...current.payload, url: urlB } });
  assert.notEqual(later.revision, initial.revision);
  assert.deepEqual(later.conflictingFields, ['/title']);
});

test('equivalent spelling pins a metadata-only hash without dropping the canonical URL or a Current digest', () => {
  const spelling = 'HTTPS://EXAMPLE.TEST:443/a';
  const current = { ...base, revision: 'update-node-r2', payload: { ...base.payload, url: spelling, urlHash: hash(spelling) } };
  const request = syncNodeUpdatePushRequest({ base: { urlHash: null, canonicalUrl: null },
    value: { urlHash: hashA, canonicalUrl: 'https://canonical.test/a' } });
  const result = evaluateSyncNodeUpdate(request.operations[0]!, base, current);
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged') throw new Error('expected equivalent metadata merge');
  assert.equal({ ...current.payload, ...result.fields.kindFields }.url, spelling);
  assert.equal(result.fields.kindFields.urlHash, hash(spelling));
  assert.equal(result.fields.kindFields.canonicalUrl, 'https://canonical.test/a');
  assert.equal(Object.hasOwn(result.merged, 'url'), false);
});

test('metadata-only null clears need no historical URL context, and an unchanged invalid hash is still rejected', () => {
  const retained: PrivateConflictPayload = { nodeKind: 'bookmark', base: { title: 'Base', urlHash: hashA,
    canonicalUrl: 'https://canonical.test/a' }, current: { title: 'Server', urlHash: hashA, canonicalUrl: 'https://canonical.test/a' },
    incoming: { title: 'Incoming', urlHash: null, canonicalUrl: null } };
  const current = { ...base, revision: 'update-node-r2', payload: { ...base.payload, ...retained.current } };
  const decision = planSyncConflictDecision(admission, retained, { kind: 'bookmark', resourceRevision: current.revision,
    deleted: false, payload: current.payload, resolutionWriteBlockedReason: null });
  assert.ok(decision.allowedResolutions.includes('server'));
  const desired = selectedResolutionFields(command('server', decision.revision), current.payload, retained, ['/title']);
  assert.equal(desired.value.urlHash, null);
  assert.equal(desired.value.canonicalUrl, null);
  assert.equal(validIncomingBookmarkUrlHash({ urlHash: hashB }, { urlHash: hashB }, urlA), false);
  assert.equal(validIncomingBookmarkUrlHash({ urlHash: hashA }, { url: 'HTTPS://EXAMPLE.TEST:443/a', urlHash: hashA }, urlA), true);
  assert.throws(() => evaluateSyncNodeUpdate(syncNodeUpdatePushRequest({ base: { urlHash: null },
    value: { urlHash: hashB } }).operations[0]!, base, { ...base, revision: 'update-node-r3',
    payload: { ...base.payload, url: urlB, urlHash: hashB } }), /invalid_document/,
  'a digest valid only for Current cannot be silently accepted as an original incoming hash');
  const invalidIncoming = { ...retained, bookmarkUrlContext: { baseUrl: urlA }, incoming: { title: 'Incoming', urlHash: hashB } };
  assert.throws(() => selectedResolutionFields(command('server', 'conflict-r1'), current.payload, invalidIncoming, ['/title']), /invalid_document/);
  assert.throws(() => duplicateNodeDocument(current.payload, invalidIncoming, ['/title']), /invalid_document/);
});
