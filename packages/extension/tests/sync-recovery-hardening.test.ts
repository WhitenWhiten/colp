import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { projectVirtualSnapshotChildren } from '../src/recovery-projection-executor.js';
import { createProjectionSuppression, projectionSuppresses } from '../src/recovery-overlay.js';
import { readProjectionIntent } from '../src/sync-state/pull-validate.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { fakeChrome } from './recovery-projection-chrome-fixture.js';
import { bar, child, scope, setup } from './sync-recovery-hardening-fixture.js';

describe('snapshot recovery with ordinary long bookmark content', () => {
  test.each([[10, 1992], [1024, 20], [600, 601]])('projects and replays title length %i and URL length %i once', async (titleLength, urlLength) => {
    const store = await setup(); const chrome = fakeChrome([{ id: '1', title: 'Bookmarks bar' }]);
    const title = 'T'.repeat(titleLength); const url = 'https://example.com/' + 'x'.repeat(urlLength - 20);
    const bound = [bar, child(title, url)];
    const first = await projectVirtualSnapshotChildren({ scope, store, api: chrome.api, bound });
    assert.equal(chrome.creates, 1);
    store.close();
    const reopened = createSyncStateStore({ indexedDB: store.factory });
    const second = await projectVirtualSnapshotChildren({ scope, store: reopened, api: chrome.api, bound });
    assert.equal(chrome.creates, 1, 'durable native receipt survives a worker restart');
    assert.equal(second[1]?.nativeId, first[1]?.nativeId);
    assert.match(createProjectionSuppression('1', title, url), /^recovery:create:v2:sha256:[a-f0-9]{64}$/);
    reopened.close();
  });

  test('normalizes legacy create correlations without changing their receipts', () => {
    const legacy = { intentId: 'create:child', kind: 'create', colpId: 'child', order: 1, generation: 1,
      state: 'executing', parentNativeId: '1', title: 'Draft', url: 'https://example.com/draft',
      observedNativeId: '2', suppression: 'recovery:create:1:Draft:https://example.com/draft' };
    const upgraded = readProjectionIntent(legacy);
    assert.equal(upgraded.observedNativeId, '2');
    assert.equal(projectionSuppresses([upgraded], { kind: 'create', nativeId: '2',
      suppression: createProjectionSuppression('1', 'Draft', legacy.url) }), true);
  });

  test('correlation tuples do not collide on colons in titles and URLs', () => {
    assert.notEqual(createProjectionSuppression('1', 'a', 'https://x:https://y'),
      createProjectionSuppression('1', 'a:https://x', 'https://y'));
  });
});

describe('protocol extension data is distinct from credential envelopes', () => {
  test('roundtrips names and fractional business values through mappings and snapshot staging', async () => {
    const store = await setup();
    const mapping = { ...bar, projection: { ...bar.projection, content: { title: 'Safe', extensions: {
      'https://example.com/tokenization': { tokenCount: 3, score: 0.5, cookieLabel: 'business value' },
    } } } };
    await store.putMapping(scope, mapping);
    assert.deepEqual((await store.getMappingByNativeId(scope, '1'))?.projection.content, mapping.projection.content);
    await store.stageRecoveryPage(scope, { snapshotId: 'snapshot', sessionId: 'session', revision: 'r1',
      syncCursor: 'cursor', identityDigest: 'identity', rootNodeId: 'bar', page: 0, pageDigest: 'digest',
      previousPageDigest: null, nextCursor: null, complete: true,
      nodes: [{ colpId: 'bar', parentId: null, position: '0', kind: 'Folder', payloadDigest: 'payload', mapping }] });
    assert.deepEqual((await store.listRecoveryNodes(scope))[0]?.mapping.projection.content, mapping.projection.content);
    await assert.rejects(store.putMapping(scope, { ...bar, projection: { ...bar.projection,
      content: { title: 'Unsafe', refreshToken: 'credential' } } }), /secret_field_forbidden/);
    await assert.rejects(store.putMapping(scope, { ...bar, projection: { ...bar.projection,
      content: { title: 'Unsafe', extensions: { refreshToken: 'credential' } } } }), /secret_field_forbidden/);
    for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(store.putMapping(scope, { ...bar, projection: { ...bar.projection,
        content: { title: 'Unsafe', extensions: { 'https://example.com/metrics': { score: value } } } } }), /i_json_invalid/);
    }
    store.close();
  });
});
