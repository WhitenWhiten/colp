// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../src/favicon-display-cache.js', () => ({ readDisplayFavicon: async () => 'data:image/png;base64,local' }));
import { faviconTile } from '../src/bookmark-manager-dom.js';
afterEach(() => vi.unstubAllGlobals());
test('server icon replaces device fallback and explicit none suppresses it', async () => {
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, iconUrl: 'https://known.example/api/v1/favicon/test' });
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://test${p}`, sendMessage } });
  const tile = faviconTile('https://example.test/a', 'native-1');
  await vi.waitFor(() => expect(tile.querySelector('img')?.src).toBe('https://known.example/api/v1/favicon/test'));
  expect(sendMessage).toHaveBeenCalledWith({ kind: 'known.favicon.display', nativeId: 'native-1', pageUrl: 'https://example.test/a' });
  sendMessage.mockResolvedValue({ ok: true, suppressed: true });
  const suppressed = faviconTile('https://example.test/a', 'native-1');
  await vi.waitFor(() => expect(suppressed.querySelector('img')).toBeNull());
});
test('local-only display needs no server lookup', async () => {
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://test${p}`, sendMessage } });
  const tile = faviconTile('https://example.test/a');
  await vi.waitFor(() => expect(tile.querySelector('img')?.src).toBe('data:image/png;base64,local'));
  expect(sendMessage).not.toHaveBeenCalled();
});
