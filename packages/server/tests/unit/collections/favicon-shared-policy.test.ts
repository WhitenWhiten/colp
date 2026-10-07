import { expect, test } from 'vitest';
import { KNOWN_FAVICON_DOMAINS, knownFaviconForUrl } from '../../../src/modules/collections/application/favicon-known-domains.js';
import { faviconRetryAfterMs, FaviconProviderThrottled } from '../../../src/modules/collections/application/favicon-fetch-deferred.js';
import { loadSharedFaviconConfig } from '../../../src/bootstrap/config-favicon-shared.js';
import { fetchFaviconImage } from '../../../src/infrastructure/collections/favicon-fetch.js';

test('catalog has at least 500 unique hosts and only explicit www aliases', () => {
  expect(KNOWN_FAVICON_DOMAINS.length).toBeGreaterThanOrEqual(500);
  expect(new Set(KNOWN_FAVICON_DOMAINS).size).toBe(KNOWN_FAVICON_DOMAINS.length);
  for (const hostname of KNOWN_FAVICON_DOMAINS) {
    expect(new URL(`https://${hostname}`).hostname).toBe(hostname);
    expect(knownFaviconForUrl(`https://${hostname}/path?q=1`)).toBe(hostname);
  }
  expect(knownFaviconForUrl('https://WWW.YouTube.com./watch?v=x')).toBe('youtube.com');
  expect(knownFaviconForUrl('https://news.ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
  expect(knownFaviconForUrl('https://unknown.google.com')).toBeNull();
  expect(knownFaviconForUrl('https://google.com.attacker.com')).toBeNull();
  expect(knownFaviconForUrl('file://google.com')).toBeNull();
  expect(knownFaviconForUrl('not a URL')).toBeNull();
});

test('Retry-After handles seconds, dates and malformed input', () => {
  const now = Date.parse('2026-09-22T00:00:00Z');
  expect(faviconRetryAfterMs('120', now)).toBe(120000);
  expect(faviconRetryAfterMs('Tue, 22 Sep 2026 00:05:00 GMT', now)).toBe(300000);
  expect(faviconRetryAfterMs('Tue, 22 Sep 2026 00:00:00 GMT', now)).toBe(0);
  expect(faviconRetryAfterMs('invalid', now)).toBeNull();
  expect(faviconRetryAfterMs(null, now)).toBeNull();
});

test('shared config defaults to monthly favicone refreshes and 10 second spacing', () => {
  expect(loadSharedFaviconConfig({})).toEqual({
    providerTemplate: 'https://favicone.com/{hostname}',
    refreshIntervalMs: 2592000000,
    providerIntervalMs: 10000,
  });
  expect(() => loadSharedFaviconConfig({ FAVICON_PROVIDER_INTERVAL_MS: '0' })).toThrow();
  expect(() => loadSharedFaviconConfig({ FAVICON_SHARED_REFRESH_INTERVAL_SECONDS: 'nan' })).toThrow();
  expect(() => loadSharedFaviconConfig({ FAVICON_SHARED_PROVIDER_TEMPLATE: 'http://127.0.0.1/{hostname}' })).toThrow();
});

test('real fetch transport preserves provider 429 and Retry-After for durable scheduling', async () => {
  await expect(fetchFaviconImage({
    url: 'https://favicone.com/google.com', timeoutMs: 1000, maxBytes: 65536,
    maxDecompressedBytes: 65536 * 64, maxRedirects: 3,
    resolve: async () => ['93.184.216.34'],
    connect: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '900' } }),
  })).rejects.toEqual(new FaviconProviderThrottled('900'));
});
