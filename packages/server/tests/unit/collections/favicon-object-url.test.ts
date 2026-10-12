import assert from 'node:assert/strict';
import { test } from 'vitest';
import { bookmarkIconUrlFromObjectId } from '../../../src/modules/collections/application/bookmark-icon-url.js';
import { assertSameOriginFaviconUrl } from '../../../src/modules/collections/domain/validation.js';

const ID = '01234567-89ab-4cde-8f01-23456789abcd';
test('stored icons work at self-hosted loopback and custom HTTPS origins', () => {
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000', 'https://colp.example:8443']) {
    assert.equal(bookmarkIconUrlFromObjectId(origin, ID), `${origin}/api/v1/favicon/${ID}`);
  }
});
test('favicon object URLs reject remote HTTP, cross-origin and URL credentials', () => {
  assert.throws(() => bookmarkIconUrlFromObjectId('http://colp.example', ID));
  for (const url of [`https://other.example/api/v1/favicon/${ID}`, `https://user@colp.example/api/v1/favicon/${ID}`, `https://colp.example/api/v1/favicon/${ID}?x=1`]) {
    assert.throws(() => assertSameOriginFaviconUrl(url, 'https://colp.example'));
  }
});
