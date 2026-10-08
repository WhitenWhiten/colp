import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { BOOKMARK_PIN_EXTENSION, isBookmarkPinned, validBookmarkPinExtension } from '../../../src/modules/collections/index.js';

describe('bookmark pin extension', () => {
  test('reads presence of the exact value as pinned', () => {
    assert.equal(isBookmarkPinned({ [BOOKMARK_PIN_EXTENSION]: { pinned: true } }), true);
    assert.equal(isBookmarkPinned({}), false);
    assert.equal(isBookmarkPinned(undefined), false);
    assert.equal(isBookmarkPinned({ [BOOKMARK_PIN_EXTENSION]: { pinned: 'yes' } }), false);
  });

  test('allows absence anywhere and the pin only on bookmarks', () => {
    assert.equal(validBookmarkPinExtension('folder', { 'https://other.example/x': 1 }), true);
    assert.equal(validBookmarkPinExtension('bookmark', { [BOOKMARK_PIN_EXTENSION]: { pinned: true } }), true);
    assert.equal(validBookmarkPinExtension('folder', { [BOOKMARK_PIN_EXTENSION]: { pinned: true } }), false);
    assert.equal(validBookmarkPinExtension('bookmark', { [BOOKMARK_PIN_EXTENSION]: { pinned: true, at: 1 } }), false);
  });
});
