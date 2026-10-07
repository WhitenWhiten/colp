import assert from 'node:assert/strict';
import type { Annotation } from '@know-n/colp/types';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicationAnnotationCandidateStatement,
  createPostgresPublicationAnnotationReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { PUBLICATION_ANNOTATION_COMPARATOR_VERSION } from '../../../src/modules/publication/index.js';

const instant = new Date('2026-07-25T00:00:00.000Z');

function payload(
  id = 'annotation-1',
  subjectType: 'collection' | 'node' = 'node',
  subjectId = 'node-1',
): Annotation {
  return {
    id, collectionId: 'collection-1', subject: { type: subjectType, id: subjectId },
    type: 'note', format: 'plain', value: 'Published value', visibility: 'public',
    creator: { id: 'https://known.example/profiles/creator', name: 'Stored creator' },
    provenance: {
      kind: 'ai', provider: 'internal-provider', model: 'internal-model', generatedAt: instant.toISOString(),
    },
    revision: 'annotation-revision-1', createdAt: instant.toISOString(), updatedAt: instant.toISOString(),
  };
}

function annotationRow(
  id = 'annotation-1',
  subjectType: 'collection' | 'node' = 'node',
  subjectId = 'node-1',
  extra: Record<string, unknown> = {},
) {
  return {
    id, collection_id: 'collection-1', subject_type: subjectType, subject_id: subjectId,
    creator_principal_id: 'principal-creator', type: 'note', format: 'plain',
    value_json: 'Published value', visibility: 'public',
    payload_json: payload(id, subjectType, subjectId), payload_schema_version: 1,
    payload_authority_status: 'backfilled',
    resource_revision: 'annotation-revision-1', created_at: instant, updated_at: instant,
    deleted_at: null, subject_visibility: 'inherit', subject_ancestor_restricted: false,
    // The public correction loop only collects window rows whose is_visible flag is true.
    is_visible: true,
    ...extra,
  };
}

function runtimeHarness(options: {
  failCandidates?: boolean;
  mismatchedValue?: boolean;
  missing?: boolean;
  rows?: Array<Record<string, unknown>>;
  /** Each candidate call returns the next row batch, proving the public correction loop advances the page cursor. */
  rowBatches?: Array<Array<Record<string, unknown>>>;
} = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let released = false;
  const batches = [...(options.rowBatches ?? [options.rows ?? [annotationRow()]])];
  let candidateCalls = 0;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')")) {
        return { rows: [{ isolation: 'repeatable read' }] };
      }
      if (sql.includes('from collections') && !sql.includes('with recursive')) {
        return { rows: options.missing ? [] : [{
          content_revision: 'content-1', policy_revision: 'policy-1', deleted_at: null,
        }] };
      }
      if (sql.includes('publication_locator_sha256_128')) {
        return { rows: [{ id: 'annotation-1', subject_type: 'node', subject_id: 'node-1' }] };
      }
      if (sql.includes('from annotations a')) {
        if (options.failCandidates) throw new Error('annotation candidate read failed');
        const batch = batches[Math.min(candidateCalls, batches.length - 1)]!;
        candidateCalls += 1;
        return {
          rows: batch.map((row) => ({
            ...annotationRow(),
            ...row,
            ...(options.mismatchedValue ? { value_json: 'tampered value' } : {}),
          })),
        };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    runtime: { pool: { async connect() { return client; } } as unknown as DatabaseRuntime['pool'] },
    calls, released: () => released, candidateCalls: () => candidateCalls,
  };
}

