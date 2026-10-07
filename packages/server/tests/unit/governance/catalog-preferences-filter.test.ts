import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isHiddenByCatalogPreferences,
  type CatalogDisplayTarget,
  type CatalogPreferencesView,
} from '../../../src/modules/governance/index.js';

const empty: CatalogPreferencesView = {
  hiddenOwnerAccountIds: [],
  hiddenTags: [],
  hiddenTitleKeywords: [],
  preferredLanguages: [],
  revision: '1',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function target(overrides: Partial<CatalogDisplayTarget> = {}): CatalogDisplayTarget {
  return {
    ownerAccountId: 'owner-1',
    tags: ['Design'],
    title: 'Systems Notes',
    language: 'en',
    ...overrides,
  };
}

test('anonymous-equivalent empty prefs hide nothing', () => {
  assert.equal(isHiddenByCatalogPreferences(target(), empty), false);
});

test('owner, tag, keyword, and preferred-language rules apply to the displayed target', () => {
  assert.equal(isHiddenByCatalogPreferences(target(), { ...empty, hiddenOwnerAccountIds: ['owner-1'] }), true);
  assert.equal(isHiddenByCatalogPreferences(target(), { ...empty, hiddenTags: ['Design'] }), true);
  assert.equal(isHiddenByCatalogPreferences(target({ tags: ['design'] }), { ...empty, hiddenTags: ['Design'] }), false);
  assert.equal(isHiddenByCatalogPreferences(target(), { ...empty, hiddenTitleKeywords: ['notes'] }), true);
  assert.equal(isHiddenByCatalogPreferences(target({ title: 'Other' }), { ...empty, hiddenTitleKeywords: ['notes'] }), false);
  assert.equal(isHiddenByCatalogPreferences(target({ language: null }), { ...empty, preferredLanguages: ['en'] }), true);
  assert.equal(isHiddenByCatalogPreferences(target({ language: 'fr' }), { ...empty, preferredLanguages: ['en'] }), true);
  assert.equal(isHiddenByCatalogPreferences(target({ language: 'en' }), { ...empty, preferredLanguages: ['en'] }), false);
});

test('empty preferredLanguages does not restrict unknown language', () => {
  assert.equal(isHiddenByCatalogPreferences(target({ language: null }), empty), false);
});
