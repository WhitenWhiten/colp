import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { evaluateSyncNodeUpdate, type TrustedSyncNodeRevision } from '../../../src/modules/sync/sync-node-update.js';
import { syncNodeUpdatePushRequest } from '../../fixtures/phase3/sync-node-update.js';

function revision(url: string): TrustedSyncNodeRevision {
  return {
    collectionId: 'update-collection-1', resourceId: 'update-node-1',
    revision: 'update-node-r1', kind: 'bookmark', deleted: false,
    payload: {
      kind: 'bookmark', title: 'Bookmark', url,
      description: null, tags: [], visibility: 'inherit', extensions: {},
    },
  };
}

describe('preserve browser bookmark URL edits', () => {
  test.each([
    ['document anchor', 'https://example.test/guide#install', 'https://example.test/guide#usage'],
    ['hash router', 'https://example.test/#/inbox', 'https://example.test/#/projects'],
    ['path trailing slash', 'https://example.test/docs', 'https://example.test/docs/'],
  ])('%s edits must reach the canonical URL and receipt', (_scenario, before, requested) => {
    const current = revision(before);
    const operation = syncNodeUpdatePushRequest({ base: { url: before }, value: { url: requested } }).operations[0]!;
    const result = evaluateSyncNodeUpdate(operation, current, current);
    assert.equal(result.status, 'merged');
    if (result.status !== 'merged') throw new Error('unexpected conflict');
    assert.equal(result.fields.kindFields.url, requested);
    assert.equal(result.merged.url, requested);
  });
});
