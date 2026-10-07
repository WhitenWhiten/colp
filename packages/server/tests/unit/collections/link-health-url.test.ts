import assert from 'node:assert/strict';
import { test } from 'vitest';
import { hostnameFromBookmarkUrl, normalizeBookmarkUrl } from '../../../src/modules/collections/index.js';

test('normalizeBookmarkUrl accepts http/https, lowercases host, and strips fragment and default ports', () => {
  assert.equal(normalizeBookmarkUrl('https://Example.COM/path/?q=1#frag'), 'https://example.com/path?q=1');
  assert.equal(normalizeBookmarkUrl('http://example.com:80/x'), 'http://example.com/x');
  assert.equal(normalizeBookmarkUrl('https://example.com:443/x'), 'https://example.com/x');
  assert.equal(normalizeBookmarkUrl('https://example.com:8443/x'), 'https://example.com:8443/x');
});

test('normalizeBookmarkUrl strips a trailing slash only when the path is longer than one character', () => {
  assert.equal(normalizeBookmarkUrl('https://example.com/'), 'https://example.com/');
  assert.equal(normalizeBookmarkUrl('https://example.com/docs/'), 'https://example.com/docs');
  assert.equal(normalizeBookmarkUrl('https://example.com/docs'), 'https://example.com/docs');
});

test('normalizeBookmarkUrl does not sort query keys and does not merge www', () => {
  assert.equal(
    normalizeBookmarkUrl('https://example.com/x?b=2&a=1'),
    'https://example.com/x?b=2&a=1',
  );
  assert.equal(normalizeBookmarkUrl('https://www.example.com/x'), 'https://www.example.com/x');
  assert.notEqual(
    normalizeBookmarkUrl('https://www.example.com/x'),
    normalizeBookmarkUrl('https://example.com/x'),
  );
});

test('normalizeBookmarkUrl returns null for userinfo, non-http schemes, and unparseable values', () => {
  assert.equal(normalizeBookmarkUrl('https://user:pass@example.com/x'), null);
  assert.equal(normalizeBookmarkUrl('ftp://example.com/x'), null);
  assert.equal(normalizeBookmarkUrl('not a url'), null);
  assert.equal(normalizeBookmarkUrl(''), null);
});

test('invalid URLs do not equal each other for duplicate detection', () => {
  assert.equal(normalizeBookmarkUrl('https://a@example.com/1'), null);
  assert.equal(normalizeBookmarkUrl('https://b@example.com/1'), null);
});

test('hostnameFromBookmarkUrl returns a lowercase host or undefined', () => {
  assert.equal(hostnameFromBookmarkUrl('https://Example.COM/x'), 'example.com');
  assert.equal(hostnameFromBookmarkUrl('not a url'), undefined);
});
