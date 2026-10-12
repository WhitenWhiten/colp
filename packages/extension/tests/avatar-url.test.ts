import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parseHttpsAvatarUrl, parseRemoteAvatarUrl, parseTrustedAvatarUrl } from '../src/avatar-url.js';

describe('parseHttpsAvatarUrl', () => {
  test('accepts a product avatar path and a provider CDN photo', () => {
    assert.equal(
      parseHttpsAvatarUrl('https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000'),
      'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
    );
    assert.equal(
      parseHttpsAvatarUrl('https://lh3.googleusercontent.com/a/ACg8oc.png'),
      'https://lh3.googleusercontent.com/a/ACg8oc.png',
    );
  });

  test('rejects non-https, fragments, userinfo, and junk', () => {
    assert.equal(parseHttpsAvatarUrl('http://known.example/api/v1/avatar/x'), undefined);
    assert.equal(parseHttpsAvatarUrl('javascript:alert(1)'), undefined);
    assert.equal(parseHttpsAvatarUrl('https://known.example/photo#x'), undefined);
    assert.equal(parseHttpsAvatarUrl('https://user:pass@known.example/photo'), undefined);
    assert.equal(parseHttpsAvatarUrl('not a url'), undefined);
    assert.equal(parseHttpsAvatarUrl(null), undefined);
  });
});

describe('parseTrustedAvatarUrl', () => {
  test('accepts the product origin including local http with a port', () => {
    assert.equal(
      parseTrustedAvatarUrl(
        'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
        'https://known.example',
      ),
      'https://known.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
    );
    assert.equal(
      parseTrustedAvatarUrl(
        'http://127.0.0.1:4173/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
        'http://127.0.0.1:4173',
      ),
      'http://127.0.0.1:4173/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
    );
  });

  test('rejects a foreign origin even when the path looks like a product avatar', () => {
    assert.equal(
      parseTrustedAvatarUrl(
        'https://evil.example/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
        'https://known.example',
      ),
      undefined,
    );
  });

  test('parseRemoteAvatarUrl keeps provider CDN photos from /me', () => {
    assert.equal(
      parseRemoteAvatarUrl('https://lh3.googleusercontent.com/a/ada.png', 'https://known.example'),
      'https://lh3.googleusercontent.com/a/ada.png',
    );
  });
});