test('loads one detached Annotation page in read-only repeatable read and rebuilds the public Actor', async () => {
  const harness = runtimeHarness();
  const page = await createPostgresPublicationAnnotationReadPort(harness.runtime, {
    origin: 'https://known.example',
  }).loadPage({
    collectionId: 'collection-1', projection: 'public', limit: 20,
  });
  assert.equal(page.isolation, 'repeatable read');
  assert.equal(page.comparatorVersion, PUBLICATION_ANNOTATION_COMPARATOR_VERSION);
  assert.equal(page.contentRevision, 'content-1');
  assert.equal(page.policyRevision, 'policy-1');
  assert.deepEqual(page.candidates.map((row) => row.id), ['annotation-1']);
  assert.deepEqual(page.candidates[0]?.payload.creator, {
    id: 'https://known.example/profiles/creator', name: 'Stored creator',
  });
  assert.equal(page.candidates[0]?.creatorPrincipalId, 'principal-creator');
  assert.equal(page.candidates[0]?.creatorUri, 'https://known.example/profiles/creator');
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.candidates), true);
  assert.equal(harness.calls[0]?.sql, 'begin isolation level repeatable read read only');
  assert.equal(harness.calls.at(-1)?.sql, 'commit');
  assert.equal(harness.released(), true);
  assert.equal(harness.candidateCalls(), 1);
});

