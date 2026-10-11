import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildPublicCollectionMarkdown,
  injectPublicCollectionShell,
  resolveSearchIndexable,
} from '../../../src/infrastructure/http/index.js';
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

test('the shared seed-exclusion predicate names the seed registry and the collection id', () => {
  assert.match(SEED_COLLECTION_EXCLUSION_SQL, /seed_rows sr/u);
  assert.match(SEED_COLLECTION_EXCLUSION_SQL, /sr\.table_name = 'collections'/u);
  assert.match(SEED_COLLECTION_EXCLUSION_SQL, /sr\.pk->>0 = c\.id/u);
});
