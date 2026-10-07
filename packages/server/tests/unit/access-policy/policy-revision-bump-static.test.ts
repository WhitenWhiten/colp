import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

test('authz_cache_version migration is expand-only with a non-negative check', () => {
  const source = readFileSync(
    new URL('../../../migrations/202609150100_collections_authz_cache_version.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /authz_cache_version/u);
  assert.match(source, /ADD COLUMN authz_cache_version/u);
  assert.match(source, /CHECK \(authz_cache_version >= 0\)/u);
  assert.match(source, /DROP COLUMN IF EXISTS authz_cache_version/u);
  assert.doesNotMatch(source, /DROP COLUMN IF EXISTS (?!authz_cache_version)/u);
  assert.doesNotMatch(source, /DROP TABLE/u);
  assert.doesNotMatch(source, /sql\.raw/u);
  assert.doesNotMatch(source, /commit_ordinal/u);
  assert.doesNotMatch(source, /operations/u);
});

test('policy-revision-port copies the purge envelope and does not take a second lock', () => {
  const source = readFileSync(
    new URL('../../../src/infrastructure/collections/policy-revision-port.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /PUBLICATION_CACHE_PURGE_EVENT_TYPE/u);
  assert.match(source, /PUBLICATION_CACHE_PURGE_EVENT_VERSION/u);
  assert.match(source, /PUBLICATION_CACHE_PURGE_HANDLER_NAME/u);
  assert.match(source, /handler_mode: 'delivery_each_event'/u);
  assert.match(source, /authz_cache_version \+ 1/u);
  assert.match(source, /publicationSlug === null/u);
  assert.match(source, /publishedAt === null/u);
  assert.doesNotMatch(source, /from '\.\/canonical-mutation-postgres-ports/u);
  assert.doesNotMatch(source, /insertInto\('operations'\)/u);
  assert.doesNotMatch(source, /commit_ordinal: sql/u);
  const bump = source.slice(source.indexOf('async bumpPolicyRevision'));
  assert.doesNotMatch(bump, /\.forUpdate\(/u);
});