test('builds a single page-level ancestry CTE statement for public and creator-private member projections', () => {
  const publicStatement = buildPublicationAnnotationCandidateStatement({
    collectionId: 'collection-1', projection: 'public', limit: 500,
    after: { subjectType: 'node', subjectId: 'node-500', annotationId: 'annotation-500' },
  });
  assert.deepEqual(publicStatement.values.slice(0, 4), [
    'collection-1', 'node', 'node-500', 'annotation-500',
  ]);
  assert.equal(publicStatement.values.at(-1), 501);
  assert.match(publicStatement.text, /a\.visibility in \('public', 'unlisted'\)/u);
  assert.match(publicStatement.text, /a\.deleted_at is null/u);
  assert.match(publicStatement.text, /subject_type collate "C"/u);
  assert.match(publicStatement.text, /subject_id collate "C"/u);
  assert.match(publicStatement.text, /a\.id collate "C"/u);
  assert.match(publicStatement.text, /\) > \(\$2::text collate "C", \$3::text collate "C", \$4::text collate "C"\)/u);
  assert.match(publicStatement.text, /order by a\.subject_type collate "C",\s*a\.subject_id collate "C",\s*a\.id collate "C"/u);
  assert.match(publicStatement.text, /n\.deleted_at is null/u);
  assert.match(publicStatement.text, /a\.subject_type = 'collection'.*a\.subject_id = a\.collection_id/su);
  // The page-level ancestry CTE: one recursive walk seeded from the window's candidate subject ids.
  assert.match(publicStatement.text, /with recursive candidate_window/u);
  assert.match(publicStatement.text, /origins as \(\s*select distinct subject_id\s+as origin_id\s*from candidate_window/u);
  assert.match(publicStatement.text, /ancestry as \(\s*select o\.origin_id/u);
  assert.match(publicStatement.text, /join nodes n on n\.collection_id = \$1 and n\.id = o\.origin_id/u);
  assert.match(publicStatement.text, /bool_or\(case when distance >= 1 then visibility in \('private', 'protected'\) end\)/u);
  assert.match(publicStatement.text, /bool_or\(cycle\)/u);
  assert.match(publicStatement.text, /bool_or\(parent_id is null\)/u);
  assert.match(publicStatement.text, /is_visible/u);
  // Per-row correlated recursive walks are gone.
  assert.doesNotMatch(publicStatement.text, /with recursive ancestors/u);

  const memberStatement = buildPublicationAnnotationCandidateStatement({
    collectionId: 'collection-1', projection: 'member', principalId: 'principal-member',
    rootId: 'folder-1', depth: 2, limit: 20,
  });
  assert.match(memberStatement.text, /with recursive scoped/u);
  assert.match(memberStatement.text, /a\.visibility in \('public', 'unlisted', 'protected'\)/u);
  assert.match(memberStatement.text, /a\.visibility = 'private'.*creator_principal_id/su);
  assert.match(memberStatement.text, /scope_depth <=/u);
  assert.ok(memberStatement.values.includes('principal-member'));
  // Member still carries the page-level walk for the subject facts output columns.
  assert.match(memberStatement.text, /origins as /u);
  assert.match(memberStatement.text, /bool_or\(cycle\)/u);
});

test('public fail-closed aggregation treats cycle, missing parent and depth truncation as restricted', () => {
  const statement = buildPublicationAnnotationCandidateStatement({
    collectionId: 'collection-1', projection: 'public', limit: 20,
  });
  // subject_ancestor_restricted coalesces missing walk facts to true (restricted), never relaxes to public.
  assert.match(statement.text, /coalesce\(\s*facts_row\.has_restricted_ancestor or facts_row\.has_cycle or not facts_row\.reached_top, true\)/u);
  assert.match(statement.text, /bool_or\(cycle\)/u);
  assert.match(statement.text, /bool_or\(parent_id is null\)/u);
  // The walk is depth-capped so truncation fails closed via not reached_top.
  assert.match(statement.text, /distance < 1024/u);
});

test('the public correction loop advances the page cursor across invisible window rows', async () => {
  const harness = runtimeHarness({
    rowBatches: [
      [
        annotationRow('annotation-1', 'node', 'node-1', { is_visible: true }),
        annotationRow('annotation-2', 'node', 'node-2', { is_visible: false }),
      ],
      [annotationRow('annotation-3', 'node', 'node-3', { is_visible: true })],
    ],
  });
  const page = await createPostgresPublicationAnnotationReadPort(harness.runtime, {
    origin: 'https://known.example',
  }).loadPage({
    collectionId: 'collection-1', projection: 'public', limit: 1,
  });
  assert.deepEqual(page.candidates.map((row) => row.id), ['annotation-1', 'annotation-3']);
  assert.equal(harness.candidateCalls(), 2);
  const secondWindow = harness.calls.filter((call) => call.sql.includes('from annotations a'))[1];
  assert.deepEqual(secondWindow?.values?.slice(0, 4), [
    'collection-1', 'node', 'node-2', 'annotation-2',
  ]);
});

test('resolves a fixed locator to the full exclusive tuple before querying the next page', async () => {
  const harness = runtimeHarness();
  await createPostgresPublicationAnnotationReadPort(harness.runtime, {
    origin: 'https://known.example',
  }).loadPage({
    collectionId: 'collection-1', projection: 'public', limit: 10,
    afterLocator: '0123456789abcdef0123456789abcdef',
  });
  const locatorCall = harness.calls.find((call) => call.sql.includes('publication_locator_sha256_128'));
  assert.deepEqual(locatorCall?.values, ['collection-1', '0123456789abcdef0123456789abcdef']);
  assert.match(locatorCall?.sql ?? '', /from annotations/u);
  assert.match(locatorCall?.sql ?? '', /deleted_at is null/u);
  const candidateCall = harness.calls.find((call) => call.sql.includes('from annotations a'));
  assert.deepEqual(candidateCall?.values?.slice(0, 4), [
    'collection-1', 'node', 'node-1', 'annotation-1',
  ]);
});

test('returns an empty fenced page for a missing Collection and rolls back on candidate failure', async () => {
  const missing = runtimeHarness({ missing: true });
  const empty = await createPostgresPublicationAnnotationReadPort(missing.runtime, {
    origin: 'https://known.example',
  }).loadPage({ collectionId: 'collection-1', projection: 'public', limit: 10 });
  assert.equal(empty.contentRevision, null);
  assert.equal(empty.policyRevision, null);
  assert.deepEqual(empty.candidates, []);
  assert.equal(missing.calls.some((call) => call.sql.includes('from annotations a')), false);

  const failed = runtimeHarness({ failCandidates: true });
  await assert.rejects(() => createPostgresPublicationAnnotationReadPort(failed.runtime, {
    origin: 'https://known.example',
  }).loadPage({ collectionId: 'collection-1', projection: 'public', limit: 10 }),
  /annotation candidate read failed/u);
  assert.equal(failed.calls.at(-1)?.sql, 'rollback');
  assert.equal(failed.released(), true);

  const mismatched = runtimeHarness({ mismatchedValue: true });
  await assert.rejects(() => createPostgresPublicationAnnotationReadPort(mismatched.runtime, {
    origin: 'https://known.example',
  }).loadPage({ collectionId: 'collection-1', projection: 'public', limit: 10 }),
  /relational\/payload authority mismatch/u);
  assert.equal(mismatched.calls.at(-1)?.sql, 'rollback');
});
