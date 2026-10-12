import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import {
  BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX, BOOKMARK_CREATE_RECEIPT_KEY_PREFIX, createBookmarkCreatePlacementStore,
  parseBookmarkCreatePlacementRecord,
} from '../src/bookmark-create-placement.js';

const batchId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const secondIntentId = '33333333-3333-4333-8333-333333333333';
const input = {
  mode: 'top' as const, targetParentNativeId: 'parent-1', batchId, batchOrder: 0, batchSize: 1,
  title: 'Saved title', url: 'https://example.test/saved', expectedIndex: 0,
};

function storeAt(storage: MemoryStorageArea, now = 1_000, ids = [intentId]) {
  let cursor = 0;
  return createBookmarkCreatePlacementStore({ storage, now: () => now,
    randomUUID: () => ids[cursor++] ?? intentId });
}

describe('bookmark create placement reservations', () => {
  test('reserves before create, binds the native id, and consumes the bound intent', async () => {
    const storage = new MemoryStorageArea(); const store = storeAt(storage);
    const reserved = await store.reserve(input);
    assert.equal(reserved.state, 'reserved'); assert.equal(reserved.intentId, intentId);
    const bound = await store.bind(intentId, 'native-1');
    assert.equal(bound?.state, 'bound'); assert.equal(bound?.nativeId, 'native-1');
    const consumed = await store.consumeForCreated({ id: 'native-1', parentId: 'parent-1', index: 0,
      title: 'Saved title', url: 'https://example.test/saved' });
    assert.equal(consumed?.state, 'ready');
    assert.equal(consumed?.state === 'ready' ? consumed.intent.nativeId : undefined, 'native-1');
    assert.deepEqual(Object.keys(await storage.get(null)), [
      `${BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX}${intentId}`,
    ]);
    await store.complete(intentId);
    assert.equal(await store.get(intentId), undefined);
    assert.equal((await store.getReceipt(intentId))?.nativeId, 'native-1');
    assert.deepEqual(Object.keys(await storage.get(null)), [`${BOOKMARK_CREATE_RECEIPT_KEY_PREFIX}${intentId}`]);
    assert.equal(await store.consumeForCreated({ id: 'native-1', parentId: 'parent-1', index: 0,
      title: input.title, url: input.url }), undefined);
  });

  test('matches an early create event by the unique reserved parent/content/index tuple', async () => {
    const storage = new MemoryStorageArea(); const store = storeAt(storage);
    await store.reserve(input);
    const consumed = await store.consumeForCreated({ id: 'native-early', parentId: 'parent-1', index: 0,
      title: 'Saved title', url: 'https://example.test/saved' });
    assert.equal(consumed?.state, 'ready');
    assert.equal(consumed?.state === 'ready' ? consumed.intent.nativeId : undefined, 'native-early');
  });

  test('marks multiple reserved tuple matches as unproven instead of guessing', async () => {
    const storage = new MemoryStorageArea();
    const store = storeAt(storage, 1_000, [intentId, secondIntentId]);
    await store.reserve(input);
    await store.reserve({ ...input, batchId: secondIntentId });
    const consumed = await store.consumeForCreated({ id: 'native-ambiguous', parentId: 'parent-1', index: 0,
      title: 'Saved title', url: 'https://example.test/saved' });
    assert.equal(consumed?.state, 'unproven');
    assert.equal(consumed?.state === 'unproven' ? consumed.candidates.length : 0, 2);
    const rows = await storage.get(null);
    assert.equal(Object.values(rows).every((value) => (value as { state?: string }).state === 'attention'), true);
  });

  test('prefers one bound native id over unrelated reserved tuple ambiguity', async () => {
    const storage = new MemoryStorageArea();
    const store = storeAt(storage, 1_000, [intentId, secondIntentId]);
    await store.reserve(input);
    await store.reserve({ ...input, batchId: secondIntentId });
    await store.bind(intentId, 'native-preferred');
    const consumed = await store.consumeForCreated({ id: 'native-preferred', parentId: 'different-parent', index: 7,
      title: 'Different title', url: 'https://different.example/' });
    assert.equal(consumed?.state, 'ready');
    assert.equal(consumed?.state === 'ready' ? consumed.intent.intentId : undefined, intentId);
  });

  test('cleans expired reservations and supports cancellation', async () => {
    const storage = new MemoryStorageArea(); let now = 1_000;
    const store = createBookmarkCreatePlacementStore({ storage, now: () => now,
      ttlMs: 100, randomUUID: () => intentId });
    await store.reserve(input);
    now = 1_100;
    assert.equal(await store.consumeForCreated({ id: 'native-expired', parentId: 'parent-1', index: 0,
      title: 'Saved title', url: 'https://example.test/saved' }), undefined);
    assert.deepEqual(Object.keys(await storage.get(null)), []);
    await store.reserve(input); await store.cancel(intentId);
    assert.deepEqual(Object.keys(await storage.get(null)), []);
  });

  test('rejects malformed records and keeps reservation keys scoped', () => {
    assert.equal(parseBookmarkCreatePlacementRecord({ ...input, version: 2, intentId }), undefined);
    assert.equal(parseBookmarkCreatePlacementRecord({ ...input, intentId: 'bad' }), undefined);
    assert.equal(parseBookmarkCreatePlacementRecord({ ...input, expectedIndex: -1, intentId }), undefined);
    assert.equal(parseBookmarkCreatePlacementRecord({ ...input, url: 'javascript:alert(1)', intentId }), undefined);
    assert.equal(BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX.startsWith('known.bookmark.create-placement.v1.'), true);
  });
});


