import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'vitest';
import {
  SEARCH_CANDIDATE_BATCH_LIMIT,
  SEARCH_COMPARATOR_VERSION,
  SEARCH_CURSOR_PURPOSE,
  SEARCH_CURSOR_TTL_MS,
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_FIRST_PAGE_CACHE_TTL_MS,
  SEARCH_MAX_CANDIDATES,
  SEARCH_MAX_ROUNDS,
  SearchQueryError,
  createSearchCursorSigner,
  createSearchFirstPageCache,
  executeSearchQuery,
  type SearchAuthorityFact,
  type SearchAuthorityPort,
  type SearchCandidate,
  type SearchCandidatePort,
  type SearchPrincipal,
  type SearchResourceType,
} from '../../../src/modules/search/index.js';
import type { SharedExposureFactsPort } from '../../../src/modules/attachments/index.js';

/** P4A-R06: the fixture offers no blob facts; the deny-by-default gate projects nothing. */
const NO_BLOBS: SharedExposureFactsPort = Object.freeze({ async listBlobFacts() { return []; } });

const NOW = new Date('2026-07-25T12:00:00.000Z');
const KEYS = { current: { id: 'search-k2', key: 'search-current-key-material-32-bytes' },
  previous: [{ id: 'search-k1', key: 'search-previous-key-material-32-bytes',
    retainUntil: '2026-07-25T13:00:00.000Z' }] } as const;
const ANONYMOUS: SearchPrincipal = { kind: 'anonymous' };
const OWNER: SearchPrincipal = { kind: 'account', accountId: 'account-owner', principalId: 'principal-owner',
  subjectId: 'subject-owner', securityEpoch: '7' };
const MEMBER: SearchPrincipal = { kind: 'account', accountId: 'account-member', principalId: 'principal-member',
  subjectId: 'subject-member', securityEpoch: '3' };
const OUTSIDER: SearchPrincipal = { kind: 'account', accountId: 'account-outsider', principalId: 'principal-outsider',
  subjectId: 'subject-outsider', securityEpoch: '1' };

function collectionCandidate(id: string, rank = 0.8): SearchCandidate {
  return { resourceType: 'collection', resourceId: id, collectionId: id, title: `stale ${id}`,
    urlHost: null, snippetSource: `stale secret ${id}`, rank,
    exclusive: { rank, resourceType: 'collection', resourceId: id } };
}

function nodeCandidate(id: string, collectionId = 'public', rank = 0.8): SearchCandidate {
  return { resourceType: 'node', resourceId: id, collectionId, title: `stale ${id}`,
    urlHost: 'stale.invalid', snippetSource: `stale secret ${id}`, rank,
    exclusive: { rank, resourceType: 'node', resourceId: id } };
}

function profileCandidate(handle: string, rank = 0.8): SearchCandidate {
  return { resourceType: 'profile', resourceId: handle, collectionId: null, handle,
    displayName: 'Stale profile', snippetSource: 'stale profile secret', rank,
    exclusive: { rank, resourceType: 'profile', resourceId: handle } };
}

function annotationCandidate(id: string, collectionId = 'public', rank = 0.8): SearchCandidate {
  return { resourceType: 'annotation', resourceId: id, collectionId, subjectType: 'node',
    subjectId: `${collectionId}-node`, annotationType: 'note', snippetSource: 'stale annotation secret', rank,
    exclusive: { rank, resourceType: 'annotation', resourceId: id } };
}

function collectionFact(id: string, overrides: Partial<Extract<SearchAuthorityFact, { resourceType: 'collection' }>> = {}): SearchAuthorityFact {
  return { resourceType: 'collection', resourceId: id, collectionId: id, ownerSubjectId: 'subject-owner',
    membershipRole: null, visibility: 'public', allowSearchIndexing: true, policyRevision: 'p1',
    deleted: false, title: `Current ${id}`, snippetSource: `current safe ${id}`, ...overrides };
}

function nodeFact(id: string, collectionId = 'public', overrides: Partial<Extract<SearchAuthorityFact, { resourceType: 'node' }>> = {}): SearchAuthorityFact {
  return { resourceType: 'node', resourceId: id, collectionId, ownerSubjectId: 'subject-owner',
    membershipRole: null, collectionVisibility: 'public', allowSearchIndexing: true, policyRevision: 'p1',
    collectionDeleted: false, visibility: 'inherit', ancestorRestricted: false, deleted: false,
    title: `Current ${id}`, urlHost: 'current.example', snippetSource: `current safe ${id}`, ...overrides };
}

