import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { validCaptureRequest } from '../src/capture/messages.js';
import { transitionCapture } from '../src/capture/state.js';
import { captureHistoryStatus } from '../src/capture/history.js';
import { createCaptureStore, type CaptureStore } from '../src/capture/store.js';
import type { CaptureTask } from '../src/capture/contracts.js';
import { task } from './fixtures/capture.js';

vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureOwner: async () => {} }));
vi.mock('../src/sw/runtime.js', () => ({ workCoordinator: { run: async (_lane: string, work: () => unknown) => work() } }));

import { cancelRemovedCapture } from '../src/sw/capture-remove.js';

const id = '12345678-1234-4123-8123-123456789abc';
const scope = { accountId: 'a', serverOrigin: 'https://known.test', authorityGeneration: 1, collectionId: 'c' };
const saved = (over: Partial<CaptureTask> = {}): CaptureTask => ({ ...task, captureId: id, scope, save: 'local-saved', nativeId: '42',
  classification: 'applied', sync: 'confirmed', ...over });
let ledger: CaptureStore;
let nodes: Record<string, unknown[]>;

beforeEach(async () => {
  ledger = createCaptureStore(new IDBFactory());
  nodes = {};
  vi.stubGlobal('chrome', { bookmarks: { get: vi.fn(async (nativeId: string) => { if (!nodes[nativeId]) throw new Error('No node'); return nodes[nativeId]; }) } });
});
afterEach(() => { vi.unstubAllGlobals(); });

test('the remove request carries only the capture id and a user gesture', () => {
  expect(validCaptureRequest({ kind: 'known.capture.remove', captureId: id, userGesture: true })).toBe(true);
  expect(validCaptureRequest({ kind: 'known.capture.remove', captureId: id })).toBe(false);
  expect(validCaptureRequest({ kind: 'known.capture.remove', captureId: 'nope', userGesture: true })).toBe(false);
  expect(validCaptureRequest({ kind: 'known.capture.remove', captureId: id, userGesture: true, commandId: id })).toBe(false);
});

test('cancelling is allowed for a saved capture but not for an unknown native outcome', () => {
  expect(transitionCapture(saved(), { kind: 'cancelled' }, 5)).toMatchObject({ disposition: 'cancelled', save: 'local-saved', revision: saved().revision + 1 });
  expect(transitionCapture({ ...task }, { kind: 'cancelled' }, 5).disposition).toBe('cancelled');
  expect(() => transitionCapture(saved({ save: 'unknown' }), { kind: 'cancelled' }, 5)).toThrow('capture_already_submitted');
});

test('a removed capture leaves the in-progress and saved counts in History as completed and cancelled', () => {
  expect(captureHistoryStatus(saved({ sync: 'pending' }))).toBe('progress');
  expect(captureHistoryStatus(transitionCapture(saved({ sync: 'pending' }), { kind: 'cancelled' }, 5))).toBe('completed');
});

test('once the bookmark is gone the capture ends as cancelled and stays that way when repeated', async () => {
  const original = saved();
  await ledger.claim(original);
  const first = await cancelRemovedCapture(original, ledger, scope);
  expect(first.disposition).toBe('cancelled');
  expect((await ledger.get(scope, id))?.disposition).toBe('cancelled');
  const again = await cancelRemovedCapture(first, ledger, scope);
  expect(again.revision).toBe(first.revision);
});

test('a bookmark that still exists is refused and the capture is left alone', async () => {
  const original = saved();
  await ledger.claim(original);
  nodes['42'] = [{ id: '42' }];
  await expect(cancelRemovedCapture(original, ledger, scope)).rejects.toThrow('capture_bookmark_still_present');
  expect((await ledger.get(scope, id))?.disposition).toBe('new');
});

test('a capture that never saved a bookmark cannot be cancelled this way', async () => {
  const original = saved({ save: 'unsubmitted', nativeId: null });
  await ledger.claim(original);
  await expect(cancelRemovedCapture(original, ledger, scope)).rejects.toThrow('capture_remove_unavailable');
});
