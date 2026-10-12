import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DEFAULT_BOOKMARK_PREFERENCES, bookmarkPreferencesScopeKey, defaultBookmarkPreferencesRecord,
  effectiveAiTagMode, parseBookmarkPreferencesCache, normalizeBookmarkPreferences,
} from '../src/bookmark-preferences.js';
import { validBookmarkPreferencesRequest } from '../src/sw/messages.js';

describe('bookmark preference cache identity', () => {
  test('defaults to bottom with folders first off, with server virtual revision zero', () => {
    assert.deepEqual(DEFAULT_BOOKMARK_PREFERENCES, { bookmarkInsertPosition: 'bottom', foldersFirst: false, captureMode: 'manual', resultPanelAutoDismissMs: 3000, learnFromCorrections: true, resumeClassificationWhenOnline: true, subscriptionOnUnfollow: 'keep', subscriptionOnUnsubscribe: 'keep', subscriptionDefaultCheckIntervalMinutes: 15, subscriptionDefaultDigestMode: 'latest', subscriptionDefaultEditionLimit: 10 });
    const record = defaultBookmarkPreferencesRecord('https://known.example/', 'user-a', 0);
    assert.equal(record.revision, '0');
    assert.equal(record.etag, '"0"');
    assert.equal(record.updatedAt, 0);
  });

  test('separates server origins, accounts, and the unlogged device record', () => {
    assert.notEqual(bookmarkPreferencesScopeKey('https://known.example', 'user-a'), bookmarkPreferencesScopeKey('https://known.example', 'user-b'));
    assert.notEqual(bookmarkPreferencesScopeKey('https://known.example', 'user-a'), bookmarkPreferencesScopeKey('https://other.example', 'user-a'));
    assert.notEqual(bookmarkPreferencesScopeKey('https://known.example', null), bookmarkPreferencesScopeKey('https://known.example', 'user-a'));
    assert.notEqual(bookmarkPreferencesScopeKey('https://known.example', null), bookmarkPreferencesScopeKey('https://known.example', 'device'));
  });

  test('rejects malformed or cross-account cache records', () => {
    const record = defaultBookmarkPreferencesRecord('https://known.example', 'user-a', 10);
    const key = bookmarkPreferencesScopeKey('https://known.example', 'user-a');
    assert.deepEqual(parseBookmarkPreferencesCache(record, key)?.value, record.value);
    assert.equal(parseBookmarkPreferencesCache(record, key)?.etag, record.etag);
    assert.equal(parseBookmarkPreferencesCache(record, bookmarkPreferencesScopeKey('https://known.example', 'user-b')), undefined);
    assert.equal(parseBookmarkPreferencesCache({ ...record, value: { bookmarkInsertPosition: 'middle', foldersFirst: true } }, key), undefined);
    assert.equal(parseBookmarkPreferencesCache({ ...record, pending: { commandId: 'not-a-uuid', value: record.value, ifMatch: record.etag, baseRevision: record.revision, updatedAt: 1 } }, key)?.pending, undefined);
  });

  test('accepts only the closed local preference read message', () => {
    assert.equal(validBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' }), true);
    assert.equal(validBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local', subject: 'other' }), false);
  });
});

test('legacy server normalization does not claim unsupported subscription preferences are synced', () => {
  const value = normalizeBookmarkPreferences({ bookmarkInsertPosition: 'bottom', foldersFirst: true });
  assert.equal(value?.subscriptionOnUnfollow, undefined);
  assert.equal(value?.subscriptionDefaultEditionLimit, undefined);
});

test('manual subscription polling is nullable and edition limits are strict', () => {
  const base = { kind: 'known.bookmark.preferences.update', userGesture: true };
  assert.equal(validBookmarkPreferencesRequest({ ...base, subscriptionDefaultCheckIntervalMinutes: null }), true);
  for (const limit of [0, 21, 1.5, '10', null]) {
    assert.equal(validBookmarkPreferencesRequest({ ...base, subscriptionDefaultEditionLimit: limit }), false);
  }
});

describe('tags from AI', () => {
  test('a chosen mode wins; unchosen, own-AI automatic saves keep adding tags and everything else suggests', () => {
    assert.equal(effectiveAiTagMode({ aiTagMode: 'off', captureMode: 'automatic' }, true), 'off');
    assert.equal(effectiveAiTagMode({ captureMode: 'automatic' }, true), 'add');
    assert.equal(effectiveAiTagMode({ captureMode: 'automatic' }, false), 'suggest');
    assert.equal(effectiveAiTagMode({ captureMode: 'manual' }, true), 'suggest');
    assert.equal(effectiveAiTagMode(undefined, true), 'suggest');
  });

  test('the mode is validated, kept when present and never invented', () => {
    assert.equal(normalizeBookmarkPreferences({ ...DEFAULT_BOOKMARK_PREFERENCES, aiTagMode: 'add' })?.aiTagMode, 'add');
    assert.equal(Object.hasOwn(normalizeBookmarkPreferences(DEFAULT_BOOKMARK_PREFERENCES)!, 'aiTagMode'), false);
    assert.equal(normalizeBookmarkPreferences({ ...DEFAULT_BOOKMARK_PREFERENCES, aiTagMode: 'auto' }), undefined);
    assert.equal(validBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true, aiTagMode: 'suggest' }), true);
    assert.equal(validBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.update', userGesture: true, aiTagMode: 'auto' }), false);
  });
});