function profileFact(handle: string, overrides: Partial<Extract<SearchAuthorityFact, { resourceType: 'profile' }>> = {}): SearchAuthorityFact {
  return { resourceType: 'profile', resourceId: handle, accountStatus: 'active', accountDeleted: false,
    searchablePublicCollection: true, handle, displayName: 'Current Profile', avatarUrl: 'https://example.test/avatar.png',
    snippetSource: 'current profile safe', ...overrides };
}

function annotationFact(id: string, collectionId = 'public', overrides: Partial<Extract<SearchAuthorityFact, { resourceType: 'annotation' }>> = {}): SearchAuthorityFact {
  return { resourceType: 'annotation', resourceId: id, collectionId, ownerSubjectId: 'subject-owner',
    membershipRole: null, collectionVisibility: 'public', allowSearchIndexing: true, policyRevision: 'p1',
    collectionDeleted: false, visibility: 'public', creatorPrincipalId: 'principal-owner', deleted: false,
    subjectType: 'node', subjectId: `${collectionId}-node`, subjectDeleted: false,
    subjectVisibility: 'inherit', subjectAncestorRestricted: false, annotationType: 'note',
    snippetSource: 'current annotation safe', ...overrides };
}

function harness(candidates: readonly SearchCandidate[], facts: ReadonlyMap<string, SearchAuthorityFact>,
  options: { now?: () => Date; candidateHasMore?: boolean } = {}) {
  const candidateCalls: Array<Record<string, unknown>> = [];
  const authorityCalls: Array<readonly string[]> = [];
  const candidatePort: SearchCandidatePort = {
    async listAnonymousCandidates(input) { return this.listCandidates({ ...input,
      types: ['collection', 'node', 'profile', 'annotation'], projection: { kind: 'anonymous' }, timeoutMs: 5_000 }); },
    async listCandidates(input) {
      candidateCalls.push(input as unknown as Record<string, unknown>);
      if (input.signal?.aborted) throw input.signal.reason;
      const start = input.after === undefined ? 0 : candidates.findIndex((item) =>
        item.exclusive.rank === input.after?.rank && item.exclusive.resourceType === input.after.resourceType
          && item.exclusive.resourceId === input.after.resourceId) + 1;
      const filtered = candidates.slice(start).filter((item) => input.types.includes(item.resourceType));
      return { items: filtered.slice(0, input.limit),
        hasMore: options.candidateHasMore === true || filtered.length > input.limit };
    },
  };
  const authority: SearchAuthorityPort = { async loadBatch(input) {
    authorityCalls.push(input.candidates.map((item) => `${item.resourceType}:${item.resourceId}`));
    if (input.signal?.aborted) throw input.signal.reason;
    return input.candidates.flatMap((candidate) => {
      const fact = facts.get(`${candidate.resourceType}:${candidate.resourceId}`);
      return fact === undefined ? [] : [fact];
    });
  } };
  return { ports: { candidates: candidatePort, authority, cursors: createSearchCursorSigner(KEYS),
    clock: { now: options.now ?? (() => NOW) }, sharedExposure: NO_BLOBS }, candidateCalls, authorityCalls };
}

test('normalizes the query and a closed canonical type filter and rejects empty or invalid input', async () => {
  const { ports, candidateCalls } = harness([], new Map());
  const result = await executeSearchQuery(ports, { principal: ANONYMOUS,
    query: '  Cafe\u0301\tSEARCH  ', types: ['profile', 'collection', 'profile'], pageSize: 7 });
  assert.equal(result.normalizedQuery, 'café search');
  assert.deepEqual(candidateCalls[0]?.types, ['collection', 'profile']);
  assert.equal(candidateCalls[0]?.query, 'café search');
  assert.equal(result.page.returnedCount, 0);
  for (const input of [
    { principal: ANONYMOUS, query: '' },
    { principal: ANONYMOUS, query: '   ' },
    { principal: ANONYMOUS, query: 'x', types: [] },
    { principal: ANONYMOUS, query: 'x', types: ['relation' as SearchResourceType] },
    { principal: ANONYMOUS, query: 'x', pageSize: 0 },
    { principal: ANONYMOUS, query: 'x', pageSize: 101 },
  ]) await assert.rejects(executeSearchQuery(ports, input), (error: unknown) =>
    error instanceof SearchQueryError && error.code === 'invalid_search_query');
  assert.equal(SEARCH_DEFAULT_PAGE_SIZE > 0, true);
});

