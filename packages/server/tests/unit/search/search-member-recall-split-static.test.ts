import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';

const candidateUrl = new URL(
  '../../../src/infrastructure/search/postgres-search-candidate.ts',
  import.meta.url,
);

function countMatches(source: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (source.match(new RegExp(pattern.source, flags)) ?? []).length;
}

describe('R11 public/member recall split static contract', () => {
  test('splits candidate recall into bounded per-branch public and member candidates with union dedup', async () => {
    const source = await readFile(candidateUrl, 'utf8');

    // Candidates stay a single materialized CTE fed by bounded branches.
    assert.match(source, /candidates AS \(/u);

    // Every branch applies continuation, type filter, positive rank, tie keys and a
    // per-branch LIMIT through the shared rankedBranch helper; the final SELECT applies
    // the same continuation and LIMIT again after dedup.
    assert.match(source, /const rankedBranch/u);
    assert.ok(countMatches(source, /LIMIT \$\{input\.limit \+ 1\}/u) >= 2,
      'per-branch and final LIMIT must both be present');
    assert.ok(countMatches(source, /ORDER BY rank DESC, resource_order ASC, resource_id COLLATE "C" ASC/u) >= 2,
      'per-branch and final tie-key ordering must both be present');
    assert.ok(countMatches(source, /WHERE raw_rank > 0/u) >= 1,
      'branches must filter positive raw ranks');

    // The shared continuation references the normalized rank, resource order, and resource id.
    assert.match(source, /scored\.rank < \$\{after\.rank\}::double precision/u);
    assert.match(source, /scored\.resource_order > \$\{afterResourceOrder\}::integer/u);
    assert.match(source, /scored\.resource_id COLLATE "C" > \$\{after\.resourceId\} COLLATE "C"/u);

    // Membership is a candidate-id probe, not a materialized account collection list.
    assert.match(source, /member\.collection_id = c\.id/u);
    assert.match(source, /OFFSET 0/u);
    assert.doesNotMatch(source, /actor_collections/u);
    for (const name of ['collectionMemberBranch', 'nodeMemberBranch', 'annotationMemberBranch']) {
      assert.match(source, new RegExp(`const ${name} = sql`, 'u'));
    }

    // Only the requested type is installed, and member branches only for an account.
    assert.match(source, /requestedTypes\.has\(type\) && \(!member \|\| accountSearch\)/u);
    assert.match(source, /const wantsMember/u);
    assert.match(source, /if \(wantsMember\)/u);
    assert.match(source, /requestedTypes\.has\('profile'\)/u);
    assert.match(source, /input\.projection\.kind === 'account'/u);

    // Dedup keeps one stable row per resource identity before the global sort.
    assert.match(source, /DISTINCT ON \(resource_type, resource_id\)/u);
    assert.match(source, /ORDER BY resource_type, resource_id, rank DESC/u);

    // Rank normalization and the explicit resource type order remain.
    assert.match(source, /round\(least\(1\.0,greatest\(0\.0,raw_rank\)\)::numeric,6\)::double precision AS rank/u);
    assert.match(source, /CASE resource_type[\s\S]*?'collection'[\s\S]*?'node'[\s\S]*?'profile'[\s\S]*?'annotation'/u);

    // Branches are joined with a raw UNION ALL separator.
    assert.match(source, /UNION ALL/u);

    // The transaction-local threshold setup and abort mapping are unchanged; the
    // threshold itself is chosen per query script and bound, never inlined.
    assert.match(source, /db\.transaction\(\)\.execute\(async \(transaction\) =>/u);
    assert.match(source, /set_config\('pg_trgm\.word_similarity_threshold',\$\{wordSimilarityThreshold\},true\)/u);
    assert.match(source, /const wordSimilarityThreshold = searchWordSimilarityThreshold\(query\);/u);
    assert.doesNotMatch(source, /word_similarity_threshold','0\.\d+'/u);

    // No evidence-only machinery leaks into production SQL.
    assert.doesNotMatch(source, /config AS MATERIALIZED|CROSS JOIN config/u);
  });
});
