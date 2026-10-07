/**
 * Single accept matrix for Known-Backend bookmark URLs.
 * Other layers must not duplicate these cases; they call the collections facade.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CollectionsError,
  acceptBookmarkUrl,
  assertValidHttpUrlNoUserInfo,
  isAcceptedBookmarkUrl,
  normalizeBookmarkUrl,
} from '../../../src/modules/collections/index.js';

const ACCEPTED = [
  ['https', 'https://example.com/path'],
  ['http', 'http://example.com/path'],
  ['preserves original case, query, and fragment', 'HTTP://Example.COM/Path?q=1#frag'],
  ['non-default port', 'https://example.com:8443/x'],
  ['root path', 'https://example.com/'],
] as const;

const REJECTED = [
  ['userinfo user:pass', 'https://user:pass@example.com/path'],
  ['userinfo user@', 'https://user@example.com/'],
  ['whitespace in path', 'https://example.com/has space'],
  ['leading whitespace', ' https://example.com/'],
  ['too short', 'http://'],
  ['empty', ''],
  ['overlong', `https://example.com/${'x'.repeat(4100)}`],
  ['ftp', 'ftp://example.com/x'],
  ['no host', 'https://'],
  ['file', 'file:///etc/passwd'],
  ['javascript', 'javascript:alert(1)'],
  ['relative', '/relative/path'],
  ['protocol-relative', '//example.com/path'],
  ['unparseable', 'not a url'],
] as const;

function expectInvalidNodeUrl(run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    return error instanceof CollectionsError && error.code === 'invalid_node_url';
  });
}

describe('acceptBookmarkUrl', () => {
  test('accepts http/https and preserves the original string', () => {
    for (const [, url] of ACCEPTED) {
      assert.equal(acceptBookmarkUrl(url), url, url);
      assert.equal(isAcceptedBookmarkUrl(url), true, url);
    }
  });

  test('rejects userinfo, whitespace, length, ftp, no host, and non-http schemes', () => {
    for (const [, url] of REJECTED) {
      expectInvalidNodeUrl(() => acceptBookmarkUrl(url));
      assert.equal(isAcceptedBookmarkUrl(url), false, url);
    }
  });

  test('isAcceptedBookmarkUrl is a non-throwing predicate for non-strings', () => {
    assert.equal(isAcceptedBookmarkUrl(null), false);
    assert.equal(isAcceptedBookmarkUrl(undefined), false);
    assert.equal(isAcceptedBookmarkUrl(123), false);
  });

  test('assertValidHttpUrlNoUserInfo is a thin alias with the same error code', () => {
    const raw = 'HTTP://Example.COM/Path?q=1#frag';
    assert.equal(assertValidHttpUrlNoUserInfo(raw), raw);
    expectInvalidNodeUrl(() => assertValidHttpUrlNoUserInfo('ftp://example.com/x'));
  });

  test('accept does not apply link-health normalize rewrites', () => {
    const raw = 'HTTP://Example.COM/Path?q=1#frag';
    assert.equal(acceptBookmarkUrl(raw), raw);
    assert.equal(normalizeBookmarkUrl(raw), 'http://example.com/Path?q=1');
  });
});