test('re-authorizes anonymous, owner, member, and outsider projections from current facts', async () => {
  const candidates = [
    collectionCandidate('public', 1), collectionCandidate('unlisted', 0.99),
    collectionCandidate('protected', 0.98), collectionCandidate('private', 0.97),
    nodeCandidate('hidden-node', 'public', 0.96), annotationCandidate('private-note', 'public', 0.95),
  ];
  const base = new Map<string, SearchAuthorityFact>([
    ['collection:public', collectionFact('public')],
    ['collection:unlisted', collectionFact('unlisted', { visibility: 'unlisted' })],
    ['collection:protected', collectionFact('protected', { visibility: 'protected' })],
    ['collection:private', collectionFact('private', { visibility: 'private' })],
    ['node:hidden-node', nodeFact('hidden-node', 'public', { visibility: 'private' })],
    ['annotation:private-note', annotationFact('private-note', 'public', { visibility: 'private' })],
  ]);
  const ids = async (principal: SearchPrincipal, member: boolean) => {
    const facts = new Map([...base].map(([key, fact]) => [key,
      member && fact.resourceType !== 'profile' ? { ...fact, membershipRole: 'viewer' as const } : fact]));
    const result = await executeSearchQuery(harness(candidates, facts).ports, { principal, query: 'safe', pageSize: 20 });
    return result.items.map((item) => `${item.resourceType}:${item.resourceId}`);
  };
  assert.deepEqual(await ids(ANONYMOUS, false), ['collection:public']);
  assert.deepEqual(await ids(OUTSIDER, false), ['collection:public']);
  assert.deepEqual(await ids(MEMBER, true), [
    'collection:public', 'collection:unlisted', 'collection:protected', 'collection:private', 'node:hidden-node',
  ]);
  assert.deepEqual(await ids(OWNER, false), [
    'collection:public', 'collection:unlisted', 'collection:protected', 'collection:private',
    'node:hidden-node', 'annotation:private-note',
  ]);
});

test('fails closed for stale candidates and maps snippets and DTO fields only from authorized facts', async () => {
  const candidates = [collectionCandidate('private-now', 1), collectionCandidate('deleted', 0.99),
    collectionCandidate('optout', 0.98), nodeCandidate('deleted-node', 'public', 0.97),
    nodeCandidate('ancestor-hidden', 'public', 0.96), profileCandidate('deleted-profile', 0.95),
    annotationCandidate('deleted-subject', 'public', 0.94), collectionCandidate('safe', 0.93)];
  const facts = new Map<string, SearchAuthorityFact>([
    ['collection:private-now', collectionFact('private-now', { visibility: 'private' })],
    ['collection:deleted', collectionFact('deleted', { deleted: true })],
    ['collection:optout', collectionFact('optout', { allowSearchIndexing: false })],
    ['node:deleted-node', nodeFact('deleted-node', 'public', { deleted: true })],
    ['node:ancestor-hidden', nodeFact('ancestor-hidden', 'public', { ancestorRestricted: true })],
    ['profile:deleted-profile', profileFact('deleted-profile', { accountDeleted: true })],
    ['annotation:deleted-subject', annotationFact('deleted-subject', 'public', { subjectDeleted: true })],
    ['collection:safe', collectionFact('safe')],
  ]);
  const result = await executeSearchQuery(harness(candidates, facts).ports,
    { principal: ANONYMOUS, query: 'secret query', pageSize: 20 });
  assert.deepEqual(result.items, [{ resourceType: 'collection', resourceId: 'safe', title: 'Current safe',
    snippet: 'current safe safe', rank: 0.93 }]);
  assert.doesNotMatch(JSON.stringify(result), /stale secret|private-now|deleted-profile/u);
});

