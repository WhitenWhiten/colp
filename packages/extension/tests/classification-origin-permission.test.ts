import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { RUNTIME_ORIGIN_KEY } from '../src/config.js';
import { releaseClassificationOrigin } from '../src/classification-origin-permission.js';
import { releaseStaleClassificationOrigin, LOCAL_CLASSIFICATION_GRANTED_ORIGIN } from '../src/classification-local-session.js';

afterEach(() => vi.unstubAllGlobals());

test('changing only the AI port keeps the newly granted host permission', async () => {
  const local = new MemoryStorageArea(), remove = vi.fn(async () => true);
  await local.set({ [LOCAL_CLASSIFICATION_GRANTED_ORIGIN]: 'http://localhost:8000/*' });
  vi.stubGlobal('chrome', { storage: { local }, permissions: { remove } });
  await releaseStaleClassificationOrigin('http://localhost:9000/*');
  expect(remove).not.toHaveBeenCalledWith({ origins: ['http://localhost:8000/*'] });
  expect((await local.get(LOCAL_CLASSIFICATION_GRANTED_ORIGIN))[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]).toBe('http://localhost:9000/*');
});

test.each(['runtime', 'managed'])('AI cleanup preserves a shared %s server grant across ports', async owner => {
  const local = new MemoryStorageArea(), origin = 'https://home.example:8443', pattern = 'https://home.example:9000/*';
  await local.set({ [RUNTIME_ORIGIN_KEY]: owner === 'runtime' ? origin : 'https://old.example',
    [LOCAL_CLASSIFICATION_GRANTED_ORIGIN]: pattern });
  const removed: string[] = [];
  vi.stubGlobal('chrome', { storage: { local, managed: { get: async () => owner === 'managed' ? { serverOrigin: origin } : {} } },
    permissions: { remove: async ({ origins }: { origins: string[] }) => { removed.push(...origins); return true; } } });
  // Both probe cleanup and a saved-provider switch must respect the other owner.
  await releaseClassificationOrigin(pattern);
  await releaseStaleClassificationOrigin('');
  expect(removed).not.toContain(pattern);
  expect((await local.get(LOCAL_CLASSIFICATION_GRANTED_ORIGIN))[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]).toBeUndefined();
  // Once the server is gone the same origin can actually be released.
  await local.remove(RUNTIME_ORIGIN_KEY);
  chrome.storage.managed.get = async () => ({});
  await releaseClassificationOrigin(pattern);
  expect(removed).toContain(pattern);
});
