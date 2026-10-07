import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildCollectionsSitemapUrlset,
  COLLECTIONS_SITEMAP_MAX_BYTES,
  COLLECTIONS_SITEMAP_MAX_URLS,
  collectionsSitemapLastmod,
  escapeSitemapXml,
  filterSearchIndexableSitemapEntries,
  isSearchIndexableVisibility,
  SEARCH_INDEXABLE_VISIBILITY,
} from '../../../src/infrastructure/http/index.js';
import { buildPublicationSitemapStatement } from '../../../src/infrastructure/publication/postgres-sitemap-read.js';

test('visibility helper is public-only and matches the sitemap SQL parameter', () => {
  assert.equal(SEARCH_INDEXABLE_VISIBILITY, 'public');
  assert.equal(isSearchIndexableVisibility('public'), true);
  for (const visibility of ['unlisted', 'private', 'protected', '']) {
    assert.equal(isSearchIndexableVisibility(visibility), false, visibility);
  }
  const statement = buildPublicationSitemapStatement();
  assert.equal(statement.values[0], SEARCH_INDEXABLE_VISIBILITY);
  assert.equal(statement.values[1], COLLECTIONS_SITEMAP_MAX_URLS);
  assert.match(statement.text, /c\.visibility = \$1/u);
  assert.match(statement.text, /c\.deleted_at is null/u);
  assert.match(statement.text, /c\.publication_slug is not null/u);
  assert.match(statement.text, /c\.published_at is not null/u);
  assert.equal(COLLECTIONS_SITEMAP_MAX_URLS, 50_000);
  assert.equal(COLLECTIONS_SITEMAP_MAX_BYTES, 50 * 1024 * 1024);
});

test('filter drops every non-public visibility', () => {
  const kept = filterSearchIndexableSitemapEntries([
    { visibility: 'public', slug: 'open' },
    { visibility: 'unlisted', slug: 'hidden' },
    { visibility: 'private', slug: 'mine' },
    { visibility: 'protected', slug: 'members' },
  ]);
  assert.deepEqual(kept, [{ visibility: 'public', slug: 'open' }]);
});

test('empty catalog is a valid empty urlset, not 404-shaped', () => {
  const xml = buildCollectionsSitemapUrlset([]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset /u);
  assert.match(xml, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/u);
  assert.doesNotMatch(xml, /<url>/u);
  assert.doesNotMatch(xml, /<loc>/u);
});

test('urlset loc uses the stamp origin and lastmod from updatedAt, not Date.now()', () => {
  const updatedAt = '2026-07-23T00:00:00.000Z';
  const xml = buildCollectionsSitemapUrlset([
    { publicationSlug: 'engineering-notes', updatedAt, visibility: 'public' },
  ]);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/c\/engineering-notes<\/loc>/u);
  assert.match(xml, /<lastmod>2026-07-23T00:00:00\.000Z<\/lastmod>/u);
  assert.equal(collectionsSitemapLastmod(updatedAt), '2026-07-23T00:00:00.000Z');
  assert.doesNotMatch(xml, new RegExp(new Date().toISOString().slice(0, 10), 'u'));
});

test('omits unlisted even if a caller passes mixed rows', () => {
  const xml = buildCollectionsSitemapUrlset([
    { publicationSlug: 'public-one', updatedAt: '2026-07-23T00:00:00.000Z', visibility: 'public' },
    { publicationSlug: 'unlisted-one', updatedAt: '2026-07-23T00:00:00.000Z', visibility: 'unlisted' },
  ]);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/c\/public-one<\/loc>/u);
  assert.doesNotMatch(xml, /unlisted-one/u);
});

test('XML-escapes loc and lastmod', () => {
  assert.equal(escapeSitemapXml('a&b<c>"'), 'a&amp;b&lt;c&gt;&quot;');
  const xml = buildCollectionsSitemapUrlset([
    { publicationSlug: 'a&b', updatedAt: '2026-07-23T00:00:00.000Z' },
  ]);
  assert.match(xml, /<loc>https:\/\/know-n\.com\/c\/a&amp;b<\/loc>/u);
});