test('batches authority facts, backfills filtered candidates, and keeps amplification bounded', async () => {
  const candidates = Array.from({ length: SEARCH_MAX_CANDIDATES + 25 }, (_, index) =>
    collectionCandidate(`c-${String(index).padStart(3, '0')}`, Number((1 - index / 10_000).toFixed(6))));
  const facts = new Map<string, SearchAuthorityFact>(candidates.map((item, index) => [
    `collection:${item.resourceId}`,
    collectionFact(item.resourceId, { visibility: index < SEARCH_CANDIDATE_BATCH_LIMIT + 2 ? 'private' : 'public' }),
  ]));
  const { ports, candidateCalls, authorityCalls } = harness(candidates, facts);
  const result = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'bounded', pageSize: 3 });
  assert.deepEqual(result.items.map((item) => item.resourceId), [
    `c-${String(SEARCH_CANDIDATE_BATCH_LIMIT + 2).padStart(3, '0')}`,
    `c-${String(SEARCH_CANDIDATE_BATCH_LIMIT + 3).padStart(3, '0')}`,
    `c-${String(SEARCH_CANDIDATE_BATCH_LIMIT + 4).padStart(3, '0')}`,
  ]);
  assert.ok(candidateCalls.length > 1 && candidateCalls.length <= SEARCH_MAX_ROUNDS);
  assert.equal(authorityCalls.length, candidateCalls.length);
  assert.ok(authorityCalls.every((batch) => batch.length <= SEARCH_CANDIDATE_BATCH_LIMIT));
  assert.ok(authorityCalls.flat().length <= SEARCH_MAX_CANDIDATES);
  assert.equal(result.page.hasMore, true);

  const allDenied = new Map<string, SearchAuthorityFact>(candidates.map((item) => [
    `collection:${item.resourceId}`, collectionFact(item.resourceId, { visibility: 'private' }),
  ]));
  const deniedHarness = harness(candidates, allDenied);
  const denied = await executeSearchQuery(deniedHarness.ports,
    { principal: ANONYMOUS, query: 'bounded', pageSize: 10 });
  assert.deepEqual(denied.items, []);
  assert.equal(denied.page.hasMore, true);
  assert.equal(deniedHarness.candidateCalls.length, SEARCH_MAX_ROUNDS);
  assert.deepEqual(deniedHarness.authorityCalls.map((batch) => batch.length), [100, 100, 100, 100]);
  assert.equal(deniedHarness.authorityCalls.flat().length, SEARCH_MAX_CANDIDATES);
  assert.ok(denied.page.nextCursor);
});

test('search without attachment output never loads collection attachment history', async () => {
  // Ranks must be exact at the comparator's 6-decimal precision.
  const candidates = Array.from({ length: 12 }, (_, index) => collectionCandidate(`x-${index}`, 1 - index / 1_000_000));
  const facts = new Map<string, SearchAuthorityFact>(candidates.map((item) => [
    `collection:${item.resourceId}`, collectionFact(item.resourceId, { visibility: 'public' }),
  ]));
  const base = harness(candidates, facts);
  const ports = { ...base.ports, sharedExposure: {
    async listBlobFacts() { throw new Error('unrelated attachment history must not be queried'); },
  } };
  const result = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'exposure', pageSize: 5 });
  assert.equal(result.items.length, 5);
});

test('fails closed for missing, malformed, mismatched, and unsafe current authority facts', async () => {
  const candidates = [collectionCandidate('missing', 1), collectionCandidate('unsafe', 0.9),
    annotationCandidate('wrong-subject', 'public', 0.8), collectionCandidate('valid', 0.7)];
  const malformed = collectionFact('unsafe', { title: 'x'.repeat(513), snippetSource: 'x'.repeat(1_025) });
  const facts = new Map<string, SearchAuthorityFact>([
    ['collection:unsafe', malformed],
    ['annotation:wrong-subject', annotationFact('wrong-subject', 'public', {
      subjectType: 'collection', subjectId: 'different-collection', subjectVisibility: null,
    })],
    ['collection:valid', collectionFact('valid')],
  ]);
  const result = await executeSearchQuery(harness(candidates, facts).ports,
    { principal: ANONYMOUS, query: 'closed', pageSize: 10 });
  assert.deepEqual(result.items.map((item) => item.resourceId), ['valid']);
  assert.deepEqual(result.consistency, { authority: 'recheck-each-page', ranking: 'restart-on-mutation' });
  assert.doesNotMatch(JSON.stringify(result), /different-collection|stale secret/u);
});

test('reports continuation only when an authorized item or an unexamined candidate page remains', async () => {
  const candidates = [collectionCandidate('visible', 1), collectionCandidate('denied-a', 0.9),
    collectionCandidate('denied-b', 0.8)];
  const facts = new Map<string, SearchAuthorityFact>([
    ['collection:visible', collectionFact('visible')],
    ['collection:denied-a', collectionFact('denied-a', { visibility: 'private' })],
    ['collection:denied-b', collectionFact('denied-b', { visibility: 'private' })],
  ]);
  const exhausted = await executeSearchQuery(harness(candidates, facts).ports,
    { principal: ANONYMOUS, query: 'exact', pageSize: 1 });
  assert.deepEqual(exhausted.items.map((item) => item.resourceId), ['visible']);
  assert.deepEqual(exhausted.page, { returnedCount: 1, hasMore: false, nextCursor: null });

  const unexamined = await executeSearchQuery(harness(candidates, facts, { candidateHasMore: true }).ports,
    { principal: ANONYMOUS, query: 'exact', pageSize: 1 });
  assert.equal(unexamined.page.hasMore, true);
  assert.ok(unexamined.page.nextCursor);
});

