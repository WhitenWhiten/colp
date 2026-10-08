import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  SEARCH_MAX_TIMEOUT_MS,
  compareSearchCandidateTuple,
  type SearchCandidate,
  type SearchCandidateResourceType,
} from '../../../src/modules/search/index.js';
import { capturePostgresSearchSql } from '../../support/search-candidate-sql-capture.js';

function candidate(resourceType: SearchCandidateResourceType, resourceId: string): SearchCandidate {
  const shared = {
    resourceId,
    rank: 0.75,
    snippetSource: 'bounded safe text',
    exclusive: { rank: 0.75, resourceType, resourceId },
  } as const;
  switch (resourceType) {
    case 'collection':
      return { ...shared, resourceType, collectionId: resourceId, title: 'Same title', urlHost: null };
    case 'node':
      return { ...shared, resourceType, collectionId: 'collection', title: 'Same title', urlHost: null };
    case 'profile':
      return { ...shared, resourceType, collectionId: null, handle: resourceId, displayName: 'Same title' };
    case 'annotation':
      return {
        ...shared,
        resourceType,
        collectionId: 'collection',
        subjectType: 'node',
        subjectId: 'node',
        annotationType: 'note',
      };
  }
}

test('four candidate branches use an explicit stable type order and complete exclusive tuple', () => {
  const ordered = [
    candidate('profile', 'z'), candidate('node', 'z'), candidate('annotation', 'z'),
    candidate('collection', 'z'), candidate('annotation', 'a'),
  ].sort(compareSearchCandidateTuple);
  assert.deepEqual(ordered.map((item) => `${item.resourceType}:${item.resourceId}`), [
    'collection:z', 'node:z', 'profile:z', 'annotation:a', 'annotation:z',
  ]);
  assert.deepEqual(ordered.map((item) => item.exclusive), ordered.map((item) => ({
    rank: item.rank, resourceType: item.resourceType, resourceId: item.resourceId,
  })));
});

