import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import {
  SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD,
  SEARCH_HAN_WORD_SIMILARITY_THRESHOLD,
  SEARCH_MAX_TIMEOUT_MS,
  SearchQueryError,
  compareSearchCandidateTuple,
  extractSearchUrlHost,
  normalizeSearchQuery,
  searchWordSimilarityThreshold,
  type SearchCandidate,
} from '../../../src/modules/search/index.js';
import {
  loadSearchPostgresThresholds,
  loadSearchQualityCorpus,
} from '../../../scripts/evidence/search-postgres-baseline.js';
import { capturePostgresSearchSql } from '../../support/search-candidate-sql-capture.js';

test('normalizes Unicode and whitespace without interpreting search syntax', () => {
  assert.equal(normalizeSearchQuery('  Cafe\u0301\tSEARCH  '), 'café search');
  assert.equal(normalizeSearchQuery('中文　搜索'), '中文搜索');
  assert.equal(normalizeSearchQuery('中文 PostgreSQL 搜索'), '中文 postgresql 搜索');
  assert.equal(normalizeSearchQuery(' C++ [operators] 100% '), 'c++ [operators] 100%');
  assert.equal(normalizeSearchQuery(' \r\n\t '), null);
});

test('word_similarity threshold follows the query script: Han keeps the evidenced 0.15, other scripts tighten to 0.4', () => {
  assert.equal(SEARCH_HAN_WORD_SIMILARITY_THRESHOLD, '0.15');
  assert.equal(SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD, '0.4');
  assert.equal(searchWordSimilarityThreshold('中文搜索'), SEARCH_HAN_WORD_SIMILARITY_THRESHOLD);
  assert.equal(searchWordSimilarityThreshold('中文 postgresql 搜索'), SEARCH_HAN_WORD_SIMILARITY_THRESHOLD);
  assert.equal(searchWordSimilarityThreshold('needle'), SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD);
  assert.equal(searchWordSimilarityThreshold('café search'), SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD);
  // Katakana/Hangul have word boundaries via spacing or particles; only Han gets the loose arm.
  assert.equal(searchWordSimilarityThreshold('テスト'), SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD);
  // A nonce that only shares a coincidental substring with a real title must not clear the tightened bar.
  assert.equal(searchWordSimilarityThreshold('zzzxnotfoundxyz'), SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD);
});

test('extracts only a standard URL hostname at the materialization boundary', () => {
  assert.equal(extractSearchUrlHost('https://API.Example.COM:8443/path?q=secret'), 'api.example.com');
  assert.equal(extractSearchUrlHost('http://例え.テスト/path'), 'xn--r8jz45g.xn--zckzah');
  assert.equal(extractSearchUrlHost(null), null);
  assert.equal(extractSearchUrlHost('not a URL'), null);
  assert.equal(extractSearchUrlHost('mailto:user@example.com'), null);
  assert.equal(extractSearchUrlHost('https://user:password@example.com/private'), null);
});

test('candidate comparator has a complete deterministic exclusive tuple', () => {
  const candidate = (resourceType: 'collection' | 'node', resourceId: string): SearchCandidate => ({
    resourceType, resourceId, collectionId: resourceType === 'collection' ? resourceId : 'collection',
    title: 'Same title', urlHost: null, snippetSource: 'Same title', rank: 0.75,
    exclusive: { rank: 0.75, resourceType, resourceId },
  });
  const ordered = [candidate('node', 'b'), candidate('collection', 'z'), candidate('node', 'a')]
    .sort(compareSearchCandidateTuple);
  assert.deepEqual(ordered.map((item) => `${item.resourceType}:${item.resourceId}`), [
    'collection:z',
    'node:a',
    'node:b',
  ]);
});

test('loads closed, versioned quality corpus and target-scale thresholds', () => {
  const corpus = loadSearchQualityCorpus();
  assert.equal(corpus.version, 'phase2b-search-quality-v1');
  assert.ok(corpus.documents.some((item) => item.title.includes('中文')));
  assert.ok(corpus.cases.every((item) => item.expectedTopN.length > 0 && item.minimumRecall > 0));

  const thresholds = loadSearchPostgresThresholds();
  assert.equal(thresholds.version, 'phase2b-search-postgres-v1');
  assert.ok(thresholds.nodesPerCollection >= 10_000);
  assert.ok(thresholds.collectionCount >= 2);
  assert.equal(thresholds.parallelWorkers, 0);
  assert.ok(thresholds.measuredRuns >= 3);
});

test('candidate SQL binds the query and authority values as parameters, never inlining them', async () => {
  const { port, queries } = capturePostgresSearchSql();
  const adversarial = "'; DROP TABLE collections; -- %_\\";
  const normalized = normalizeSearchQuery(adversarial);
  assert.ok(normalized !== null);
  const result = await port.listAnonymousCandidates({ query: adversarial, limit: 20 });
  assert.deepEqual(result, { items: [], hasMore: false });

  const candidate = queries.find((query) => query.sql.includes('resource_type'));
  assert.ok(candidate, 'the candidate query must be compiled and executed');
  // SQL injection gate: every interpolated value is a bound placeholder and
  // the raw query text never reaches the compiled SQL.
  assert.equal((candidate.sql.match(/\$\d+/gu) ?? []).length, candidate.parameters.length,
    'every placeholder must have exactly one bound parameter');
  assert.doesNotMatch(candidate.sql, /DROP\s+TABLE|;\s*--/iu);
  assert.ok(candidate.parameters.includes(normalized), 'the normalized query must be a bound parameter');
  assert.doesNotMatch(candidate.sql, /%_|\\%|\\_/u, 'LIKE escape material must stay out of the SQL text');
});