test('honors timeout and abort before another port call and never signs a continuation', async () => {
  const candidates = [collectionCandidate('denied', 1), collectionCandidate('would-run', 0.9)];
  const facts = new Map<string, SearchAuthorityFact>([
    ['collection:denied', collectionFact('denied', { visibility: 'private' })],
    ['collection:would-run', collectionFact('would-run')],
  ]);
  let tick = 0;
  const timed = harness(candidates, facts, { now: () => new Date(NOW.getTime() + tick++ * 1_000) });
  await assert.rejects(executeSearchQuery(timed.ports,
    { principal: ANONYMOUS, query: 'timeout', pageSize: 2, timeoutMs: 500 }),
  (error: unknown) => error instanceof SearchQueryError && error.code === 'search_timeout');
  assert.ok(timed.candidateCalls.length <= 1);

  const controller = new AbortController(); controller.abort(new Error('caller cancelled'));
  const aborted = harness(candidates, facts);
  await assert.rejects(executeSearchQuery(aborted.ports,
    { principal: ANONYMOUS, query: 'abort', signal: controller.signal }),
  (error: unknown) => error instanceof SearchQueryError && error.code === 'search_aborted');
  assert.equal(aborted.candidateCalls.length, 0);

  let blockedCalls = 0;
  const blockedCandidates: SearchCandidatePort = {
    listAnonymousCandidates: async () => ({ items: [], hasMore: false }),
    async listCandidates(input) {
      blockedCalls += 1;
      await new Promise<void>((_resolve, reject) => input.signal?.addEventListener('abort',
        () => reject(input.signal?.reason), { once: true }));
      return { items: [], hasMore: false };
    },
  };
  const started = Date.now();
  await assert.rejects(executeSearchQuery({ candidates: blockedCandidates,
    authority: { async loadBatch() { throw new Error('authority must not run'); } },
    cursors: createSearchCursorSigner(KEYS), clock: { now: () => NOW }, sharedExposure: NO_BLOBS },
  { principal: ANONYMOUS, query: 'deadline', timeoutMs: 30 }),
  (error: unknown) => error instanceof SearchQueryError && error.code === 'search_timeout');
  assert.equal(blockedCalls, 1);
  assert.ok(Date.now() - started < 1_000);
});

test('uses an opaque independent cursor bound to query, types, page size, comparator and principal projection', async () => {
  const candidates = [collectionCandidate('a', 1), collectionCandidate('b', 0.9), collectionCandidate('c', 0.8)];
  const facts = new Map(candidates.map((item) => [`collection:${item.resourceId}`, collectionFact(item.resourceId)]));
  const { ports } = harness(candidates, facts);
  const first = await executeSearchQuery(ports, { principal: OWNER, query: 'Sensitive Needle',
    types: ['collection'], pageSize: 1 });
  assert.ok(first.page.nextCursor);
  assert.equal(first.cache.class, 'private-no-store');
  const encoded = first.page.nextCursor!.split('.')[1]!;
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  assert.doesNotMatch(decoded, /Sensitive|Needle|sensitive needle|Current|snippet|account-owner|subject-owner|principal-owner/u);
  assert.match(decoded, new RegExp(SEARCH_CURSOR_PURPOSE));
  assert.match(decoded, new RegExp(SEARCH_COMPARATOR_VERSION));
  const second = await executeSearchQuery(ports, { principal: OWNER, query: ' sensitive   needle ',
    types: ['collection'], cursor: first.page.nextCursor! });
  assert.deepEqual(second.items.map((item) => item.resourceId), ['b']);
  for (const changed of [
    { principal: MEMBER, query: 'sensitive needle', types: ['collection'] as const },
    { principal: ANONYMOUS, query: 'sensitive needle', types: ['collection'] as const },
    { principal: OWNER, query: 'different', types: ['collection'] as const },
    { principal: OWNER, query: 'sensitive needle', types: ['node'] as const },
    { principal: OWNER, query: 'sensitive needle', types: ['collection'] as const, pageSize: 2 },
  ]) await assert.rejects(executeSearchQuery(ports, { ...changed, cursor: first.page.nextCursor! }),
    (error: unknown) => error instanceof SearchQueryError && error.code === 'invalid_cursor');

  const tampered = `${first.page.nextCursor!.slice(0, -1)}x`;
  await assert.rejects(executeSearchQuery(ports, { principal: OWNER, query: 'sensitive needle',
    types: ['collection'], cursor: tampered }), (error: unknown) =>
    error instanceof SearchQueryError && error.code === 'invalid_cursor');
  for (const invalid of [
    `unknown.${first.page.nextCursor!.split('.').slice(1).join('.')}`,
    first.page.nextCursor!.slice(0, -8),
    first.page.nextCursor!.replace('.', '.+'),
  ]) await assert.rejects(executeSearchQuery(ports, { principal: OWNER, query: 'sensitive needle',
    types: ['collection'], cursor: invalid }), (error: unknown) =>
    error instanceof SearchQueryError && error.code === 'invalid_cursor');
});

