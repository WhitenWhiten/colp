import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildPublicCollectionMarkdown,
  injectPublicCollectionShell,
  injectPublicProfileShell,
  isIndexableProfile,
  resolveSearchIndexable,
} from '../../../src/infrastructure/http/index.js';
import { buildPublicationSitemapStatement } from '../../../src/infrastructure/publication/postgres-sitemap-read.js';
import { buildProfileSitemapStatement } from '../../../src/infrastructure/publication/postgres-profile-sitemap-read.js';
import { SEED_COLLECTION_EXCLUSION_SQL } from '../../../src/infrastructure/publication/postgres-search-indexing-exclusion.js';
import { PUBLIC_SHELL_FIXTURE } from './public-shell-fixture.js';

const collection = {
  surface: 'c' as const,
  slug: 'llm-learning-path',
  collectionId: 'col-u01-01',
  title: 'LLM learning path',
  summary: 'Seed fixture summary.',
  curator: 'Seed Curator',
  itemCount: 3,
  updatedAt: '2026-08-01T00:00:00.000Z',
  visibility: 'public' as const,
  language: null,
};

test('visibility decides by default and an explicit searchIndexable:false always wins', () => {
  assert.equal(resolveSearchIndexable({ visibility: 'public' }), true);
  assert.equal(resolveSearchIndexable({ visibility: 'public', searchIndexable: true }), true);
  assert.equal(resolveSearchIndexable({ visibility: 'public', searchIndexable: false }), false);
  assert.equal(resolveSearchIndexable({ visibility: 'unlisted' }), false);
  assert.equal(resolveSearchIndexable({ visibility: 'unlisted', searchIndexable: true }), false);
});

test('a public seed collection still renders its document but carries noindex in HTML and markdown', () => {
  const html = injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, { ...collection, searchIndexable: false });
  assert.match(html, /<meta name="robots" content="noindex" \/>/u);
  assert.match(html, /<title>LLM learning path — Know-N<\/title>/u);
  assert.match(html, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/llm-learning-path" \/>/u);
  assert.doesNotMatch(injectPublicCollectionShell(PUBLIC_SHELL_FIXTURE, collection), /name="robots"/u);

  const markdown = buildPublicCollectionMarkdown({
    collectionId: collection.collectionId,
    title: collection.title,
    summary: collection.summary,
    curator: collection.curator,
    updatedAt: collection.updatedAt,
    visibility: 'public',
    searchIndexable: false,
    nodes: [],
    nodeCount: 0,
  });
  assert.match(markdown, /^robots: noindex$/mu);
});

test('a Profile whose only public collections are seed data is thin (noindex); one real collection restores indexability', () => {
  const seedOnly = {
    handle: 'seed_curator',
    displayName: 'Seed Curator',
    bio: 'Fixture bio.',
    collections: [
      { slug: 'llm-learning-path', title: 'LLM learning path', updatedAt: '2026-08-01T00:00:00Z', searchIndexable: false },
      { slug: 'design-inspiration', title: 'Design inspiration', updatedAt: '2026-08-02T00:00:00Z', searchIndexable: false },
    ],
    hasMoreCollections: false,
  };
  assert.equal(isIndexableProfile(seedOnly), false);
  const html = injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, seedOnly);
  assert.match(html, /<meta name="robots" content="noindex" \/>/u);
  assert.match(html, /<a href="\/c\/llm-learning-path">LLM learning path<\/a>/u, 'seed collections stay listed');

  const mixed = {
    ...seedOnly,
    collections: [...seedOnly.collections, { slug: 'real-notes', title: 'Real notes', updatedAt: '2026-08-03T00:00:00Z' }],
  };
  assert.equal(isIndexableProfile(mixed), true);
  assert.doesNotMatch(injectPublicProfileShell(PUBLIC_SHELL_FIXTURE, mixed), /name="robots"/u);
});

test('both sitemap statements exclude seed-registered collections through the shared predicate', () => {
  assert.match(SEED_COLLECTION_EXCLUSION_SQL, /seed_rows sr/u);
  assert.match(SEED_COLLECTION_EXCLUSION_SQL, /sr\.table_name = 'collections'/u);
  assert.match(SEED_COLLECTION_EXCLUSION_SQL, /sr\.pk->>0 = c\.id/u);
  assert.ok(buildPublicationSitemapStatement().text.includes(SEED_COLLECTION_EXCLUSION_SQL));
  assert.ok(buildProfileSitemapStatement().text.includes(SEED_COLLECTION_EXCLUSION_SQL));
});
