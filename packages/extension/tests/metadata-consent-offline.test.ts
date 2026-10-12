import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createPersonalSyncPolicyStore } from '../src/personal-sync-policy.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { browserMetadataSyncPolicy } from '../src/metadata-sync-policy.js';

vi.mock('../src/metadata-transfer.js', () => ({ releaseMetadataBindings: async () => undefined }));
vi.mock('../src/bookmark-subscriptions/runtime.js', () => ({ prepareSubscriptionLogout: async () => undefined, maintenance: {}, wakeSubscriptions: () => undefined }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: () => undefined }));
vi.mock('../src/sw/personal-sync.js', () => ({ suspendPersonalSyncForLogout: async () => undefined }));
const availability = vi.hoisted(() => vi.fn(async () => 'unknown'));
vi.mock('../src/sw/collections.js', () => ({ verifyCollectionAvailability: availability }));
vi.mock('../src/sw/runtime.js', () => ({ COLLECTION_BINDING: 'known.sync.collection.v1', store: {
  loadCredential: async () => ({ serverOrigin: 'https://known.test', subject: 'owner' }) }, sw: {}, syncState: {}, workCoordinator: {} }));
vi.mock('../src/sw/scope.js', () => ({ loadConfig: async () => ({}), enforceManagedPolicy: async () => undefined,
  createRuntimeAuth: () => ({ status: async () => ({ status: 'connected' }) }), boundCollectionId: async () => 'one' }));
import { handle } from '../src/sw/auth.js';

test('Keep local on the current target revokes consent without network verification', async () => {
  const storage = new MemoryStorageArea(), scope = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'one' };
  vi.stubGlobal('chrome', { storage: { local: storage } });
  configurePersonalSyncTransport(createPersonalSyncPolicyStore(storage));
  const policy = browserMetadataSyncPolicy(); await policy.write(scope, true);
  try {
    assert.equal((await handle({ kind: 'known.collection.select', collectionId: 'one', userGesture: true },
      { generation: 1, signal: new AbortController().signal })).ok, true);
    assert.equal(availability.mock.calls.length, 0);
    assert.equal((await policy.read(scope)).mode, 'local-only');
    let sent = false; await assert.rejects(policy.dispatch(scope, async () => { sent = true; }), /metadata_sync_disabled/);
    assert.equal(sent, false);
  } finally { vi.unstubAllGlobals(); }
});