test('early event completion retains identity across restart and expires its receipt', async () => {
  const storage = new MemoryStorageArea();
  let now = 1_000;
  const store = createBookmarkCreatePlacementStore({ storage, now: () => now, ttlMs: 100,
    randomUUID: () => intentId });
  await store.reserve(input);
  const consumed = await store.consumeForCreated({ id: 'early', parentId: 'parent-1', index: 0,
    title: input.title, url: input.url });
  assert.equal(consumed?.state, 'ready');
  await store.complete(intentId, 'early');
  const restarted = createBookmarkCreatePlacementStore({ storage, now: () => now, ttlMs: 100 });
  assert.equal(await restarted.get(intentId), undefined);
  assert.equal((await restarted.getReceipt(intentId))?.nativeId, 'early');
  now = 1_100;
  assert.equal(await restarted.getReceipt(intentId), undefined);
  await restarted.pruneExpired(now);
  assert.deepEqual(await storage.get(null), {});
});

 test('consumer-owned identity survives TTL and another producer until durable acknowledgement', async () => {
  const storage = new MemoryStorageArea();
  const producer = createBookmarkCreatePlacementStore({ storage, now: () => 1000, randomUUID: () => intentId, retainForConsumer: true });
  await producer.reserve(input); await producer.complete(intentId, 'native-saved');
  const later = storeAt(storage, 1000 + 2 * 86400000, [secondIntentId]);
  await later.reserve(input);
  assert.equal((await later.getReceipt(intentId))?.nativeId, 'native-saved');
  await later.acknowledge(intentId); await later.pruneExpired(1000 + 2 * 86400000);
  assert.equal(await later.getReceipt(intentId), undefined);
});

test('retained identity survives the normal placement TTL before the retention bound', async () => {
  const storage = new MemoryStorageArea();
  const store = createBookmarkCreatePlacementStore({ storage, now: () => 1_000, ttlMs: 100, retainTtlMs: 10_000,
    randomUUID: () => intentId, retainForConsumer: true });
  await store.reserve(input); await store.complete(intentId, 'native-saved');
  const later = createBookmarkCreatePlacementStore({ storage, now: () => 5_000, ttlMs: 100, retainTtlMs: 10_000 });
  assert.equal((await later.getReceipt(intentId))?.nativeId, 'native-saved');
});

test('an abandoned reservation is reclaimed once the retention bound passes', async () => {
  const storage = new MemoryStorageArea();
  const store = createBookmarkCreatePlacementStore({ storage, now: () => 1_000, ttlMs: 100, retainTtlMs: 1_000,
    randomUUID: () => intentId, retainForConsumer: true });
  await store.reserve(input);
  assert.equal((await store.get(intentId))?.state, 'reserved');
  // Another producer's ordinary prune is what runs the retention GC.
  const later = createBookmarkCreatePlacementStore({ storage, now: () => 2_500, ttlMs: 100, retainTtlMs: 1_000,
    randomUUID: () => secondIntentId });
  await later.reserve({ ...input, title: 'Another title' });
  assert.equal(await later.get(intentId), undefined);
  assert.deepEqual(Object.keys(await storage.get(null)).filter(key => key.includes(intentId)), []);
});

test('an abandoned capture does not poison a later identical create', async () => {
  const storage = new MemoryStorageArea();
  const store = createBookmarkCreatePlacementStore({ storage, now: () => 1_000, ttlMs: 100, retainTtlMs: 1_000,
    randomUUID: () => intentId, retainForConsumer: true });
  await store.reserve(input);
  const later = createBookmarkCreatePlacementStore({ storage, now: () => 2_500, ttlMs: 100, retainTtlMs: 1_000,
    randomUUID: () => secondIntentId, retainForConsumer: true });
  await later.reserve(input);
  const consumed = await later.consumeForCreated({ id: 'native-later', parentId: 'parent-1', index: 0,
    title: input.title, url: input.url });
  assert.equal(consumed?.state, 'ready');
  assert.equal(consumed?.state === 'ready' ? consumed.intent.intentId : undefined, secondIntentId);
});
