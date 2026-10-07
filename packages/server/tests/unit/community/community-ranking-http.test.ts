import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { test } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  COMMUNITY_STATIC_GENERATION,
  CommunityRankingError,
  createCommunityRankingCursorCodec,
  type CommunityRankedEntry,
  type CommunityRankingQueryPorts,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandPorts,
} from '../../../src/modules/community/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { registerCommunityRoutes } from '../../../src/transport/product/community-routes.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';
import { createPostgresCommunityRankingQueryUnitOfWork } from '../../../src/infrastructure/community/index.js';
import { fakeKyselyDatabase } from '../../support/fake-kysely-database.js';

const ACTOR = 'EREREREREREREREREREREQ';
const HMAC_KEY = Buffer.alloc(32, 11);
const RANKING_PATH = '/api/v1/community/ranking';
const NOW = new Date('2026-10-02T00:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: 'col-1',
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const BOOKMARK_TARGET: CommunityTarget = {
  kind: 'bookmark', id: 'node-1', collectionId: 'col-1',
  seriesId: null, generation: 'bm-gen-0123456789abcdef',
};

function entry(position: number, over: Partial<CommunityRankedEntry> = {}): CommunityRankedEntry {
  return {
    position,
    target: over.target ?? COLLECTION_TARGET,
    title: over.title ?? `Entry ${position}`,
    href: over.href ?? `/c/entry-${position}`,
    tags: over.tags ?? [],
    language: over.language ?? 'en',
    up: over.up ?? 4,
    down: over.down ?? 1,
    firstVoteAt: over.firstVoteAt === undefined ? NOW : over.firstVoteAt,
    hot: over.hot ?? (10 - position),
  };
}

const actor = { account: { id: ACTOR, subjectId: 'actor-subject' },
  session: { csrfTokenHash: 'csrf-hash' } };
const fakeIdentityPorts = { sessions: {
  findByTokenHash: async () => ({ id: 'session', accountId: ACTOR, tokenHash: 'x',
    csrfTokenHash: 'csrf-hash', securityEpoch: 1n, createdAt: new Date(), lastSeenAt: new Date(),
    idleExpiresAt: new Date(Date.now() + 10_000), absoluteExpiresAt: new Date(Date.now() + 10_000),
    revokedAt: null, rotatedFromSessionId: null }), touch: async () => true },
  accounts: { findById: async () => ({ id: actor.account.id, subjectId: actor.account.subjectId,
    email: 'private@example.test', status: 'active', securityEpoch: 1n, createdAt: new Date(), deletedAt: null }) },
  clock: { now: async () => new Date() } } as unknown as IdentityPorts;
const identityUnitOfWork: IdentityUnitOfWork = {
  execute: <Result>(work: (ports: IdentityPorts) => Promise<Result>) => work(fakeIdentityPorts),
};

function rankingPorts(entries: readonly CommunityRankedEntry[]): CommunityRankingQueryPorts {
  return {
    rankings: {
      latestSnapshot: async () => ({
        snapshotId: '9', scoreVersion: 'hot-v1', createdAt: NOW, itemCount: entries.length,
      }),
      findSnapshot: async () => ({
        snapshotId: '9', scoreVersion: 'hot-v1', createdAt: NOW, itemCount: entries.length,
      }),
      scanEntries: async (_id, afterPosition, limit) =>
        entries.filter((row) => row.position > afterPosition).slice(0, limit),
    },
    targets: {
      resolve: async (query) => ({
        target: { kind: query.kind, id: query.id,
          collectionId: query.collectionId ?? null,
          seriesId: query.seriesId ?? null,
          generation: query.kind === 'bookmark' ? 'bm-gen-0123456789abcdef' : COMMUNITY_STATIC_GENERATION },
        ownerSubjectId: 'subject-owner',
        title: `Resolved ${query.id}`,
        href: `/resolved/${query.id}`,
      }),
    },
    clock: { now: async () => NOW },
  };
}

function app(input: {
  enabled?: boolean;
  rate?: number;
  timeoutMs?: number;
  entries?: readonly CommunityRankedEntry[];
  ranking?: Parameters<typeof registerCommunityRoutes>[1]['rankingQuery'];
  rankingExecute?: <Result>(
    work: (ports: CommunityRankingQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Result>;
  /** Overrides the whole read adapter, e.g. with the real PostgreSQL one. */
  rankingUnitOfWork?: Parameters<typeof registerCommunityRoutes>[1]['rankingQueryUnitOfWork'];
} = {}) {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductRouteManifestChecks(server, { requireComplete: false });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ProductHttpError) return sendProductError(request, reply, error);
    return sendProductError(request, reply, new ProductHttpError({
      statusCode: 500, code: 'internal_error', message: 'Internal error.',
    }));
  });
  const ports = rankingPorts(input.entries ?? []);
  registerCommunityRoutes(server, {
    enabled: input.enabled ?? true,
    allowedOrigins: ['https://app.example.test'],
    identityUnitOfWork,
    commandUnitOfWork: { execute: <Result>(work: (ports: CommunityVoteCommandPorts) => Promise<Result>) =>
      work({} as CommunityVoteCommandPorts) },
    queryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityTargetQueryPorts) => Promise<Result>) =>
        work({} as CommunityTargetQueryPorts),
    },
    rankingQueryUnitOfWork: input.rankingUnitOfWork ?? {
      execute: input.rankingExecute
        ?? (<Result>(work: (ports: CommunityRankingQueryPorts) => Promise<Result>) => work(ports)),
    },
    rateLimits: {
      vote: createFixedWindowRateLimiter({ maxRequests: input.rate ?? 100, windowMs: 60_000 }),
      comment: createFixedWindowRateLimiter({ maxRequests: input.rate ?? 100, windowMs: 60_000 }),
      curation: createFixedWindowRateLimiter({ maxRequests: input.rate ?? 100, windowMs: 60_000 }),
      publicReads: createFixedWindowRateLimiter({ maxRequests: input.rate ?? 100, windowMs: 60_000 }),
    },
    timeoutMs: input.timeoutMs ?? 100,
    etagHmacKey: HMAC_KEY,
    csrfMatches: (raw) => raw === 'csrf',
    ...(input.ranking !== undefined ? { rankingQuery: input.ranking } : {}),
  });
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };

test('GET ranking anonymously returns the durable hot-v1 page with private no-store', async () => {
  const server = app({ entries: [entry(1), entry(2, { target: BOOKMARK_TARGET })] });
  const response = await server.inject({ method: 'GET', url: RANKING_PATH });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const body = response.json();
  assert.equal(body.scoreVersion, 'hot-v1');
  assert.equal(body.asOf, NOW.toISOString());
  assert.equal(body.nextCursor, null);
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].title, 'Resolved col-1');
  assert.equal(body.items[0].up, 4);
  assert.equal(body.items[1].target.kind, 'bookmark');
  // Closed output object: only the contract keys are emitted.
  assert.deepEqual(Object.keys(body.items[0]).sort(),
    ['down', 'firstVoteAt', 'hot', 'href', 'target', 'title', 'up']);
  assert.deepEqual(Object.keys(body).sort(), ['asOf', 'items', 'nextCursor', 'scoreVersion']);
  await server.close();
});

test('GET ranking has no HEAD twin and flag-off is a uniform 404', async () => {
  const server = app({ entries: [entry(1)] });
  const head = await server.inject({ method: 'HEAD', url: RANKING_PATH });
  assert.equal(head.statusCode, 404);
  const routes = server.printRoutes();
  assert.match(routes, /ranking \(GET\)/u);
  assert.doesNotMatch(routes, /ranking \([^)]*HEAD/u);
  await server.close();

  const closed = app({ enabled: false, entries: [entry(1)] });
  const off = await closed.inject({ method: 'GET', url: RANKING_PATH, headers: auth });
  assert.equal(off.statusCode, 404);
  assert.equal(off.json().error.code, 'resource_not_found');
  assert.doesNotMatch(off.body, /feature_temporarily_unavailable/u);
  await closed.close();
});

test('GET ranking rejects unknown and duplicate query keys as invalid_query', async () => {
  const server = app({ entries: [entry(1)] });
  for (const url of [
    `${RANKING_PATH}?sort=hot`,
    `${RANKING_PATH}?kind=digest`,
    `${RANKING_PATH}?collectionId=col-1`,
    `${RANKING_PATH}?kind=collection&collectionId=col-1`,
    `${RANKING_PATH}?limit=0`,
    `${RANKING_PATH}?limit=101`,
    `${RANKING_PATH}?limit=2.5`,
    `${RANKING_PATH}?kind=collection&kind=bookmark`,
  ]) {
    const response = await server.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error.code, 'invalid_query', url);
  }
  await server.close();
});

test('GET ranking paginates through a signed cursor and rejects a mismatched one', async () => {
  const entries = [entry(1), entry(2, { target: BOOKMARK_TARGET }), entry(3, {
    target: { ...COLLECTION_TARGET, id: 'col-3' },
  })];
  const server = app({ entries });
  const first = await server.inject({ method: 'GET', url: `${RANKING_PATH}?limit=2` });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.equal(firstBody.items.length, 2);
  assert.ok(firstBody.nextCursor);

  const second = await server.inject({
    method: 'GET',
    url: `${RANKING_PATH}?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json().items.map((item: { target: { id: string } }) => item.target.id), ['col-3']);
  assert.equal(second.json().nextCursor, null);

  // A cursor minted under limit=2 does not validate against limit=3.
  const mismatch = await server.inject({
    method: 'GET',
    url: `${RANKING_PATH}?limit=3&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
  });
  assert.equal(mismatch.statusCode, 400);
  assert.equal(mismatch.json().error.code, 'invalid_cursor');

  const tampered = await server.inject({
    method: 'GET',
    url: `${RANKING_PATH}?limit=2&cursor=${encodeURIComponent(`${firstBody.nextCursor.slice(0, -2)}zz`)}`,
  });
  assert.equal(tampered.statusCode, 400);
  assert.equal(tampered.json().error.code, 'invalid_cursor');
  await server.close();
});