test('candidate SQL admits only active public Profiles backed by an opted-in public Collection', async () => {
  const { port, queries } = capturePostgresSearchSql();
  await port.listAnonymousCandidates({ query: 'alice', limit: 20 });
  const candidate = queries.find((query) => query.sql.includes('resource_type'));
  assert.ok(candidate, 'the candidate query must be compiled and executed');

  // Profile branch joins the matched handle/display CTEs...
  assert.match(candidate.sql, /\bprofile_hits\s+AS\s*\(/iu);
  assert.match(candidate.sql, /\bprofile_matches\s+AS\s*\(/iu);
  assert.match(candidate.sql, /\bsearch_handle\b/iu);
  assert.match(candidate.sql, /\bsearch_display_name\b/iu);
  // ...and filters the branch to the active, non-deleted account...
  assert.match(candidate.sql, /JOIN\s+accounts\s+a\s+ON\s+a\.id\s*=\s*matched\.account_id[\s\S]{0,300}?WHERE\s+a\.status\s*=\s*(?:'active'|\$\d+)/iu);
  assert.ok(candidate.parameters.includes('active') || /WHERE\s+a\.status\s*=\s*'active'/iu.test(candidate.sql),
    'the active-account predicate must be present');
  assert.match(candidate.sql, /WHERE\s+a\.status\s*=\s*(?:'active'|\$\d+)[\s\S]{0,200}?\ba\.deleted_at\s+is\s+null/iu);
  // ...and requires a public, opted-in collection owned by the same subject.
  assert.match(candidate.sql, /AND\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+collections\s+owned[\s\S]{0,300}?\bowned\.owner_subject_id\s*=\s*a\.subject_id[\s\S]{0,300}?\bowned\.visibility\s*=\s*'public'[\s\S]{0,300}?\bowned\.allow_search_indexing\s*=\s*true/iu);
});

test('candidate SQL excludes private annotation facts in every branch and re-checks the subject', async () => {
  const { port, queries } = capturePostgresSearchSql();
  await port.listAnonymousCandidates({ query: 'needle', limit: 20 });
  const candidate = queries.find((query) => query.sql.includes('resource_type'));
  assert.ok(candidate, 'the candidate query must be compiled and executed');

  // Public branch keeps only public, live, non-reading_state annotations in a
  // public, opted-in collection.
  assert.match(candidate.sql, /FROM\s+annotations\s+a\s+JOIN\s+collections\s+c\s+ON\s+c\.id\s*=\s*a\.collection_id[\s\S]{0,400}?\bWHERE\s+a\.deleted_at\s+IS\s+NULL[\s\S]{0,200}?\ba\.type\s*<>\s*'reading_state'[\s\S]{0,250}?\bc\.visibility\s*=\s*'public'[\s\S]{0,250}?\bc\.allow_search_indexing\s*=\s*true[\s\S]{0,250}?\ba\.visibility\s*=\s*'public'/iu);
  // Subject visibility is re-checked through one set-oriented ancestor walk
  // per distinct parent, rather than a correlated recursive CTE per hit.
  assert.match(candidate.sql, /WITH\s+RECURSIVE\s+matched\s+AS\s+MATERIALIZED/iu);
  assert.match(candidate.sql, /path_seeds\s+AS\s+MATERIALIZED\s*\(\s*SELECT\s+DISTINCT\s+collection_id\s*,\s*path_parent_id/iu);
  assert.match(candidate.sql, /ancestor_walk\s*\(/iu);
  assert.doesNotMatch(candidate.sql, /NOT\s+EXISTS\s*\(\s*WITH\s+RECURSIVE/iu);
  assert.match(candidate.sql, /\bsubject_node\.id\s+AS\s+subject_node_id[\s\S]{0,300}?\bsubject_node\.visibility\s+AS\s+subject_visibility/iu);
  // The snippet source is the bounded materialized text and the explicit
  // cross-type rank order stays the documented tuple.
  assert.match(candidate.sql, /\bannotation_search_text\b/iu);
  assert.match(candidate.sql, /CASE\s+resource_type\s+WHEN\s+'collection'\s+THEN\s+0\s+WHEN\s+'node'\s+THEN\s+1\s+WHEN\s+'profile'\s+THEN\s+2\s+WHEN\s+'annotation'\s+THEN\s+3/iu);

  // The member branch (account projection) additionally re-checks the creator
  // against the verified actor, so a member can see their own private
  // annotations, and both annotation branches keep the reading_state
  // exclusion.
  const account = capturePostgresSearchSql();
  await account.port.listCandidates({
    query: 'needle', types: ['collection', 'node', 'profile', 'annotation'], limit: 20,
    timeoutMs: SEARCH_MAX_TIMEOUT_MS,
    projection: { kind: 'account', accountId: 'account-member', principalId: 'principal-member',
      subjectId: 'subject-member', securityEpoch: '3' },
  });
  const accountSql = account.queries.find((query) => query.sql.includes('resource_type'));
  assert.ok(accountSql, 'the account candidate query must be compiled and executed');
  assert.match(accountSql.sql, /\ba\.visibility\s*<>\s*'private'\s+OR\s+a\.creator_principal_id\s*=\s*\(\s*SELECT\s+principal_id\s+FROM\s+verified_actor\s*\)/iu);
  assert.ok((accountSql.sql.match(/\ba\.type\s*<>\s*'reading_state'/giu) ?? []).length >= 2,
    'public and member annotation branches must exclude reading_state');
});

test('P2B-22 migration pins its functions to the creation search_path (static boundary)', async () => {
  const source = await readFile(
    new URL('../../../migrations/202607251100_profile_annotation_search.ts', import.meta.url),
    'utf8',
  );
  // Static proof boundary: the installed catalog (generated columns,
  // provolatile='i', all branch indexes) and the bounded/stripped snippet
  // behavior are asserted LIVE in search-profile-annotation-postgres
  // .integration.test.ts and search-profile-annotation-plan.integration
  // .test.ts (up/down replay, index probes, no sequential scans). This scan
  // keeps the one declaration behavior cannot easily observe: SET search_path
  // FROM CURRENT pins each function's search_path at creation so a later
  // search_path change cannot hijack its internal calls, and the functions
  // never escalate to SECURITY DEFINER.
  assert.match(source, /SET search_path FROM CURRENT/iu);
  assert.doesNotMatch(source, /SECURITY\s+DEFINER/iu);
});

test('candidate SQL never produces markup highlights or telemetry from the search layer (static boundary)', async () => {
  const source = await readFile(
    new URL('../../../src/infrastructure/search/postgres-search-candidate.ts', import.meta.url),
    'utf8',
  );
  // Static proof boundary: row-level authority filtering is asserted from the
  // compiled candidate SQL above and behaviorally in the PG suites; these
  // scans keep irreplaceable ABSENCE properties that behavior cannot observe
  // (a ts_headline/markup highlight path or a logger/metric call would return
  // the same rows).
  assert.doesNotMatch(source, /ts_headline|<mark|dangerouslySetInnerHTML/iu);
  assert.doesNotMatch(source, /console\.|logger|metric/iu);
});
