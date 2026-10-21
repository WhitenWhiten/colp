import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { requestValue, transactionDone } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a',
  replicaId: 'replica-a', generation: 1,
});
const ECHO_WINDOW_MS = 5 * 60_000;
const stores: Array<ReturnType<typeof createSyncStateStore>> = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('expired completed intents stay while an open event still names them', async () => {
  const store = await openStore();
  const chain = cursorChain(store);
  await chain.change('plain', { expiresAt: Date.now() - 60_000 });
  await chain.change('unknown', { expiresAt: Date.now() - 60_000 });
  await store.persistApplyIntentFacts(scope, 'intent-unknown', { nativeResult: 'result_unknown', replayState: 'unknown' });
  await chain.change('repair', { expiresAt: Date.now() - 60_000 });
  await store.persistApplyIntentFacts(scope, 'intent-repair', { repairJobId: 'repair-1' });
  await chain.change('wait', { expiresAt: Date.now() - 60_000 });
  await store.persistApplyIntentFacts(scope, 'intent-wait', { waitReason: 'native_result_unknown' });
  await chain.change('referenced', { expiresAt: Date.now() - 60_000 });
  await chain.open('dependent');
  await setDeferredNativeIntent(store, 'event-dependent', 'intent-referenced');

  const pruned = await store.pruneExpiredCompletedApplyIntents(scope);
  assert.equal(pruned.deleted, 1);
  assert.equal(await store.getApplyIntent(scope, 'intent-plain') ?? null, null);
  assert.equal((await store.getApplyIntent(scope, 'intent-unknown'))?.nativeResult, 'result_unknown');
  assert.equal((await store.getApplyIntent(scope, 'intent-repair'))?.repairJobId, 'repair-1');
  assert.equal((await store.getApplyIntent(scope, 'intent-wait'))?.waitReason, 'native_result_unknown');
  assert.ok(await store.getApplyIntent(scope, 'intent-referenced'));

  await setDeferredNativeIntent(store, 'event-dependent', undefined);
  const released = await store.pruneExpiredCompletedApplyIntents(scope);
  assert.equal(released.deleted, 1);
  assert.equal(await store.getApplyIntent(scope, 'intent-referenced') ?? null, null);
  assert.ok(await store.getApplyIntent(scope, 'intent-unknown'));
  assert.ok(await store.getApplyIntent(scope, 'intent-repair'));
  assert.ok(await store.getApplyIntent(scope, 'intent-wait'));
});

test('a change echo inside the five-minute window survives history pruning', async () => {
  const store = await openStore();
  const chain = cursorChain(store);
  await chain.committed('old');
  await chain.change('expired', {
    expiresAt: Date.now() - 60_000,
    nativeTargetId: 'native-expired',
    expectedPostState: { digest: 'sha256:expired', nativeContent: { title: 'Expired title' } },
  });
  await chain.change('echo', {
    expiresAt: Date.now() + ECHO_WINDOW_MS,
    nativeTargetId: 'native-echo',
    expectedPostState: { digest: 'sha256:echo', nativeContent: { title: 'Echo title' } },
  });
  await chain.committed('newest');

  const intents = await store.pruneExpiredCompletedApplyIntents(scope);
  assert.equal(intents.deleted, 1);
  assert.equal(await store.getApplyIntent(scope, 'intent-expired') ?? null, null);
  assert.ok(await store.getApplyIntent(scope, 'intent-echo'));

  await store.prunePullHistory(scope, 1, { maxEvents: 1, maxBytes: 1 });
  assert.equal(await store.getPullEvent(scope, 'event-old'), null);
  assert.equal(await store.getPullEvent(scope, 'event-expired'), null);
  assert.ok(await store.getPullEvent(scope, 'event-echo'));
  assert.ok(await store.getPullEvent(scope, 'event-newest'));
  assert.equal(await store.observeApplyIntentChangeFields(scope, 'native-echo', { title: 'Echo title' }), true);
  assert.equal(await store.observeApplyIntentChangeFields(scope, 'native-expired', { title: 'Expired title' }), false);
});

