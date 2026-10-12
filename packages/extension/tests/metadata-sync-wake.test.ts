import { expect, test, vi } from 'vitest';
import { createAuthorityFence, createExtensionWorkCoordinator } from '../src/authority-fence.js';
import { notifyBookmarkAnnotationChanged } from '../src/bookmark-annotation-notice.js';
import { notifyFolderDescriptionChanged } from '../src/folder-description-native.js';

const mocks = vi.hoisted(() => ({ wake: vi.fn(async () => undefined), coordinator: undefined as unknown }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: mocks.wake }));
vi.mock('../src/sw/runtime.js', () => ({ get workCoordinator() { return mocks.coordinator; } }));

const memory: Record<string, unknown> = {};
const coordinator = createExtensionWorkCoordinator(createAuthorityFence({
  get: async () => ({ ...memory }), set: async (items) => { Object.assign(memory, items); },
}));
mocks.coordinator = coordinator;
const { installWorkerMetadataWake } = await import('../src/sw/metadata-sync-wake.js');
installWorkerMetadataWake();
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a metadata edit made in the worker wakes sync once the local-bookmark work that made it is done', async () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => { throw new Error('no receiver'); }) } });
  let finish!: () => void;
  const pin = coordinator.run('local-bookmark', async () => {
    void notifyBookmarkAnnotationChanged('b1');
    void notifyBookmarkAnnotationChanged('b2');
    await new Promise<void>(resolve => { finish = resolve; });
  });
  await settle();
  // The pin is still being placed: sync must not take the native order yet.
  expect(mocks.wake).not.toHaveBeenCalled();
  finish(); await pin; await settle();
  expect(mocks.wake).toHaveBeenCalledTimes(1);
  expect(mocks.wake).toHaveBeenCalledWith('manual');

  void notifyBookmarkAnnotationChanged('b3'); await settle();
  expect(mocks.wake).toHaveBeenCalledTimes(2);
  // A folder description restored by the worker (delete undo) wakes sync the same way.
  void notifyFolderDescriptionChanged('f1'); await settle();
  expect(mocks.wake).toHaveBeenCalledTimes(3);
  vi.unstubAllGlobals();
});
