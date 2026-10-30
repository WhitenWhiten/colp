import { afterEach, expect, test, vi } from 'vitest';
import { bookmarkFaviconSources } from '../src/bookmark-favicon-sources.js';
afterEach(() => vi.unstubAllGlobals());
test('site imports reuse the browser site icon without contacting the site', () => {
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://test${p}` } });
  const sources = bookmarkFaviconSources('https://www.bilibili.com/video/av123');
  expect(new URL(sources[0]!).searchParams.get('pageUrl')).toBe('https://www.bilibili.com/');
  expect(sources.every(s => s.startsWith('chrome-extension://'))).toBe(true);
  expect(bookmarkFaviconSources('javascript:alert(1)')).toEqual([]);
});
