import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { BOOKMARK_FAVICON_MAX_BYTES, sniffBookmarkFaviconCanonicalMime } from '../src/favicon-sniff.js';
import { isBookmarkHostAllowedForAutoUpload } from '../src/favicon-host.js';
import { captureTabFavicon } from '../src/favicon-capture.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const ICO = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x01]);
const CUR = Uint8Array.from([0x00, 0x00, 0x02, 0x00]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML = new TextEncoder().encode('<!DOCTYPE html><html></html>');

describe('BF-06 favicon magic sniff', () => {
  test('accepts PNG JPEG WebP ICO and rejects CUR SVG GIF HTML empty', () => {
    assert.equal(sniffBookmarkFaviconCanonicalMime(PNG), 'image/png');
    assert.equal(sniffBookmarkFaviconCanonicalMime(JPEG), 'image/jpeg');
    assert.equal(sniffBookmarkFaviconCanonicalMime(WEBP), 'image/webp');
    assert.equal(sniffBookmarkFaviconCanonicalMime(ICO), 'image/x-icon');
    assert.equal(sniffBookmarkFaviconCanonicalMime(CUR), null);
    assert.equal(sniffBookmarkFaviconCanonicalMime(SVG), null);
    assert.equal(sniffBookmarkFaviconCanonicalMime(GIF), null);
    assert.equal(sniffBookmarkFaviconCanonicalMime(HTML), null);
    assert.equal(sniffBookmarkFaviconCanonicalMime(new Uint8Array()), null);
    assert.equal(BOOKMARK_FAVICON_MAX_BYTES, 65_536);
  });
});

describe('BF-06 bookmark host denylist (BF-05 copy)', () => {
  test('allows public DNS names and rejects localhost reserved suffixes and literal IPs', () => {
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://example.test/page'), true);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://github.com/x'), true);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://xn--fsq.com/path'), true);
    assert.equal(isBookmarkHostAllowedForAutoUpload('http://localhost/app'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://LOCALHOST/app'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('http://foo.local/x'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://printer.localhost/x'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://jira.internal/browse/1'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://wiki.corp/home'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://nas.home/share'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://router.lan/status'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('https://files.intranet/doc'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('http://127.0.0.1/'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('http://127.1/'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('http://2130706433/'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('http://0x7f000001/'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('http://[::1]/'), false);
    assert.equal(isBookmarkHostAllowedForAutoUpload('ftp://example.test/x'), false);
  });
});

describe('BF-06 gesture favicon fetch', () => {
  test('does not fetch chrome chrome-extension or data favIconUrl', async () => {
    const fetched: string[] = [];
    const fetchMock: typeof fetch = async (url) => {
      fetched.push(String(url));
      return new Response(PNG);
    };
    for (const favIconUrl of [
      'chrome://favicon/https://example.test/',
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/icon.png',
      'data:image/png;base64,iVBORw0KGgo=',
    ]) {
      const result = await captureTabFavicon({
        favIconUrl, tabUrl: 'https://example.test/page', fetch: fetchMock,
      });
      assert.equal(result, null, favIconUrl);
    }
    assert.deepEqual(fetched, []);
  });

  test('skips cross-origin favIconUrl without fetching it', async () => {
    const fetched: string[] = [];
    const result = await captureTabFavicon({
      favIconUrl: 'https://cdn.other.test/favicon.png',
      tabUrl: 'https://example.test/page',
      fetch: async (url) => { fetched.push(String(url)); return new Response(PNG); },
    });
    assert.equal(result, null);
    assert.deepEqual(fetched, []);
  });

  test('skips SVG bytes and bodies over 64 KiB', async () => {
    const oversized = new Uint8Array(BOOKMARK_FAVICON_MAX_BYTES + 1);
    oversized.set(PNG.subarray(0, 8));
    assert.equal(await captureTabFavicon({
      favIconUrl: 'https://example.test/icon.svg', tabUrl: 'https://example.test/page',
      fetch: async () => new Response(SVG, { headers: { 'content-type': 'image/svg+xml' } }),
    }), null);
    assert.equal(await captureTabFavicon({
      favIconUrl: 'https://example.test/huge.png', tabUrl: 'https://example.test/page',
      fetch: async () => new Response(oversized, { headers: { 'content-type': 'image/png' } }),
    }), null);
  });

  test('returns sniffed PNG for a same-origin http(s) raster under the cap', async () => {
    const result = await captureTabFavicon({
      favIconUrl: 'https://example.test/favicon.png',
      tabUrl: 'https://example.test/page',
      fetch: async () => new Response(PNG, { headers: { 'content-type': 'image/x-icon' } }),
    });
    assert.equal(result?.contentType, 'image/png');
    assert.deepEqual(result?.bytes, PNG);
  });
});
