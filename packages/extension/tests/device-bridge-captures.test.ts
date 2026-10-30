import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCaptureStore, type CaptureStore } from '../src/capture/store.js';
import { task } from './fixtures/capture.js';
import type { BrowserRequest } from '../src/automation/device-bridge.js';
import type { SyncScope } from '../src/sync-state-store.js';
const f = vi.hoisted(() => ({ ledger: null as CaptureStore | null,
  scope: { serverOrigin: 'https://known.test', accountId: 'a', collectionId: 'c', authorityGeneration: 1 },
  preview: vi.fn(async () => ({ ok: true, result: { folder: null }, nativeFolder: null })) }));
vi.mock('../src/sw/capture.js', () => ({ get captureStore() { return f.ledger; } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope }));
vi.mock('../src/sw/capture-local.js', () => ({ retryLocalCaptureClassification: vi.fn() }));
vi.mock('../src/sw/classification-local.js', () => ({ runLocalClassification: f.preview }));
vi.mock('../src/sw/runtime.js', () => ({ workCoordinator: { run: async (_lane: string, work: (c: unknown) => unknown) => work({ generation: 1, signal: new AbortController().signal }) } }));
import { handleCaptureBridge } from '../src/sw/device-bridge-classification.js';
const sync = { ...f.scope, replicaId: 'replica' } as unknown as SyncScope;
const request = (operation: string, input: BrowserRequest['input'] = {}): BrowserRequest => ({ id: 'request', operation, input,
  replicaId: 'replica', collectionId: 'c', expiresAt: new Date(Date.now() + 60000).toISOString() });
const authorize = async () => {};
beforeEach(() => { f.ledger = createCaptureStore(new IDBFactory()); });
afterEach(async () => { await f.ledger?.close(); vi.clearAllMocks(); });
test('capture diagnostics paginate across other collections without leaking or skipping tasks', async () => {
  for (let i = 0; i < 26; i++) await f.ledger!.claim({ ...task, captureId: `capture-${i}`, commandId: `command-${i}`,
    url: `https://example.org/${i}`, createdAt: i, scope: { ...f.scope, collectionId: i >= 20 ? 'foreign' : 'c' } });
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const page = await handleCaptureBridge(request('classification.captures.list', cursor ? { cursor } : {}), sync, authorize) as { items: { id: string }[]; nextCursor: string | null };
    ids.push(...page.items.map(i => i.id)); cursor = page.nextCursor;
  } while (cursor);
  expect(new Set(ids).size).toBe(20); expect(ids).not.toContain('capture-25');
});
test('capture lookup rejects another account and another collection', async () => {
  await f.ledger!.claim({ ...task, scope: { ...f.scope, accountId: 'foreign' } });
  await expect(handleCaptureBridge(request('classification.captures.get', { captureId: task.captureId }), sync, authorize)).rejects.toThrow('capture_not_found');
});
test('an incoming preview reaches the configured browser provider without creating a bookmark', async () => {
  const bookmark = { title: 'New article', url: 'https://example.org/new' };
  await handleCaptureBridge(request('classification.preview', { bookmark, tags: false }), sync, authorize);
  expect(f.preview).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'bridge:request',
    document: expect.objectContaining({ bookmark: { ...bookmark, description: null }, requested: { folder: true, tags: false } }) }));
});