async function openStore() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  stores.push(store);
  await store.registerScope({
    ...scope, lifecycle: 'active',
    lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [],
  });
  return store;
}

function cursorChain(store: Awaited<ReturnType<typeof openStore>>) {
  let cursor = 'cursor-0';
  return {
    async committed(id: string) {
      const next = `cursor-${id}`;
      await store.stagePullPage(scope, {
        pageId: `page-${id}`, previousCursor: cursor, nextCursor: next,
        collectionRevision: `rev-${id}`, pageDigest: `sha256:${id}`, effectPages: [],
        events: [{
          eventId: `event-${id}`, cursor: next, operationId: `op-${id}`, effectId: `effect-${id}`,
          effectDigest: `sha256:effect-${id}`, operationDigest: `sha256:op-${id}`,
          kind: 'node_content_updated', payload: {}, initialState: 'authority_committed',
        }],
      });
      await store.completePullPage(scope, `page-${id}`);
      cursor = next;
      await pause();
    },
    async change(id: string, input: Record<string, unknown> = {}) {
      const next = `cursor-${id}`;
      await store.stagePullPage(scope, {
        pageId: `page-${id}`, previousCursor: cursor, nextCursor: next,
        collectionRevision: `rev-${id}`, pageDigest: `sha256:${id}`, effectPages: [],
        events: [{
          eventId: `event-${id}`, cursor: next, operationId: `op-${id}`, effectId: `effect-${id}`,
          effectDigest: `sha256:effect-${id}`, operationDigest: `sha256:op-${id}`,
          kind: 'node_content_updated', payload: {},
        }],
      });
      await store.preparePullIntent(scope, `event-${id}`, {
        intentId: `intent-${id}`, correlationId: `correlation-${id}`, operationId: `op-${id}`,
        eventId: `event-${id}`, effectId: `effect-${id}`, state: 'intent_prepared',
        expected: { kind: 'change', nativeId: `native-${id}` },
        nativeTargetId: `native-${id}`, expiresAt: Date.now() - 60_000,
        nativeResult: 'applied_with_evidence', replayState: 'committed',
        apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null,
        ...input,
      });
      await store.markPullBrowserCallStarted(scope, `event-${id}`);
      await store.commitPullEvent(scope, `event-${id}`, {});
      await store.completePullPage(scope, `page-${id}`);
      cursor = next;
      await pause();
    },
    async open(id: string) {
      const next = `cursor-${id}`;
      await store.stagePullPage(scope, {
        pageId: `page-${id}`, previousCursor: cursor, nextCursor: next,
        collectionRevision: `rev-${id}`, pageDigest: `sha256:${id}`, effectPages: [],
        events: [{
          eventId: `event-${id}`, cursor: next, operationId: `op-${id}`, effectId: `effect-${id}`,
          effectDigest: `sha256:effect-${id}`, operationDigest: `sha256:op-${id}`,
          kind: 'node_content_updated', payload: {},
        }],
      });
    },
  };
}

async function setDeferredNativeIntent(store: Awaited<ReturnType<typeof openStore>>, eventId: string,
  intentId: string | undefined) {
  const db = await store.open();
  const tx = db.transaction(STORES.pullEvents, 'readwrite');
  const events = tx.objectStore(STORES.pullEvents);
  const event = await requestValue<Record<string, unknown> | undefined>(events.get([scopeKey(scope), eventId]));
  if (!event) throw new Error(`missing ${eventId}`);
  const { deferredNativeIntentId: _previous, ...rest } = event;
  events.put(intentId === undefined ? rest : { ...rest, deferredNativeIntentId: intentId });
  await transactionDone(tx);
}

function pause() { return new Promise((resolve) => setTimeout(resolve, 5)); }