test('accepts retained previous keys, rejects expiry and cross-purpose tokens, and binds anonymous shared cache partition', async () => {
  const candidates = [collectionCandidate('a', 1), collectionCandidate('b', 0.9), collectionCandidate('c', 0.8)];
  const facts = new Map(candidates.map((item) => [`collection:${item.resourceId}`, collectionFact(item.resourceId)]));
  const old = createSearchCursorSigner({ current: KEYS.previous[0] });
  const oldPorts = { ...harness(candidates, facts).ports, cursors: old };
  const first = await executeSearchQuery(oldPorts, { principal: ANONYMOUS, query: 'cache', pageSize: 1 });
  const rotated = harness(candidates, facts).ports;
  const continued = await executeSearchQuery(rotated, { principal: ANONYMOUS, query: 'cache', cursor: first.page.nextCursor! });
  assert.deepEqual(continued.items.map((item) => item.resourceId), ['b']);
  assert.ok(continued.page.nextCursor);
  const afterRotation = await executeSearchQuery(rotated, { principal: ANONYMOUS, query: 'cache',
    cursor: continued.page.nextCursor! });
  assert.deepEqual(afterRotation.items.map((item) => item.resourceId), ['c']);
  assert.equal(continued.cache.class, 'shared-public');
  assert.match(continued.cache.partition, /^[A-Za-z0-9_-]{43}$/u);

  const expiredPorts = { ...rotated, clock: { now: () => new Date('2026-07-25T13:01:00.000Z') } };
  await assert.rejects(executeSearchQuery(expiredPorts, { principal: ANONYMOUS, query: 'cache',
    cursor: first.page.nextCursor! }), (error: unknown) => error instanceof SearchQueryError && error.code === 'invalid_cursor');
  const [, originalEncoded] = continued.page.nextCursor!.split('.');
  const foreignPayload = JSON.parse(Buffer.from(originalEncoded!, 'base64url').toString('utf8')) as Record<string, unknown>;
  foreignPayload.purpose = 'product-reading-progress-cursor';
  foreignPayload.keyVersion = KEYS.current.id;
  const foreignEncoded = Buffer.from(JSON.stringify(foreignPayload)).toString('base64url');
  const derived = createHmac('sha256', KEYS.current.key).update(SEARCH_CURSOR_PURPOSE).digest('base64url');
  const signCurrent = (payload: Record<string, unknown>) => {
    payload.keyVersion = KEYS.current.id;
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', derived).update(encoded).digest('base64url');
    return `${KEYS.current.id}.${encoded}.${signature}`;
  };
  const foreignSignature = createHmac('sha256', derived).update(foreignEncoded).digest('base64url');
  const foreign = `${KEYS.current.id}.${foreignEncoded}.${foreignSignature}`;
  await assert.rejects(executeSearchQuery(rotated, { principal: ANONYMOUS, query: 'cache', cursor: foreign }),
    (error: unknown) => error instanceof SearchQueryError && error.code === 'invalid_cursor');
  const openPayload = JSON.parse(Buffer.from(originalEncoded!, 'base64url').toString('utf8')) as Record<string, unknown>;
  openPayload.keyVersion = KEYS.current.id;
  openPayload.rawQuery = 'cache';
  const openEncoded = Buffer.from(JSON.stringify(openPayload)).toString('base64url');
  const openSignature = createHmac('sha256', derived).update(openEncoded).digest('base64url');
  await assert.rejects(executeSearchQuery(rotated, { principal: ANONYMOUS, query: 'cache',
    cursor: `${KEYS.current.id}.${openEncoded}.${openSignature}` }),
  (error: unknown) => error instanceof SearchQueryError && error.code === 'invalid_cursor');

  const basePayload = JSON.parse(Buffer.from(originalEncoded!, 'base64url').toString('utf8')) as Record<string, unknown>;
  const invalidPayloads: Record<string, unknown>[] = [
    { ...basePayload, issuedAt: '2026-07-25T12:30:00.000Z', expiresAt: '2026-07-25T12:40:00.000Z' },
    { ...basePayload, comparatorVersion: 'rank-ascending-v0' },
    { ...basePayload, pageSize: 1.5 },
    { ...basePayload, restart: { version: 1, mode: 'silent-mutation', exhaustedBudget: false } },
  ];
  for (const payload of invalidPayloads) {
    await assert.rejects(executeSearchQuery(rotated, { principal: ANONYMOUS, query: 'cache',
      cursor: signCurrent(payload) }),
    (error: unknown) => error instanceof SearchQueryError && error.code === 'invalid_cursor');
  }
  await assert.rejects(executeSearchQuery(rotated, { principal: ANONYMOUS, query: 'cache',
    cursor: 'x'.repeat(2_049) }),
  (error: unknown) => error instanceof SearchQueryError && error.code === 'invalid_cursor');
});

