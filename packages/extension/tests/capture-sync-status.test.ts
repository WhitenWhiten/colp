import { expect, test, vi } from 'vitest';
import { task, location } from './fixtures/capture.js';
import { projectSyncStatus } from '../src/sync-status.js';
const status = vi.hoisted(() => vi.fn());
vi.mock('../src/sw/save-status.js', () => ({ handleSaveStatus: status }));
vi.mock('../src/sw/capture-native.js', async () => {
  const { task, location } = await import('./fixtures/capture.js');
  return { currentCaptureScope: async () => task.scope, assertCaptureScope: async () => {}, nativeCaptureLocation: async () => location };
});
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true, syncState: {} }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => { throw new Error('no_sync_read_needed'); } }));
import { reconcileCaptureSync } from '../src/sw/capture-sync.js';

test.each([['synced', 'confirmed'], ['review-conflicts', 'attention'], ['action-required', 'attention'], ['syncing', 'pending']] as const)(
  'capture reconciliation consumes %s identity even when its display copy is changed', async (kind, expected) => {
    status.mockResolvedValue({ ok: true, localOnly: false, status: { ...projectSyncStatus(kind), label: '本地化文案已变化' } });
    const update = vi.fn(), original = { ...task, save: 'local-saved' as const, nativeId: 'native', classification: 'none' as const, sync: 'local-only' as const };
    const result = await reconcileCaptureSync(original, { update, get: async () => original });
    expect(result).toMatchObject({ sync: expected, localLocation: location, revision: 1 });
    expect(update).toHaveBeenCalledWith(result, original.revision);
  });
