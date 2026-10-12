import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { parsePopupDraft, POPUP_DRAFT_CACHE } from '../src/popup-draft.js';

const VALID = {
  url: 'https://example.com/article',
  title: 'Edited title',
  editedUrl: 'https://example.com/article?clean',
  newFolderName: 'Reading list',
  insertPosition: 'top' as const,
  updatedAt: 1_700_000_000_000,
};

describe('popup draft cache', () => {
  test('storage key is versioned', () => {
    assert.equal(POPUP_DRAFT_CACHE, 'known.popup.draft.v1');
  });

  test('round-trips a complete draft', () => {
    assert.deepEqual(parsePopupDraft(VALID), VALID);
  });

  test('binds the draft to the page it was typed on', () => {
    assert.deepEqual(parsePopupDraft(VALID, VALID.url), VALID);
    assert.equal(parsePopupDraft(VALID, 'https://other.example/page'), undefined);
  });

  test('rejects malformed values instead of restoring garbage', () => {
    assert.equal(parsePopupDraft(undefined), undefined);
    assert.equal(parsePopupDraft(null), undefined);
    assert.equal(parsePopupDraft('draft'), undefined);
    assert.equal(parsePopupDraft([VALID]), undefined);
    assert.equal(parsePopupDraft({ ...VALID, url: '' }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, title: 7 }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, editedUrl: undefined }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, newFolderName: null }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, insertPosition: 'middle' }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, updatedAt: Number.NaN }), undefined);
  });

  test('tags and note travel with the draft and stay optional for older drafts', () => {
    const withFields = { ...VALID, tags: ['a', 'b'], note: 'remember this' };
    assert.deepEqual(parsePopupDraft(withFields), withFields);
    assert.equal('tags' in parsePopupDraft(VALID)!, false);
    assert.equal('note' in parsePopupDraft(VALID)!, false);
  });

  test('rejects tags and notes that are the wrong shape or absurdly large', () => {
    assert.equal(parsePopupDraft({ ...VALID, tags: 'a,b' }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, tags: [1] }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, tags: Array.from({ length: 65 }, () => 'x') }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, note: 7 }), undefined);
    assert.equal(parsePopupDraft({ ...VALID, note: 'x'.repeat(32_769) }), undefined);
  });
});
