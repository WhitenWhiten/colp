import assert from 'node:assert/strict';
import type { Relation } from '@know-n/colp/types';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationRelationCandidateStatement,
  createPostgresPublicationRelationReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { PUBLICATION_RELATION_COMPARATOR_VERSION } from '../../../src/modules/publication/index.js';

const instant = new Date('2026-07-25T04:00:00.000Z');

function payload(id = 'relation-1'): Relation {
  return {
    id, collectionId: 'collection-1', type: 'related', fromNodeId: 'node-a', toNodeId: 'node-b',
    label: 'See also', visibility: 'public', revision: 'relation-revision-1',
    createdAt: instant.toISOString(), updatedAt: instant.toISOString(),
  };
}

function harness(options: { mismatch?: boolean; missing?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let released = false;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')")) return { rows: [{ isolation: 'repeatable read' }] };
      if (sql.includes('from collections') && !sql.includes('with recursive')) return { rows: options.missing ? [] : [{
        content_revision: 'content-1', policy_revision: 'policy-1', deleted_at: null,
      }] };
      if (sql.includes('publication_locator_sha256_128')) return { rows: [{
        id: 'relation-1', from_node_id: 'node-a', to_node_id: 'node-b', type: 'related',
      }] };
      if (sql.includes('from relations r')) return { rows: [{
        id: 'relation-1', collection_id: 'collection-1', from_node_id: 'node-a', to_node_id: 'node-b',
        type: 'related', label: options.mismatch ? 'leaked' : 'See also', visibility: 'public',
        resource_revision: 'relation-revision-1', created_at: instant, updated_at: instant,
        deleted_at: null, payload_json: payload(), payload_schema_version: 1,
        payload_authority_status: 'backfilled', from_visibility: 'inherit', to_visibility: 'inherit',
        from_authorized: true, to_authorized: true,
        from_ancestor_visibility: null, to_ancestor_visibility: null,
        from_ancestor_restricted: false, to_ancestor_restricted: false,
      }] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    runtime: { pool: { async connect() { return client; } } as unknown as DatabaseRuntime['pool'] },
    calls, released: () => released,
  };
}

test('reads a fenced Relation page in a detached repeatable-read transaction', async () => {
  const state = harness();
  const page = await createPostgresPublicationRelationReadPort(state.runtime).loadPage({
    collectionId: 'collection-1', projection: 'public', limit: 20,
  });
  assert.equal(page.comparatorVersion, PUBLICATION_RELATION_COMPARATOR_VERSION);
  assert.equal(page.contentRevision, 'content-1');
  assert.deepEqual(page.candidates.map((row) => row.id), ['relation-1']);
  assert.equal(page.candidates[0]?.payload.label, 'See also');
  assert.equal(state.calls[0]?.sql, 'begin isolation level repeatable read read only');
  assert.equal(state.calls.at(-1)?.sql, 'commit');
  assert.equal(state.released(), true);
});

test('builds one page-level ancestry CTE seeded from from/to endpoints for a scoped member projection', () => {
  const statement = buildPublicationRelationCandidateStatement({
    collectionId: 'collection-1', projection: 'member', limit: 20,
    rootId: 'folder-1', depth: 2,
    after: { fromNodeId: 'node-a', toNodeId: 'node-b', type: 'related', relationId: 'relation-1' },
  });
  assert.deepEqual(statement.values.slice(0, 5), ['collection-1', 'node-a', 'node-b', 'related', 'relation-1']);
  assert.equal(statement.values.at(-1), 21);
  assert.match(statement.text, /r\.deleted_at is null/u);
  assert.match(statement.text, /r\.from_node_id collate "C"/u);
  assert.match(statement.text, /r\.to_node_id collate "C"/u);
  assert.match(statement.text, /r\.type collate "C"/u);
  assert.match(statement.text, /r\.id collate "C"/u);
  assert.match(statement.text, /order by r\.from_node_id collate "C",\s*r\.to_node_id collate "C",\s*r\.type collate "C",\s*r\.id collate "C"/u);
  // One page-level walk, seeded from the from and to endpoints in a single CTE.
  assert.match(statement.text, /with recursive candidate_window/u);
  assert.match(statement.text, /cross join lateral \(values \(c\.from_node_id\), \(c\.to_node_id\)\)/u);
  assert.match(statement.text, /endpoint_ids as/u);
  assert.match(statement.text, /from_endpoint\.id = r\.from_node_id/u);
  assert.match(statement.text, /to_endpoint\.id = r\.to_node_id/u);
  assert.match(statement.text, /scope_reachable/u);
  assert.match(statement.text, /distance <=/u);
  assert.match(statement.text, /from_authorized/u);
  // Per-row correlated recursive scope/ancestry walks are gone.
  assert.doesNotMatch(statement.text, /with recursive endpoint_path/u);
  assert.doesNotMatch(statement.text, /with recursive ancestors/u);
});

test('omits scope reachability and still aggregates restriction without a subtree scope', () => {
  const statement = buildPublicationRelationCandidateStatement({
    collectionId: 'collection-1', projection: 'public', limit: 20,
  });
  assert.doesNotMatch(statement.text, /scope_reachable/u);
  assert.doesNotMatch(statement.text, /with recursive endpoint_path/u);
  assert.match(statement.text, /from_endpoint\.visibility/u);
  assert.match(statement.text, /to_endpoint\.visibility/u);
  assert.match(statement.text, /bool_or\(cycle\)/u);
  assert.match(statement.text, /bool_or\(parent_id is null\)/u);
});

test('fails closed for deleted/missing endpoints and cyclic ancestors', () => {
  const statement = buildPublicationRelationCandidateStatement({
    collectionId: 'collection-1', projection: 'public', limit: 20,
  });
  // Deleted/missing endpoints are restricted and unauthorized, never relaxed to live.
  assert.match(statement.text, /case when from_endpoint\.id is null then true/u);
  assert.match(statement.text, /case when to_endpoint\.id is null then true/u);
  assert.match(statement.text, /from_endpoint\.id is null then 'private'/u);
  // Cycle and depth truncation both contribute to the fail-closed restriction.
  assert.match(statement.text, /coalesce\(\s*from_facts\.has_restricted_ancestor or from_facts\.has_cycle or not from_facts\.reached_top, true\)/u);
  assert.match(statement.text, /distance < 1024/u);
});

test('resolves opaque locator and rejects relational/payload drift without exposing a partial Relation', async () => {
  const state = harness();
  await createPostgresPublicationRelationReadPort(state.runtime).loadPage({
    collectionId: 'collection-1', projection: 'public', limit: 10,
    afterLocator: '0123456789abcdef0123456789abcdef',
  });
  assert.deepEqual(state.calls.find((call) => call.sql.includes('publication_locator_sha256_128'))?.values,
    ['collection-1', '0123456789abcdef0123456789abcdef']);

  const mismatch = harness({ mismatch: true });
  await assert.rejects(() => createPostgresPublicationRelationReadPort(mismatch.runtime).loadPage({
    collectionId: 'collection-1', projection: 'public', limit: 10,
  }), /relational\/payload authority mismatch/u);
  assert.equal(mismatch.calls.at(-1)?.sql, 'rollback');
});
