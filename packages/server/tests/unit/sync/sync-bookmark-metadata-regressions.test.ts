import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { duplicateNodeDocument } from '../../../src/infrastructure/sync/sync-conflict-content.js';
import { evaluateSyncNodeUpdate } from '../../../src/modules/sync/index.js';
import type { PrivateConflictPayload } from '../../../src/infrastructure/sync/sync-conflict-private-payload.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

const hash = (url: string) => `sha-256=:${createHash('sha256').update(url).digest('base64')}:`;
const before = 'https://example.test/before';
const after = 'https://example.test/after';
const currentUrl = 'https://example.test/current';
const revision = (payload: Readonly<Record<string, unknown>>, id = 'update-node-r1') => ({
  collectionId: 'update-collection-1', resourceId: 'update-node-1', revision: id,
  kind: 'bookmark' as const, deleted: false,
  payload: { kind: 'bookmark', title: 'Bookmark', url: before, ...payload },
});

test('independent review: valid URL edit must not fail because only Current added the previous URL hash', () => {
  const base = revision({});
  const current = revision({ urlHash: hash(before), canonicalUrl: 'https://canonical.test/before' }, 'update-node-r2');
  const request = syncNodeUpdatePushRequest({ base: { url: before, urlHash: null, canonicalUrl: null },
    value: { url: after, urlHash: null, canonicalUrl: null } });
  assert.equal(createValidatorRegistry().validate('syncPush', request).valid, true);
  const result = evaluateSyncNodeUpdate(request.operations[0]!, base, current);
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged') throw new Error('expected merged update');
  assert.equal(result.fields.kindFields.url, after);
  assert.equal(result.fields.kindFields.urlHash, null);
  assert.equal(result.fields.kindFields.canonicalUrl, null);
  assert.deepEqual(result.merged, { url: after, urlHash: null, canonicalUrl: null });
});

test('independent review: an advertised recovered copy can apply a true URL edit with an independently added server digest', () => {
  const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
    base: { title: 'Base', url: before, urlHash: null, canonicalUrl: null },
    current: { title: 'Server', url: before, urlHash: hash(before), canonicalUrl: 'https://canonical.test/before' },
    incoming: { title: 'Incoming', url: after, urlHash: null, canonicalUrl: null } };
  const node = duplicateNodeDocument({ kind: 'bookmark', ...retained.current }, retained, ['/title']);
  assert.equal(node.url, after);
  assert.equal(node.urlHash, undefined);
  assert.equal(node.canonicalUrl, undefined);
});

test('a changed URL cannot silently repair the unchanged digest submitted for the old URL', () => {
  const retained: PrivateConflictPayload = { nodeKind: 'bookmark',
    base: { title: 'Base', url: before, urlHash: hash(before) },
    current: { title: 'Server', url: currentUrl, urlHash: hash(currentUrl) },
    incoming: { title: 'Incoming', url: after, urlHash: hash(before) } };
  assert.throws(() => duplicateNodeDocument({ kind: 'bookmark', ...retained.current }, retained, ['/title', '/url']),
    /invalid_document/);
});
