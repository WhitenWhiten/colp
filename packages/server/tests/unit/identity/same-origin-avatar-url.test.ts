import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  IdentityError,
  assertSameOriginAvatarUrl,
} from '../../../src/modules/identity/index.js';

const PRODUCT_ORIGIN = 'https://app.example.test';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

/**
 * S8 (avatar audit #6): manually set avatar URLs are restricted to this
 * product's own public avatar route `{productOrigin}/api/v1/avatar/{uuid}`.
 * External https URLs (CDN/gravatar) must be rejected because rendering them
 * in other users' browsers leaks visitor IPs to the foreign host. The OIDC
 * claim path keeps the general assertValidAvatarUrl contract and is not
 * affected by this policy.
 */

function expectSameOriginRejection(avatarUrl: string, productOrigin = PRODUCT_ORIGIN): void {
  try {
    assertSameOriginAvatarUrl(avatarUrl, productOrigin);
    assert.fail(`expected IdentityError for avatarUrl ${JSON.stringify(avatarUrl)}`);
  } catch (error: unknown) {
    assert.ok(error instanceof IdentityError, `expected IdentityError, got ${String(error)}`);
    assert.equal(error.code, 'invalid_identity_input');
  }
}

describe('same-origin avatar URL policy (S8)', () => {
  test('accepts same-origin /api/v1/avatar/<uuid> URLs and returns the canonical form', () => {
    const url = `${PRODUCT_ORIGIN}/api/v1/avatar/${UUID}`;
    assert.equal(assertSameOriginAvatarUrl(url, PRODUCT_ORIGIN), url);
    // A productOrigin with a trailing slash normalizes to the same origin.
    assert.equal(assertSameOriginAvatarUrl(url, `${PRODUCT_ORIGIN}/`), url);
    // Uppercase hex UUIDs match the public GET route's case-insensitive pattern.
    const upper = `${PRODUCT_ORIGIN}/api/v1/avatar/${UUID.toUpperCase()}`;
    assert.equal(assertSameOriginAvatarUrl(upper, PRODUCT_ORIGIN), upper);
    // An explicit default port normalizes away and still matches.
    assert.equal(
      assertSameOriginAvatarUrl(`${PRODUCT_ORIGIN}:443/api/v1/avatar/${UUID}`, PRODUCT_ORIGIN),
      url,
    );
  });

  test('null and undefined pass through for the caller to decide preserve vs clear', () => {
    assert.equal(assertSameOriginAvatarUrl(null, PRODUCT_ORIGIN), null);
    assert.equal(assertSameOriginAvatarUrl(undefined, PRODUCT_ORIGIN), null);
  });

  test('rejects external https avatar URLs', () => {
    for (const url of [
      'https://cdn.example.test/avatar.png',
      'https://gravatar.com/x.png',
      'https://cdn.example.test/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
      `https://app.evil.test/api/v1/avatar/${UUID}`,
    ]) {
      expectSameOriginRejection(url);
    }
  });

  test('rejects same-origin URLs whose path is not /api/v1/avatar/<uuid>', () => {
    for (const url of [
      `${PRODUCT_ORIGIN}/api/v1/me`,
      `${PRODUCT_ORIGIN}/avatar/${UUID}`,
      `${PRODUCT_ORIGIN}/api/v1/avatar/not-a-uuid`,
      `${PRODUCT_ORIGIN}/api/v1/avatar/`,
      `${PRODUCT_ORIGIN}/api/v1/avatar`,
    ]) {
      expectSameOriginRejection(url);
    }
  });

  test('rejects same-origin host with a different protocol or port', () => {
    expectSameOriginRejection(`http://app.example.test/api/v1/avatar/${UUID}`);
    expectSameOriginRejection(`https://app.example.test:8443/api/v1/avatar/${UUID}`);
  });

  test('still enforces the strict HttpsUrl contract before the origin checks', () => {
    expectSameOriginRejection('javascript:alert(1)');
    expectSameOriginRejection('http://cdn.example.test/a.png');
    expectSameOriginRejection('https://user@cdn.example.test/a.png');
    expectSameOriginRejection(`https://cdn.example.test/${'a'.repeat(2049)}`);
    expectSameOriginRejection('');
  });

  test('rejects when productOrigin cannot be parsed as an origin', () => {
    expectSameOriginRejection(`${PRODUCT_ORIGIN}/api/v1/avatar/${UUID}`, 'not a url');
  });
});
