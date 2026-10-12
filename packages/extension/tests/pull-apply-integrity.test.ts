import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { createPullApplyRuntime } from '../src/pull-apply-runtime.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { SyncStateError } from '../src/sync-state/types.js';
import type { PullBookmarkApi } from '../src/pull-applier-types.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-pull-apply',
  serverOrigin: 'https://known.example', accountId: 'account-pull-apply',
  browserProfileId: 'profile-pull-apply', collectionId: 'collection-pull-apply',
  replicaId: 'replica-pull-apply', generation: 1 };

const api: PullBookmarkApi = {
  create: async () => ({ id: 'native-new' }),
  update: async () => ({}), move: async () => ({}),
  remove: async () => undefined, removeTree: async () => undefined,
  get: async () => [], getChildren: async () => [],
};

async function setupVanishedEvent() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-server', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-0', cursor: 'cursor-0' }, selectedRoots: [] });
  const scopeKey = (await store.getScope(scope))!.scopeKey;
  const lost = { scopeKey, eventId: 'evt-lost', pageId: 'page-1', ordinal: 0,
    state: 'intent_prepared', cursor: 'cursor-1',
    payload: { kind: 'operation', cursor: 'cursor-1',
      effect: { kind: 'node_updated', node: { id: 'node-1', title: 'Remote' } } } };
  // The event row was listed but is gone by the time it is re-read — a local
  // integrity fault, not a transport failure (F036).
  const wrapped = Object.assign(Object.create(null), store, {
    listPullEvents: async () => [lost],
    getPullEvent: async () => null,
    // Its page is in the workset, so the event is ordinary apply work rather than superseded (640bd2c22).
    loadPullApplyWorkset: async () => ({ pages: [{ scopeKey, pageId: 'page-1', state: 'page_complete' }], stamps: [], intents: [] }),
  });
  const runtime = createPullApplyRuntime({ scope, store: wrapped as typeof store,
    session: { acceptedProtocolVersion: '0.2', sessionId: 'session-pull',
      collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/{pageNumber}',
    effectPageAuthority: 'https://known.example' }, api, () => 1_000);
  return runtime;
}

describe('F036 pull-apply local integrity defects are explicit', () => {
  test('a pull event that vanishes between listing and retrieval raises pull_event_state_invalid', async () => {
    const runtime = await setupVanishedEvent();
    await assert.rejects(runtime.resume(),
      (error: unknown) => error instanceof SyncStateError && error.code === 'pull_event_state_invalid');
  });
});
