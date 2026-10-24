import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, expect } from 'vitest';
import { createCaptureStore } from '../src/capture/store.js';
import { createPlannedCaptureTask } from '../src/capture/planned-task.js';
import { classificationTriggerReason } from '../src/classification-intent.js';
import { plannedPayloadDigest } from '../src/capture/planned.js';
import { transitionCapture } from '../src/capture/state.js';
import { createBookmarkCreatePlacementStore } from '../src/bookmark-create-placement.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import type { PlannedNativeCommand } from '../src/site-adapters/planned-types.js';
const command = (): PlannedNativeCommand => ({ commandId: crypto.randomUUID(), kind: 'bookmark', ownerId: 'owner', logicalDigest: 'logical', connectionId: 'connection',
  parent: { kind: 'folder', nativeId: 'parent', dateAdded: 1, deviceId: 'device', bindingId: 'parent', proof: { kind: 'explicitAdoption', id: 'adoption' } },
  title: 'Video', deviceId: 'device', bookmark: { planId: 'plan', effectId: 'effect', url: 'https://www.bilibili.com/video/av1', source: 'site-favorite',
    scope: { serverOrigin: 'https://known.test', accountId: null, authorityGeneration: 1, collectionId: null }, representation: { connectionId: 'connection', itemId: 'video:av:1', purpose: 'sourceArchive', sourceCollectionId: '101', mountId: 'mount' } } });