test('candidate SQL configures evidenced thresholds transaction-locally and cancels the backend on abort', async () => {
  const { port, queries, candidateQueryStarted, resolveCandidateQuery } =
    capturePostgresSearchSql({ deferCandidateQuery: true });
  const controller = new AbortController();
  const pending = port.listCandidates({ query: 'needle', types: ['collection', 'node', 'profile', 'annotation'],
    limit: 10, timeoutMs: SEARCH_MAX_TIMEOUT_MS, projection: { kind: 'anonymous' }, signal: controller.signal });
  await candidateQueryStarted;
  controller.abort(new SearchQueryError('search_aborted'));
  resolveCandidateQuery();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof SearchQueryError && error.code === 'search_aborted');

  const configured = queries.find((query) => query.sql.includes('pg_backend_pid'));
  const candidate = queries.find((query) => query.sql.includes('resource_type'));
  const cancel = queries.find((query) => query.sql.includes('pg_cancel_backend'));
  assert.ok(configured, 'the session-config probe must run inside the transaction');
  assert.ok(candidate, 'the candidate query must run inside the transaction');
  assert.ok(cancel, 'an in-flight abort must issue pg_cancel_backend for the session backend');

  // Thresholds are configured transaction-locally (third argument true), never
  // session/global, and both the threshold and the timeout are bound as parameters.
  assert.match(configured.sql, /set_config\s*\(\s*'pg_trgm\.word_similarity_threshold'\s*,\s*\$\d+\s*,\s*true\s*\)/iu);
  assert.ok(configured.parameters.includes(searchWordSimilarityThreshold('needle')),
    'the word_similarity threshold must be the per-script value for the normalized query');
  assert.ok(configured.parameters.includes(SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD),
    'a Latin query must bind the tightened default threshold');
  assert.doesNotMatch(configured.sql, /'0\.15'|'0\.4'/u, 'the threshold must never be inlined into SQL text');
  assert.match(configured.sql, /set_config\s*\(\s*'statement_timeout'\s*,\s*\$\d+\s*,\s*true\s*\)/iu);
  assert.ok(configured.parameters.includes(`${SEARCH_MAX_TIMEOUT_MS}ms`),
    'the statement timeout must be bound from the evidenced maximum');
  assert.doesNotMatch(configured.sql, /SET\s+(?:SESSION|GLOBAL)|set_config\s*\([^)]*\bfalse\b/iu);
  assert.doesNotMatch(candidate.sql, /config\s+AS\s+MATERIALIZED|CROSS\s+JOIN\s+config/iu);

  // Recall operators the index plan evidence depends on stay wired.
  assert.match(candidate.sql, /\bword_similarity\b/iu);
  assert.match(candidate.sql, /OPERATOR\s*\(\s*public\.<%\)/iu);
  assert.match(candidate.sql, /\bsearch_vector\s*@@\s*plainto_tsquery/iu);
  assert.match(cancel.sql, /pg_cancel_backend\s*\(\s*\$\d+\s*\)/iu);
  assert.equal((candidate.sql.match(/search_strip_unsafe_text/gu) ?? []).length, 1,
    'snippet sanitization must run only after the bounded final candidate selection');
  assert.match(candidate.sql,
    /SELECT\s+resource_type[\s\S]*search_strip_unsafe_text\s*\(\s*snippet_source\s*\)[\s\S]*FROM\s+scored/iu);
});

test('a Han query binds the evidenced 0.15 threshold while a Latin query binds 0.4', async () => {
  const han = capturePostgresSearchSql();
  await han.port.listAnonymousCandidates({ query: '中文搜索', limit: 10 });
  const hanConfigured = han.queries.find((query) => query.sql.includes('pg_backend_pid'));
  assert.ok(hanConfigured, 'the session-config probe must run for Han queries');
  assert.ok(hanConfigured.parameters.includes(SEARCH_HAN_WORD_SIMILARITY_THRESHOLD));
  assert.ok(!hanConfigured.parameters.includes(SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD));

  const latin = capturePostgresSearchSql();
  await latin.port.listAnonymousCandidates({ query: 'zzzxnotfoundxyz', limit: 10 });
  const latinConfigured = latin.queries.find((query) => query.sql.includes('pg_backend_pid'));
  assert.ok(latinConfigured, 'the session-config probe must run for Latin queries');
  assert.ok(latinConfigured.parameters.includes(SEARCH_DEFAULT_WORD_SIMILARITY_THRESHOLD));
  assert.ok(!latinConfigured.parameters.includes(SEARCH_HAN_WORD_SIMILARITY_THRESHOLD));
});

