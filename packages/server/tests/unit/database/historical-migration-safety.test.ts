import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const publicProfileUrl = new URL(
  '../../../migrations/202607242200_public_profile_projection.ts',
  import.meta.url,
);
const searchBaselineUrl = new URL(
  '../../../migrations/202607251000_postgres_search_baseline.ts',
  import.meta.url,
);

describe('A5-3 public profile handle canonicalization order', () => {
  test('collision-checks and canonicalizes handles before the unique expression index', async () => {
    const source = await readFile(publicProfileUrl, 'utf8');
    const collisionGate = source.indexOf('case-insensitive handle collision');
    const canonicalize = source.indexOf('SET handle = lower(handle)');
    const uniqueIndex = source.indexOf('CREATE UNIQUE INDEX profile_handles_canonical_handle_unique');

    assert.ok(collisionGate >= 0, 'migration must fail closed on case-insensitive collisions');
    assert.ok(canonicalize >= 0, 'migration must lowercase persisted handles');
    assert.ok(uniqueIndex >= 0, 'migration must keep the unique canonical handle index');
    // Building the unique index before canonicalization aborts every install
    // that still has mixed-case handles.
    assert.ok(collisionGate < canonicalize, 'collision gate must precede canonicalization');
    assert.ok(canonicalize < uniqueIndex, 'canonicalization must precede the unique index build');
    assert.match(
      source,
      /GROUP BY lower\(handle\) COLLATE "C"/u,
      'collision gate must use the same expression and collation as the unique index',
    );
  });
});

describe('A5-1 search baseline index builds', () => {
  test('routes the four GIN builds through the transactional online-index gate', async () => {
    const source = await readFile(searchBaselineUrl, 'utf8');

    assert.match(source, /ensureTransactionalPerformanceIndex/u);
    assert.match(source, /for \(const definition of SEARCH_BASELINE_GIN_INDEXES\)/u);
    for (const name of [
      'collections_search_vector_idx',
      'collections_search_trgm_idx',
      'nodes_search_vector_idx',
      'nodes_search_trgm_idx',
    ]) {
      assert.match(source, new RegExp(`name: '${name}'`, 'u'));
    }
    // No statement may still build a GIN inline in the migration transaction.
    assert.doesNotMatch(source, /sql`[^`]*USING gin/iu);
    // The build budget gate is the shared helper's, not a local bypass.
    assert.doesNotMatch(source, /sql`CREATE (?:UNIQUE )?INDEX CONCURRENTLY/iu);
  });
});