test('planned source capture never inherits popup auto-save, folder/tag classification or billing', () => {
  const task = createPlannedCaptureTask(command(), 'resolved');
  expect(task).toMatchObject({ automaticIntent: false, classification: 'none', saveAnother: true, sync: 'local-only', targetNativeId: 'parent' });
  expect(task.automation).toBeUndefined(); expect(task.local).toBeUndefined(); expect(task.billingAuthorization).toBeUndefined();
  expect(classificationTriggerReason({ kind: 'saved-capture', task: { ...task, automaticIntent: true, save: 'local-saved', classification: 'waiting' } })).toBe('capture_not_ready');
  expect(() => transitionCapture({ ...task, save: 'local-saved', automaticIntent: true }, { kind: 'classifying', executionId: 'e', controlGeneration: 0 }, 10)).toThrow('capture_classification_forbidden');
});
test('full planned command comparison covers title, purpose, representation, placement and authorization', async () => {
  const store = createCaptureStore(new IDBFactory()), task = createPlannedCaptureTask(command(), 'resolved'); await store.claim(task);
  expect((await store.claim({ ...task, captureId: crypto.randomUUID() })).captureId).toBe(task.captureId);
  for (const changed of [{ ...task, title: 'Other' }, { ...task, planned: { ...task.planned!, resolvedDigest: 'other' } },
    { ...task, planned: { ...task.planned!, representation: { ...task.planned!.representation, sourceCollectionId: '102' } } },
    { ...task, insertPosition: 'top' as const }]) await expect(store.claim(changed)).rejects.toThrow('capture_command_reused');
});
test('same URL in separate planned representations never coalesces through active URL keys', async () => {
  const store = createCaptureStore(new IDBFactory()), first = createPlannedCaptureTask(command(), 'one'), second = createPlannedCaptureTask(command(), 'two');
  const results = await Promise.all([store.claim(first), store.claim(second)]); expect(results[0]!.captureId).not.toBe(results[1]!.captureId);
});
test('source acknowledgment controls pruning and command receipts survive history pruning', async () => {
  const store = createCaptureStore(new IDBFactory()), task = createPlannedCaptureTask(command(), 'resolved'); await store.claim(task);
  const pending = transitionCapture(task, { kind: 'submitted', intentId: crypto.randomUUID() }, task.createdAt + 1); await store.update(pending, task.revision);
  const saved = transitionCapture(pending, { kind: 'saved', nativeId: 'native', nativeDateAdded: 10,
    location: { nativeId: 'native', collectionId: null, collectionTitle: null, nodeId: null, writable: true, url: task.url, path: ['Folder'] }, sync: 'local-only' }, task.createdAt + 2);
  await store.update(saved, pending.revision); const later = task.createdAt + 100 * 86400000;
  expect(await store.prune(task.scope, later)).toBe(0);
  await store.acknowledgePlanned(task.commandId, 'resolved'); expect(await store.prune(task.scope, later)).toBe(1);
  expect(await store.get(task.scope, task.captureId)).toBeNull(); expect((await store.plannedCommand(task.commandId))?.task?.nativeId).toBe('native');
  expect((await store.claim(task)).nativeId).toBe('native');
});
test('folder intents block any replacement create after submission or unknown native result', async () => {
  const store = createCaptureStore(new IDBFactory()), payload = { parent: 'root', title: 'Collection' }, digest = plannedPayloadDigest(payload); await store.claimFolder('folder', payload, digest);
  await store.updateFolder('folder', 'reserved', 'submitted'); await store.updateFolder('folder', 'submitted', 'unknown');
  expect((await store.claimFolder('folder', payload, digest)).state).toBe('unknown');
  await expect(store.claimFolder('folder', { parent: 'root', title: 'Other' }, 'changed')).rejects.toThrow('capture_command_reused');
  await expect(store.updateFolder('folder', 'unknown', 'reserved')).rejects.toThrow();
});
test('consumer-owned source native receipts outlive the old TTL until explicit source acknowledgment', async () => {
  const storage = new MemoryStorageArea(); let now = 100;
  const placements = createBookmarkCreatePlacementStore({ storage, now: () => now, retainForConsumer: true, retainUntilAcknowledged: true });
  const intent = await placements.reserve({ mode: 'bottom', targetParentNativeId: 'parent', batchId: crypto.randomUUID(), batchOrder: 0, batchSize: 1, title: 'Video', url: 'https://www.bilibili.com/video/av1', expectedIndex: 0 });
  await placements.bind(intent.intentId, 'native', 100); await placements.complete(intent.intentId, 'native'); now += 100 * 86400000;
  await createBookmarkCreatePlacementStore({ storage, now: () => now }).pruneExpired(now);
  expect(await placements.getReceipt(intent.intentId)).toMatchObject({ nativeId: 'native', nativeDateAdded: 100 });
  await placements.acknowledge(intent.intentId); await placements.pruneExpired(now); expect(await placements.getReceipt(intent.intentId)).toBeUndefined();
});
test('v3 capture migration preserves legacy pending tasks while adding planned command retention', async () => {
  const { task } = await import('./fixtures/capture.js');
  const { captureScopeKey, captureOwnerKey } = await import('../src/capture/contracts.js');
  const factory = new IDBFactory(), scopeKey = captureScopeKey(task.scope), ownerKey = captureOwnerKey(task.scope);
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open('known-capture', 3); r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    r.onupgradeneeded = () => {
      const tasks = r.result.createObjectStore('tasks', { keyPath: ['scopeKey', 'captureId'] });
      tasks.createIndex('command', ['scopeKey', 'commandId'], { unique: true }); tasks.createIndex('active', 'activeKey', { unique: true });
      tasks.createIndex('history', ['scopeKey', 'createdAt', 'captureId']); tasks.createIndex('ownerHistory', ['ownerKey', 'createdAt', 'captureId']);
      tasks.createIndex('ownerId', ['ownerKey', 'captureId'], { unique: true }); tasks.createIndex('ownerSaveUrl', ['ownerKey', 'url', 'save']);
      const commands = r.result.createObjectStore('commands', { keyPath: ['scopeKey', 'commandId'] }); commands.createIndex('capture', ['scopeKey', 'captureId']);
      const feedback = r.result.createObjectStore('feedback', { keyPath: ['scopeKey', 'eventId'] }); feedback.createIndex('owner', 'ownerKey'); feedback.createIndex('capture', ['scopeKey', 'captureId']);
      r.result.createObjectStore('gc', { keyPath: 'ownerKey' });
      tasks.add({ ...task, scopeKey, ownerKey, activeKey: JSON.stringify([scopeKey, task.url]) }); commands.add({ scopeKey, commandId: task.commandId, captureId: task.captureId });
    };
  });
  legacy.close(); const store = createCaptureStore(factory); expect(await store.get(task.scope, task.captureId)).toEqual(task);
  const planned = createPlannedCaptureTask(command(), 'resolved'); expect(await store.claim(planned)).toEqual(planned);
});