test('traverses frozen candidates without duplicates and re-authorizes after a cross-page revocation', async () => {
  const candidates = Array.from({ length: 7 }, (_, index) => collectionCandidate(`item-${index}`, 1 - index / 10));
  const facts = new Map(candidates.map((item) => [`collection:${item.resourceId}`, collectionFact(item.resourceId)]));
  const { ports } = harness(candidates, facts);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'frozen',
      types: ['collection'], ...(cursor ? { cursor } : { pageSize: 2 }) });
    seen.push(...page.items.map((item) => item.resourceId));
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, candidates.map((item) => item.resourceId));
  assert.equal(new Set(seen).size, seen.length);

  const first = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'frozen', pageSize: 2 });
  facts.set('collection:item-2', collectionFact('item-2', { visibility: 'private', policyRevision: 'p2' }));
  const afterRevoke = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'frozen',
    cursor: first.page.nextCursor! });
  assert.equal(afterRevoke.items.some((item) => item.resourceId === 'item-2'), false);
  assert.equal(JSON.stringify(afterRevoke).includes('Current item-2'), false);
});

test('maps PostgreSQL statement timeout code 57014 to search_timeout', async () => {
  const pgTimeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const candidates = [collectionCandidate('timeout-target', 1)];
  const facts = new Map([['collection:timeout-target', collectionFact('timeout-target')]]);
  const { ports } = harness(candidates, facts);
  ports.authority = {
    async loadBatch() {
      throw pgTimeout;
    },
  };
  await assert.rejects(
    executeSearchQuery(ports, { principal: ANONYMOUS, query: 'timeout', pageSize: 1 }),
    (error: unknown) => error instanceof SearchQueryError && error.code === 'search_timeout',
  );
});

test('discards profile facts when handle does not match resourceId without corrupting continuation', async () => {
  const candidates = [
    profileCandidate('alice', 0.95),
    collectionCandidate('visible', 0.9),
    collectionCandidate('after', 0.85),
  ];
  const facts = new Map<string, SearchAuthorityFact>([
    ['profile:alice', profileFact('alice', { handle: 'mismatched-handle' })],
    ['collection:visible', collectionFact('visible')],
    ['collection:after', collectionFact('after')],
  ]);
  const { ports } = harness(candidates, facts);
  const first = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'profile', pageSize: 1 });
  assert.deepEqual(first.items.map((item) => item.resourceId), ['visible']);
  assert.ok(first.page.nextCursor);
  assert.doesNotMatch(JSON.stringify(first), /mismatched-handle|alice/u);

  const second = await executeSearchQuery(ports, {
    principal: ANONYMOUS, query: 'profile', cursor: first.page.nextCursor!,
  });
  assert.deepEqual(second.items.map((item) => item.resourceId), ['after']);
  assert.equal(second.page.hasMore, false);
  assert.equal(second.page.nextCursor, null);
});

