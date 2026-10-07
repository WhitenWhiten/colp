import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  GovernanceCatalogError,
  parseCatalogPatch,
  parseCatalogPreferencesPatch,
  parseLanguageQuery,
  readCatalogFromExtensions,
  mergeCatalogExtensions,
} from '../../../src/modules/governance/index.js';

test('empty CatalogPatch is invalid_request', () => {
  assert.throws(() => parseCatalogPatch({}), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_request'
  ));
});

test('tags=null is invalid_request and missing is distinct from empty array', () => {
  assert.throws(() => parseCatalogPatch({ tags: null }), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_request'
  ));
  const cleared = parseCatalogPatch({ tags: [] });
  assert.deepEqual(cleared.tags, []);
  assert.equal(Object.hasOwn(cleared, 'language'), false);
});

test('unknown CatalogPatch keys are rejected', () => {
  assert.throws(() => parseCatalogPatch({ tags: [], extra: true }), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_request'
  ));
});

test('tags are trimmed then NFC, case-sensitive deduped, and [] clears', () => {
  const nfc = 'e\u0301';
  const composed = nfc.normalize('NFC');
  const parsed = parseCatalogPatch({ tags: ['  Design ', nfc, 'Design', '  Design '] });
  assert.deepEqual(parsed.tags, ['Design', composed]);
});

test('language=null clears; structurally invalid BCP47 is never silently cleared', () => {
  assert.equal(parseCatalogPatch({ language: null }).language, null);
  assert.equal(parseCatalogPatch({ language: 'EN-us' }).language, 'en-US');
  assert.throws(() => parseCatalogPatch({ language: 'not a tag' }), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_request'
  ));
  assert.throws(() => parseCatalogPatch({ language: '' }), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_request'
  ));
});

test('readCatalogFromExtensions defaults empty tags and null language', () => {
  assert.deepEqual(readCatalogFromExtensions(undefined), { tags: [], language: null });
  assert.deepEqual(readCatalogFromExtensions({ tags: ['a'], language: 'zh-Hans' }), {
    tags: ['a'],
    language: 'zh-Hans',
  });
});

test('mergeCatalogExtensions replaces whole arrays and preserves other keys', () => {
  const merged = mergeCatalogExtensions(
    { tags: ['old'], language: 'en', note: 'keep' },
    { tags: [] },
  );
  assert.deepEqual(merged, { tags: [], language: 'en', note: 'keep' });
  const cleared = mergeCatalogExtensions(merged, { language: null });
  assert.deepEqual(cleared, { tags: [], note: 'keep' });
});

test('language query treats missing, empty, and invalid as distinct', () => {
  assert.equal(parseLanguageQuery(undefined), undefined);
  assert.throws(() => parseLanguageQuery(''), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_query'
  ));
  assert.throws(() => parseLanguageQuery(null), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_query'
  ));
  assert.equal(parseLanguageQuery('EN-us'), 'en-US');
  assert.throws(() => parseLanguageQuery('not a tag'), (error: unknown) => (
    error instanceof GovernanceCatalogError && error.code === 'invalid_query'
  ));
});

test('CatalogPreferencesPatch rejects null arrays, unknown keys, and empty patch', () => {
  assert.throws(() => parseCatalogPreferencesPatch({}), GovernanceCatalogError);
  assert.throws(() => parseCatalogPreferencesPatch({ hiddenTags: null }), GovernanceCatalogError);
  assert.throws(() => parseCatalogPreferencesPatch({ hiddenOwnerAccountIds: [' x '] }), GovernanceCatalogError);
  const parsed = parseCatalogPreferencesPatch({
    hiddenTitleKeywords: ['  Foo ', 'FOO'],
    preferredLanguages: ['EN', 'en-US'],
  });
  assert.deepEqual(parsed.hiddenTitleKeywords, ['foo']);
  assert.deepEqual(parsed.preferredLanguages, ['en', 'en-US']);
});
