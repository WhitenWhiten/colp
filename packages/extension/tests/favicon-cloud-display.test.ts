import { beforeEach, afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ source: vi.fn(), scope: vi.fn(), excluded: vi.fn() }));
vi.mock('../src/favicon-helper-client.js', () => ({ fetchExtensionFaviconSource: mocks.source }));
vi.mock('../src/cloud-capability.js', () => ({ loadManifestCloud: async () => true }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ isSubscriptionExcluded: mocks.excluded }));
vi.mock('../src/sw/runtime.js', () => ({ extensionOrigin: () => 'chrome-extension://test',
  syncState: { getMappingByNativeId: async () => ({ colpId: 'node' }) } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: mocks.scope,
  loadConfig: async () => ({ serverOrigin: 'https://known.example' }),
  pushSessionAuthority: async () => ({ credential: { accessToken: 'token' } }) }));
import { readCloudDisplayFavicon } from '../src/sw/favicon-display.js';
const page = 'https://example.test/a';
const iconUrl = 'https://known.example/api/v1/favicon/01234567-89ab-4cde-8f01-23456789abcd';
beforeEach(() => {
  vi.clearAllMocks(); mocks.scope.mockResolvedValue({ accountId: 'a', collectionId: 'c' });
  mocks.excluded.mockResolvedValue(false);
  mocks.source.mockResolvedValue({ source: { effectiveMode: 'uploaded', iconUrl } });
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ url: page }] } });
});
afterEach(() => vi.unstubAllGlobals());
test('reads authorized uploaded icons and honors explicit suppression', async () => {
  expect(await readCloudDisplayFavicon('1', page)).toEqual({ ok: true, suppressed: false, iconUrl });
  mocks.source.mockResolvedValue({ source: { effectiveMode: 'none', iconUrl } });
  expect(await readCloudDisplayFavicon('1', page)).toEqual({ ok: true, suppressed: true, iconUrl: null });
});
test('rejects website URLs, account changes and outdated bookmark URLs', async () => {
  mocks.source.mockResolvedValueOnce({ source: { effectiveMode: 'online', iconUrl: 'https://third-party.test/favicon.ico' } });
  expect(await readCloudDisplayFavicon('1', page)).toEqual({ ok: false });
  mocks.scope.mockResolvedValueOnce({ accountId: 'a', collectionId: 'c' }).mockResolvedValueOnce({ accountId: 'b', collectionId: 'c' });
  expect(await readCloudDisplayFavicon('1', page)).toEqual({ ok: false });
  mocks.source.mockClear();
  expect(await readCloudDisplayFavicon('1', page + 'changed')).toEqual({ ok: false });
  expect(mocks.source).not.toHaveBeenCalled();
});