test('candidate SQL re-checks authority (epoch, status, membership) inside the verified actor gate', async () => {
  const anonymous = capturePostgresSearchSql();
  await anonymous.port.listAnonymousCandidates({ query: 'needle', limit: 10 });
  const anonSql = anonymous.queries.find((query) => query.sql.includes('resource_type'));
  assert.ok(anonSql, 'anonymous candidate query must be compiled');
  assert.doesNotMatch(anonSql.sql, /verified_actor|actor_collections|collection_members/iu);
  assert.ok(!anonSql.parameters.includes(false), 'anonymous search must not bind an actor gate');
  assert.ok(!anonSql.parameters.some((value) => value === 'epoch-7' || value === 'account-owner' || value === 'subject-owner'),
    'no principal facts may be bound for anonymous projections');
  assert.doesNotMatch(anonSql.sql, /account-owner|subject-owner|security_epoch\s*=\s*'epoch-7'/iu);

  const account = capturePostgresSearchSql();
  await account.port.listCandidates({
    query: 'needle', types: ['collection', 'node', 'profile', 'annotation'], limit: 10, timeoutMs: SEARCH_MAX_TIMEOUT_MS,
    projection: { kind: 'account', accountId: 'account-owner', principalId: 'principal-owner',
      subjectId: 'subject-owner', securityEpoch: 'epoch-7' },
  });
  const accountSql = account.queries.find((query) => query.sql.includes('resource_type'));
  assert.ok(accountSql, 'account candidate query must be compiled');
  assert.ok(accountSql.parameters.includes(true), 'account projection must arm the verified actor gate');
  // NOTE: the epoch sentinel must not be a bare digit: the compiled SQL
  // legitimately contains the resource-order fallback literal 2147483647,
  // which would false-positive a substring scan for '7'.
  for (const fact of ['account-owner', 'principal-owner', 'subject-owner', 'epoch-7']) {
    assert.ok(accountSql.parameters.includes(fact), `${fact} must be a bound parameter`);
    assert.doesNotMatch(accountSql.sql, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `${fact} must never be inlined into the SQL text`);
  }
  // Authority recheck: the epoch, account status and deletion state are
  // evaluated inside the query so a stale epoch or revoked account fails closed.
  assert.match(accountSql.sql, /\ba\.security_epoch\b/iu);
  assert.match(accountSql.sql, /\ba\.status\s*=\s*(?:'active'|\$\d+)/iu);
  assert.ok(accountSql.parameters.includes('active') || /\ba\.status\s*=\s*'active'/iu.test(accountSql.sql),
    'the active-account predicate must be present');
  assert.match(accountSql.sql, /\ba\.deleted_at\s+IS\s+NULL/iu);
  assert.match(accountSql.sql, /verified_actor\s+AS\s+MATERIALIZED/iu);
  assert.doesNotMatch(accountSql.sql, /actor_collections/iu);
  assert.match(accountSql.sql, /member\.collection_id\s*=\s*c\.id/iu);
  assert.match(accountSql.sql, /OFFSET\s+0/iu);
  assert.match(accountSql.sql, /\bcollection_members\b/iu);

  const profileOnly = capturePostgresSearchSql();
  await profileOnly.port.listCandidates({
    query: 'needle', types: ['profile'], limit: 10, timeoutMs: SEARCH_MAX_TIMEOUT_MS,
    projection: { kind: 'account', accountId: 'account-owner', principalId: 'principal-owner',
      subjectId: 'subject-owner', securityEpoch: 'epoch-7' },
  });
  const profileSql = profileOnly.queries.find((query) => query.sql.includes('resource_type'));
  assert.ok(profileSql, 'profile-only candidate query must be compiled');
  assert.match(profileSql.sql, /branch_profile/iu);
  assert.doesNotMatch(profileSql.sql, /collection_members|actor_collections|verified_actor|branch_collection_|branch_node_|branch_annotation_/iu);
});

test('baseline migration keeps regex/LIKE scan paths out of materialization (static boundary)', async () => {
  const source = await readFile(
    new URL('../../../migrations/202607251000_postgres_search_baseline.ts', import.meta.url),
    'utf8',
  );
  // Static proof boundary: the installed catalog and EXPLAIN plans are
  // asserted live in search-postgres-baseline.integration.test.ts (immutable
  // generated columns, pg_trgm extension with fail-closed diagnostics, index
  // plans without sequential scans). This scan guards the irreplaceable
  // absence property: the generated materialization must never route through
  // regexp/substring/split_part or LIKE/ILIKE scanning, which a plan
  // assertion alone cannot distinguish from an indexed scan.
  assert.doesNotMatch(source, /regexp|substring\s*\(|split_part\s*\(/iu);
  assert.doesNotMatch(source, /\b(?:LIKE|ILIKE)\b/iu);
  assert.match(source, /forEachQueryPage/);
  assert.match(source, /keysetIdPredicate/);
  assert.match(source, /limit \$\{limit\}/);
  assert.doesNotMatch(source, /select id,url from nodes order by id`\.execute/iu);
});
