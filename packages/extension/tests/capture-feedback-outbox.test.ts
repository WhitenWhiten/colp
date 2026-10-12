import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { createCaptureStore } from '../src/capture/store.js';
import { task } from './fixtures/capture.js';
it('atomically records feedback, prevents replay inflation, and persists the edit fence before replying', async () => {
  const store = createCaptureStore(new IDBFactory());
  await store.claim({ ...task, decisionId: 'd', appliedRevision: 'r', save: 'local-saved', classification: 'applied' });
  const event = { scope: task.scope, captureId: task.captureId, decisionId: 'd', nodeRevision: 'r',
    eventId: 'event', kind: 'explicit_negative' as const, occurredAt: 100, learningEligible: true, uploaded: false };
  const [first, replay] = await Promise.all([store.enqueueFeedback(event), store.enqueueFeedback(event)]);
  expect(first.manualFence).toBe(1); expect(replay.manualFence).toBe(1);
  expect(await store.pendingFeedback(task.scope)).toHaveLength(1);
  await store.enqueueFeedback({ ...event, eventId: 'weak', kind: 'implicit_positive' });
  expect((await store.get(task.scope, task.captureId))?.feedbackKind).toBe('explicit_negative');
  expect(await store.pendingFeedback({ ...task.scope, accountId: 'another' })).toEqual([]);
  expect((await store.prepareFeedback(event, 0)).expectedServerRevision).toBe(0);
  expect((await store.prepareFeedback(event, 5)).expectedServerRevision).toBe(0);
  await store.settleFeedback(event, { revision: 1 });
  expect((await store.get(task.scope, task.captureId))?.feedbackServerRevision).toBe(1);
  expect(await store.pendingFeedback(task.scope)).toHaveLength(1);
  await store.close();
});
