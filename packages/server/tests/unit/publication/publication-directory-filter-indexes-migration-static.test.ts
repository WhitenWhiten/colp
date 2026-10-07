import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import { COLLECTION_CATALOG_TAGS_INDEX_SQL } from '../../../src/infrastructure/publication/index.js';

const migrationUrl = new URL(
  '../../../migrations/202608011100_collections_directory_filter_indexes.ts',
  import.meta.url,
);
const catalogIndexMigrationUrl = new URL(
  '../../../migrations/202609230600_directory_catalog_tags_index.ts',
  import.meta.url,
);

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('Directory filter index migration static contract', () => {
  test('defines the q trigram GIN and tag GIN on the exact live/published predicate with a normalized generated column', async () => {
    const source = await readFile(migrationUrl, 'utf8');

    // R10 q column: one normalized generated column, plain lower() (NFC contract),
    // NOT the NFKC search_text — full-width/ligature compatibility must not match.
    assert.match(source, /directory_search_text/);
    assert.match(source, /GENERATED ALWAYS AS/i);
    assert.match(source, /lower\(coalesce\(title,\s*''\)\s*\|\|\s*' '\s*\|\|\s*coalesce\(summary,\s*''\)\)/is);
    assert.match(source, /STORED/i);

    // q trigram GIN reuses the exact live/published partial predicate of the order index.
    assert.match(source, /CREATE INDEX collections_publication_directory_search_trgm_idx/i);
    assert.match(source, /USING gin \(directory_search_text public\.gin_trgm_ops\)/i);
    assert.match(source, /WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL/i);

    // tag GIN is the exact expression of the query predicate.
    assert.match(source, /CREATE INDEX collections_publication_directory_tags_idx/i);
    assert.match(source, /\(coalesce\(payload_json->'tags',\s*'\[\]'::jsonb\)\)/is);
    assert.match(source, /jsonb_ops/i);
    assert.match(source, /WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL/i);

    // down drops only its own objects and the column.
    assert.match(source, /DROP INDEX IF EXISTS collections_publication_directory_search_trgm_idx/i);
    assert.match(source, /DROP INDEX IF EXISTS collections_publication_directory_tags_idx/i);
    assert.match(source, /DROP COLUMN IF EXISTS directory_search_text/i);

    // The R08/earlier order index must be preserved untouched.
    assert.doesNotMatch(source, /collections_publication_directory_order_idx/i);
    assert.doesNotMatch(source, /collections_publication_directory_locator_idx/i);

    // Kysely runs migrations inside one transaction: no CONCURRENTLY, no forcing GUCs,
    // and no server-side byte re-encoding.
    assert.doesNotMatch(stripBlockComments(source), /CREATE INDEX CONCURRENTLY/i);
    assert.doesNotMatch(source, /enable_(seqscan|sort|indexscan|bitmapscan)/i);
    assert.doesNotMatch(source, /convert_to/i);
    assert.match(source, /Kysely runs PostgreSQL migrations in one transaction/i);
  });

  test('rebuilds the tag GIN on the catalog COALESCE after tags move into extensions', async () => {
    const source = await readFile(catalogIndexMigrationUrl, 'utf8');
    assert.match(source, /DROP INDEX IF EXISTS collections_publication_directory_tags_idx/i);
    assert.match(source, /CREATE INDEX collections_publication_directory_tags_idx/i);
    assert.ok(
      source.includes(COLLECTION_CATALOG_TAGS_INDEX_SQL),
      'catalog tag GIN must use the exact Directory/Explore filter expression',
    );
    assert.match(source, /jsonb_ops/i);
    assert.match(source, /WHERE deleted_at IS NULL AND publication_slug IS NOT NULL AND published_at IS NOT NULL/i);
    assert.match(source, /coalesce\(payload_json->'tags',\s*'\[\]'::jsonb\)/is);
    assert.doesNotMatch(stripBlockComments(source), /CREATE INDEX CONCURRENTLY/i);
  });
});