test('FIX-L-025 reuses the first-page cursor within the hard TTL without extending its expiry', async () => {
  const candidates = [collectionCandidate('a', 1), collectionCandidate('b', 0.9), collectionCandidate('c', 0.8)];
  const facts = new Map(candidates.map((item) => [`collection:${item.resourceId}`, collectionFact(item.resourceId)]));
  const cache = createSearchFirstPageCache();
  const ports = { ...harness(candidates, facts).ports, firstPageCache: cache };
  const first = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'reuse', pageSize: 1 });
  assert.ok(first.page.nextCursor);
  const firstCursor = first.page.nextCursor!;
  const firstPayload = JSON.parse(Buffer.from(firstCursor.split('.')[1]!, 'base64url').toString('utf8')) as {
    issuedAt: string; expiresAt: string };
  assert.equal(firstPayload.issuedAt, NOW.toISOString());
  assert.equal(firstPayload.expiresAt, new Date(NOW.getTime() + SEARCH_CURSOR_TTL_MS).toISOString());

  // Advancing the clock INSIDE the hard TTL must reproduce the exact same
  // response (same items, same signed cursor) so the ETag stays stable.
  const later = await executeSearchQuery({ ...ports,
    clock: { now: () => new Date(NOW.getTime() + 5 * 60_000) } },
  { principal: ANONYMOUS, query: 'reuse', pageSize: 1 });
  assert.deepEqual(later, first);
  assert.equal(later.page.nextCursor, firstCursor);

  // Past the hard TTL a fresh response/ETag is generated; the reused cursor's
  // expiry stays anchored at the first signing (never extended by hits).
  const rotated = await executeSearchQuery({ ...ports,
    clock: { now: () => new Date(NOW.getTime() + SEARCH_FIRST_PAGE_CACHE_TTL_MS + 1) } },
  { principal: ANONYMOUS, query: 'reuse', pageSize: 1 });
  assert.ok(rotated.page.nextCursor);
  assert.notEqual(rotated.page.nextCursor, firstCursor);
  const rotatedPayload = JSON.parse(Buffer.from(rotated.page.nextCursor!.split('.')[1]!, 'base64url')
    .toString('utf8')) as { issuedAt: string; expiresAt: string };
  assert.equal(rotatedPayload.issuedAt, new Date(NOW.getTime() + SEARCH_FIRST_PAGE_CACHE_TTL_MS + 1).toISOString());
});

test('FIX-L-025 a first-page data change invalidates the reused cursor within the hard TTL', async () => {
  const candidates = [collectionCandidate('a', 1), collectionCandidate('b', 0.9), collectionCandidate('c', 0.8)];
  const facts = new Map(candidates.map((item) => [`collection:${item.resourceId}`, collectionFact(item.resourceId)]));
  const cache = createSearchFirstPageCache();
  const ports = { ...harness(candidates, facts).ports, firstPageCache: cache };
  const first = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'revoke', pageSize: 1 });
  assert.deepEqual(first.items.map((item) => item.resourceId), ['a']);
  const firstCursor = first.page.nextCursor!;

  // Revoking the first candidate changes the page content AND the continuation
  // position, so the cached cursor must not be reused even inside the TTL.
  facts.set('collection:a', collectionFact('a', { visibility: 'private', policyRevision: 'p2' }));
  const after = await executeSearchQuery({ ...ports,
    clock: { now: () => new Date(NOW.getTime() + 5 * 60_000) } },
  { principal: ANONYMOUS, query: 'revoke', pageSize: 1 });
  assert.deepEqual(after.items.map((item) => item.resourceId), ['b']);
  assert.ok(after.page.nextCursor);
  assert.notEqual(after.page.nextCursor, firstCursor);
});

test('FIX-L-025 the reused first-page cursor stays bound to query, principal and page size', async () => {
  const candidates = [collectionCandidate('a', 1), collectionCandidate('b', 0.9), collectionCandidate('c', 0.8)];
  const facts = new Map(candidates.map((item) => [`collection:${item.resourceId}`, collectionFact(item.resourceId)]));
  const cache = createSearchFirstPageCache();
  const ports = { ...harness(candidates, facts).ports, firstPageCache: cache };
  const first = await executeSearchQuery(ports, { principal: ANONYMOUS, query: 'alpha', pageSize: 1 });
  const firstCursor = first.page.nextCursor!;
  const run = (principal: SearchPrincipal, query: string, pageSize: number) =>
    executeSearchQuery(ports, { principal, query, pageSize });
  assert.notEqual((await run(ANONYMOUS, 'beta', 1)).page.nextCursor, firstCursor,
    'a different query must never reuse the cached cursor');
  const ownerFirst = (await run(OWNER, 'alpha', 1)).page.nextCursor!;
  assert.notEqual(ownerFirst, firstCursor, 'a different principal must never reuse the cached cursor');
  assert.equal((await run(OWNER, 'alpha', 1)).page.nextCursor, ownerFirst,
    'the same account reuses its own cached cursor');
  assert.notEqual((await run({ ...OWNER, securityEpoch: '8' }, 'alpha', 1)).page.nextCursor, ownerFirst,
    'an authority-epoch change must invalidate the cached cursor');
  assert.notEqual((await run(ANONYMOUS, 'alpha', 2)).page.nextCursor, firstCursor,
    'a different page size must never reuse the cached cursor');
  assert.equal((await run(ANONYMOUS, 'alpha', 1)).page.nextCursor, firstCursor,
    'the identical first page still reuses the cached cursor');
});
