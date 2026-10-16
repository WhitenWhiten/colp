import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ privateNative: new Set<string>() }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ assertPersonalNativeAllowed: async () => {} }));
vi.mock('../src/sw/capture-native.js', () => ({ assertCaptureScope: async () => {} }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => ({}) }));
vi.mock('../src/sw/runtime.js', () => ({ syncState: {} }));
vi.mock('../src/bookmark-event-ingress.js', () => ({ resolveIngressBoundary: async () => ({ selectedNative: new Set(['bar']), privateNative: f.privateNative }) }));
vi.mock('../src/bookmark-folder-policy.js', () => ({ isUnsupportedBookmarkFolder: async () => false }));
import { captureTarget } from '../src/sw/capture-target.js';
afterEach(() => vi.unstubAllGlobals());
it.each([{ excluded: [] }, { excluded: ['excluded'] }, { excluded: ['child'] }, { excluded: ['unrelated'] }])('capture applies the actual exclusion boundary %j', async ({ excluded }) => {
  f.privateNative = new Set(excluded);
  const nodes = [ { id: 'bar', title: 'Bookmarks bar', parentId: '0' },
    { id: 'excluded', title: 'Private', parentId: 'bar' }, { id: 'child', title: 'Child', parentId: 'excluded' } ];
  vi.stubGlobal('chrome', { bookmarks: { get: async (id: string) => nodes.filter(node => node.id === id) },
    storage: { local: { get: async () => ({}) } } });
  const target = await captureTarget({ serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'library', authorityGeneration: 1 }, 'child');
  expect(target.inRange).toBe(excluded.length === 0 || excluded[0] === 'unrelated');
});
