import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'vitest';
import { createLogger, InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createSearchCursorSigner,
  createSearchTelemetry,
  executeSearchQuery,
  SearchQueryError,
  type SearchAuthorityFact,
  type SearchCandidate,
  type SearchQueryPorts,
} from '../../../src/modules/search/index.js';
import type { SharedExposureFactsPort } from '../../../src/modules/attachments/index.js';

/** P4A-R06: the fixture offers no blob facts; the deny-by-default gate projects nothing. */
const NO_BLOBS: SharedExposureFactsPort = Object.freeze({ async listBlobFacts() { return []; } });

const SENSITIVE = Object.freeze({
  query: 'query-marker-4b7250e7',
  cursor: 'cursor-marker-5ac842d1',
  principal: 'principal-marker-8d00a21c',
  resource: 'resource-marker-831cac0f',
});

test('P2B-26 emits bounded Search metrics and redacted structured success logs from production facts', async () => {
  const captured: string[] = [];
  const destination = new Writable({ write(chunk, _encoding, done) { captured.push(String(chunk)); done(); } });
  const metrics = new InMemoryMetrics();
  const candidates = [candidate(SENSITIVE.resource, 1), candidate('public-result', 0.9)];
  const ports = harness(metrics, createLogger('info', destination), {
    candidates,
    facts: [fact('public-result')],
  });

  const result = await executeSearchQuery(ports, {
    principal: { kind: 'account', accountId: SENSITIVE.principal, principalId: SENSITIVE.principal,
      subjectId: `${SENSITIVE.principal}-subject`, securityEpoch: '7' },
    query: SENSITIVE.query,
    types: ['collection'],
  });

  assert.equal(result.page.returnedCount, 1);
  assert.equal(metrics.get('search.query.total.outcome.success'), 1);
  assert.equal(metrics.get('search.query.candidates.bucket.001_010'), 1);
  assert.equal(metrics.get('search.query.authorized.bucket.001_010'), 1);
  assert.equal(metrics.get('search.query.results.bucket.001_010'), 1);
  assert.equal(metrics.get('search.query.rounds.bucket.1'), 1);
  assert.equal(metrics.get('search.query.result_class.partial'), 1);
  assert.equal(metrics.get('search.query.resource_type.collection'), 1);
  assert.equal(metrics.observations('search.query.latency_ms.outcome.success').length, 1);

  const output = captured.join('');
  assert.match(output, /"event":"search_query"/u);
  assert.match(output, /"outcome":"success"/u);
  assert.match(output, /"candidateBucket":"001_010"/u);
  for (const marker of Object.values(SENSITIVE)) assert.doesNotMatch(output, new RegExp(marker, 'u'));
  assertNoSensitiveSearchLogFields(output);
  // Pino's default `hostname` is the machine name. Hosts named `cursor` (CI)
  // must not be classified as a leaked Search cursor field.
  assertNoSensitiveSearchLogFields(output.replace(/"hostname":"[^"]*"/gu, '"hostname":"cursor"'));
});

test('P2B-26 counts zero results, timeout, abort, and errors without accepting high-cardinality labels', async () => {
  for (const scenario of [
    { name: 'zero', error: null, expectedOutcome: 'success', expectedClass: 'zero' },
    { name: 'timeout', error: new SearchQueryError('search_timeout'), expectedOutcome: 'timeout', expectedClass: 'failure' },
    { name: 'abort', error: new SearchQueryError('search_aborted'), expectedOutcome: 'abort', expectedClass: 'failure' },
    { name: 'invalid-cursor', error: null, cursor: SENSITIVE.cursor,
      expectedOutcome: 'invalid', expectedClass: 'failure' },
    { name: 'error', error: Object.assign(new Error(`database ${SENSITIVE.query}`), { code: 'XX000' }),
      expectedOutcome: 'error', expectedClass: 'failure' },
  ] as const) {
    const output: string[] = [];
    const destination = new Writable({ write(chunk, _encoding, done) { output.push(String(chunk)); done(); } });
    const metrics = new InMemoryMetrics();
    const ports = harness(metrics, createLogger('info', destination), {
      candidates: [], facts: [], candidateError: scenario.error,
    });
    const invocation = executeSearchQuery(ports, { principal: { kind: 'anonymous' }, query: SENSITIVE.query,
      ...('cursor' in scenario ? { cursor: scenario.cursor } : {}) });
    if (scenario.error === null && !('cursor' in scenario)) await invocation;
    else await assert.rejects(invocation);

    assert.equal(metrics.get(`search.query.total.outcome.${scenario.expectedOutcome}`), 1, scenario.name);
    assert.equal(metrics.get(`search.query.result_class.${scenario.expectedClass}`), 1, scenario.name);
    if (scenario.name === 'zero') assert.equal(metrics.get('search.query.zero_result.total'), 1);
    if (scenario.name === 'timeout') assert.equal(metrics.get('search.query.timeout.total'), 1);
    const rendered = output.join('');
    assert.doesNotMatch(rendered, new RegExp(SENSITIVE.query, 'u'));
    assert.doesNotMatch(rendered, new RegExp(SENSITIVE.cursor, 'u'));
    assert.doesNotMatch(rendered, /XX000|database/u);
    assertNoSensitiveSearchLogFields(rendered.replace(/"hostname":"[^"]*"/gu, '"hostname":"cursor"'));
  }

  assert.throws(() => createSearchTelemetry({ metrics: new InMemoryMetrics(), logger: createLogger('silent'),
    metricPrefix: SENSITIVE.query as never }), /metric prefix/u);
});

test('P2B-26 rejects unknown dimensions and factually impossible count relationships', () => {
  const telemetry = createSearchTelemetry({ metrics: new InMemoryMetrics(), logger: createLogger('silent') });
  const base = { outcome: 'success' as const, resourceTypes: ['collection'], candidateCount: 2,
    authorizedCount: 1, resultCount: 1, requestedCount: 20, roundCount: 1, latencyMs: 5 };
  assert.throws(() => telemetry.record({ ...base, resourceTypes: [SENSITIVE.resource] }), /resource type/u);
  assert.throws(() => telemetry.record({ ...base, authorizedCount: 3 }),
    /candidate >= authorized >= result/u);
  assert.throws(() => telemetry.record({ ...base, resultCount: 2 }),
    /candidate >= authorized >= result/u);
  assert.throws(() => telemetry.record({ ...base, candidateCount: Number.NaN }), /candidateCount/u);
  assert.throws(() => telemetry.record({ ...base, roundCount: 1.5 }), /roundCount/u);
});

const SENSITIVE_SEARCH_LOG_KEYS =
  /"(queryDigest|queryHash|cursor|principal|resourceId|handle|snippet)"\s*:/u;

function assertNoSensitiveSearchLogFields(serialized: string): void {
  assert.doesNotMatch(serialized, SENSITIVE_SEARCH_LOG_KEYS);
}

function harness(metrics: InMemoryMetrics, logger: ReturnType<typeof createLogger>, input: {
  candidates: readonly SearchCandidate[];
  facts: readonly SearchAuthorityFact[];
  candidateError?: unknown;
}): SearchQueryPorts {
  return {
    candidates: { async listCandidates() {
      if (input.candidateError) throw input.candidateError;
      return { items: input.candidates, hasMore: false };
    } },
    authority: { async loadBatch() { return input.facts; } },
    cursors: createSearchCursorSigner({ current: { id: 'telemetry-v1', key: 'telemetry-test-key-material-0001' } }),
    clock: { now: () => new Date() },
    telemetry: createSearchTelemetry({ metrics, logger }),
    sharedExposure: NO_BLOBS,
  };
}

function candidate(resourceId: string, rank: number): SearchCandidate {
  return { resourceType: 'collection', resourceId, collectionId: resourceId, rank,
    exclusive: { rank, resourceType: 'collection', resourceId } };
}

function fact(resourceId: string): SearchAuthorityFact {
  return { resourceType: 'collection', resourceId, collectionId: resourceId,
    ownerSubjectId: 'owner-subject', membershipRole: null, visibility: 'public',
    allowSearchIndexing: true, policyRevision: 'p1', deleted: false,
    title: 'Public result', snippetSource: 'Public snippet' };
}