test('GET ranking maps snapshot_expired to 409 with restart_from_first_page recovery', async () => {
  const codec = createCommunityRankingCursorCodec(HMAC_KEY);
  // Mint a syntactically valid cursor bound to a snapshot the store lost.
  const staleCursor = codec.sign({
    v: 1, ep: 'community.ranking', vw: 'anonymous', sn: '404',
    pos: 1, lm: 24, sv: 'hot-v1',
    f: { k: null, c: null, q: null, t: null, l: null },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
  });
  const server = app({
    entries: [entry(1)],
    rankingExecute: <Result>(work: (ports: CommunityRankingQueryPorts) => Promise<Result>) =>
      work({
        ...rankingPorts([]),
        rankings: { ...rankingPorts([]).rankings, findSnapshot: async () => null },
      }),
  });
  const response = await server.inject({
    method: 'GET',
    url: `${RANKING_PATH}?cursor=${encodeURIComponent(staleCursor)}`,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'snapshot_expired');
  assert.equal(response.json().error.recovery, 'restart_from_first_page');
  await server.close();
});

test('GET ranking maps domain errors to product codes', async () => {
  for (const [error, status, code] of [
    [new CommunityRankingError('invalid_cursor', 'The community ranking cursor is invalid.'), 400, 'invalid_cursor'],
    [new CommunityRankingError('snapshot_expired', 'The community ranking snapshot expired; restart from the first page.'), 409, 'snapshot_expired'],
  ] as const) {
    const server = app({ ranking: async () => { throw error; } });
    const response = await server.inject({ method: 'GET', url: RANKING_PATH, headers: auth });
    assert.equal(response.statusCode, status, code);
    assert.equal(response.json().error.code, code);
    await server.close();
  }
});

test('community rate limiting applies to the ranking path', async () => {
  const server = app({ rate: 1, entries: [entry(1)] });
  assert.equal((await server.inject({ method: 'GET', url: RANKING_PATH })).statusCode, 200);
  const limited = await server.inject({ method: 'GET', url: RANKING_PATH });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'rate_limited');
  await server.close();
});

/** The PID the fake PostgreSQL connection reports for `pg_backend_pid()`. */
const BACKEND_PID = 4_242;

/**
 * The route's timeout must reach the real adapter, not just a fake's own
 * `abort` listener: `createUnitOfWork` reads `pg_backend_pid()` from the
 * transaction and, when the route's signal aborts, calls `cancelBackend(pid)`
 * so PostgreSQL cancels the running statement instead of leaving it to pin a
 * pooled connection after the client already got its 503.
 *
 * The scan below never settles on its own — only the cancellation can stop it —
 * and the assertions observe what the route and the adapter did, not a reaction
 * staged by the fake.
 */
test('GET ranking timeout hands the abort to the query unit of work, which cancels the PostgreSQL backend', async () => {
  const received: { signal?: AbortSignal } = {};
  const cancelledByPid: number[] = [];
  const rankingAdapter = createPostgresCommunityRankingQueryUnitOfWork(
    fakeKyselyDatabase(BACKEND_PID),
    async (backendPid) => { cancelledByPid.push(backendPid); return true; },
  );
  const server = app({
    timeoutMs: 40,
    ranking: () => new Promise<never>(() => {}),
    rankingUnitOfWork: {
      execute: (work, options) => {
        received.signal = options?.signal;
        return rankingAdapter.execute(work, options);
      },
    },
  });
  const response = await server.inject({ method: 'GET', url: RANKING_PATH });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  // (a) The route handed the unit of work a signal and its own timeout aborted it.
  assert.ok(received.signal, 'the route must hand the ranking unit of work a signal');
  assert.equal(received.signal.aborted, true, 'the timeout must abort that signal');
  const reason: unknown = received.signal.reason;
  assert.ok(reason instanceof ProductHttpError, 'the signal reason must be the route\'s timeout error');
  assert.equal(reason.productCode, 'feature_temporarily_unavailable');
  // (b) The adapter acted on it: the backend running the scan is cancelled by PID.
  assert.deepEqual(cancelledByPid, [BACKEND_PID],
    'the abort must reach cancelBackend so PostgreSQL cancels the running statement');
  await server.close();
});
