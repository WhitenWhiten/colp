import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import {
  hashSecret,
  type IdentityPorts,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import {
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_CONCEALED_MESSAGE,
  COMMUNITY_TARGET_STALE_MESSAGE,
  COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION,
  CommunityTargetError,
  CommunityVoteCommandError,
  type CommunityRankingQueryPorts,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityTargetView,
  type CommunityVoteCommandPorts,
} from '../../../src/modules/community/index.js';
import {
  createFixedWindowRateLimiter,
  type CommunityRateLimitFamily,
  type CommunityRateLimiters,
} from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { registerCommunityRoutes } from '../../../src/transport/product/community-routes.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';

const ACTOR = 'EREREREREREREREREREREQ';
const COLLECTION = 'IiIiIiIiIiIiIiIiIiIiIg';
const GENERATION = 'bm-gen-0123456789abcdef';
const HMAC_KEY = Buffer.alloc(32, 11);
const TARGET_PATH = '/api/v1/community/target';
const VOTE_PATH = '/api/v1/community/vote';

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const BOOKMARK_TARGET: CommunityTarget = {
  kind: 'bookmark', id: 'node-1', collectionId: COLLECTION,
  seriesId: null, generation: GENERATION,
};
const VIEW: CommunityTargetView = {
  target: COLLECTION_TARGET,
  title: 'Curated list',
  href: 'https://known.example/c/curated',
  canVote: true,
  canComment: true,
  commentDeniedReason: null,
  canCurateComments: false,
  votes: { target: COLLECTION_TARGET, up: 3, down: 1, myVote: 0 },
};

const ACTOR_B = 'GVGVGVGVGVGVGVGVGVGVGA';
const actor = { account: { id: ACTOR, subjectId: 'actor-subject' },
  session: { csrfTokenHash: 'csrf-hash' } };
/** raw session token -> session/account pair; lets tests distinguish accounts. */
const SESSION_BY_TOKEN = new Map<string, { accountId: string; subjectId: string }>([
  ['test-token', { accountId: ACTOR, subjectId: actor.account.subjectId }],
  ['token-b', { accountId: ACTOR_B, subjectId: 'actor-b-subject' }],
]);
const fakeIdentityPorts = { sessions: {
  findByTokenHash: async (hash: string) => {
    for (const [raw, session] of SESSION_BY_TOKEN) {
      if (hashSecret(raw) !== hash) continue;
      return { id: `session-${session.accountId}`, accountId: session.accountId, tokenHash: hash,
        csrfTokenHash: 'csrf-hash', securityEpoch: 1n, createdAt: new Date(), lastSeenAt: new Date(),
        idleExpiresAt: new Date(Date.now() + 10_000), absoluteExpiresAt: new Date(Date.now() + 10_000),
        revokedAt: null, rotatedFromSessionId: null };
    }
    return null;
  }, touch: async () => true },
  accounts: { findById: async (id: string) => {
    for (const session of SESSION_BY_TOKEN.values()) {
      if (session.accountId === id) {
        return { id, subjectId: session.subjectId,
          email: 'private@example.test', status: 'active', securityEpoch: 1n,
          createdAt: new Date(), deletedAt: null };
      }
    }
    return null;
  } },
  clock: { now: async () => new Date() } } as unknown as IdentityPorts;
const identityUnitOfWork: IdentityUnitOfWork = {
  execute: <Result>(work: (ports: IdentityPorts) => Promise<Result>) => work(fakeIdentityPorts),
};

function rateLimits(
  rate: number,
  rates: Partial<Record<CommunityRateLimitFamily, number>> | undefined,
): CommunityRateLimiters {
  const max = (family: CommunityRateLimitFamily) => rates?.[family] ?? rate;
  return {
    vote: createFixedWindowRateLimiter({ maxRequests: max('vote'), windowMs: 60_000 }),
    comment: createFixedWindowRateLimiter({ maxRequests: max('comment'), windowMs: 60_000 }),
    curation: createFixedWindowRateLimiter({ maxRequests: max('curation'), windowMs: 60_000 }),
    publicReads: createFixedWindowRateLimiter({ maxRequests: max('publicReads'), windowMs: 60_000 }),
  };
}

function app(input: {
  enabled?: boolean;
  rate?: number;
  /** Per-family overrides; `rate` fills any family not listed. */
  rates?: Partial<Record<CommunityRateLimitFamily, number>>;
  timeoutMs?: number;
  command?: Parameters<typeof registerCommunityRoutes>[1]['command'];
  query?: (ports: CommunityTargetQueryPorts, value: {
    viewer: { accountId: string | null; subjectId: string | null };
    query: unknown;
  }) => Promise<CommunityTargetView>;
  queryExecute?: <Result>(
    work: (ports: CommunityTargetQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<Result>;
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
  registerCommunityRoutes(server, {
    enabled: input.enabled ?? true,
    allowedOrigins: ['https://app.example.test'],
    identityUnitOfWork,
    commandUnitOfWork: { execute: <Result>(work: (ports: CommunityVoteCommandPorts) => Promise<Result>) =>
      work({} as CommunityVoteCommandPorts) },
    queryUnitOfWork: {
      execute: input.queryExecute ?? (<Result>(work: (ports: CommunityTargetQueryPorts) => Promise<Result>) =>
        work({} as CommunityTargetQueryPorts)),
    },
    rankingQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityRankingQueryPorts) => Promise<Result>) =>
        work({} as CommunityRankingQueryPorts),
    },
    rateLimits: rateLimits(input.rate ?? 100, input.rates),
    timeoutMs: input.timeoutMs ?? 100,
    etagHmacKey: HMAC_KEY,
    csrfMatches: (raw) => raw === 'csrf',
    command: input.command ?? (async (_ports, value) => ({
      kind: 'succeeded' as const,
      state: {
        target: value.target as CommunityTarget,
        up: 4,
        down: 1,
        myVote: value.value as -1 | 0 | 1,
      },
    })),
    query: async (_ports, value) => input.query
      ? input.query(_ports, value)
      : (value.viewer.accountId === null
          ? { ...VIEW, canVote: false, canComment: false, commentDeniedReason: 'anonymous' as const,
            votes: { ...VIEW.votes, myVote: null } }
          : VIEW),
  });
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };
const mutation = (extra: Record<string, string> = {}) => ({ ...auth, origin: 'https://app.example.test',
  'x-csrf-token': 'csrf', 'known-command-id': randomUUID(), ...extra });
const voteBody = (target: unknown = COLLECTION_TARGET, value: unknown = 1) =>
  JSON.stringify({ target, value });

/* ——— GET /community/target ——— */

test('GET resolves anonymously with counts, keyed ETag and private no-store', async () => {
  const server = app();
  const response = await server.inject({ method: 'GET', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.match(String(response.headers.etag), /^"community-target:[A-Za-z0-9_-]{32}"$/u);
  const body = response.json();
  assert.equal(body.canVote, false);
  assert.equal(body.votes.myVote, null);
  assert.equal(body.votes.up, 3);
  assert.equal(body.target.kind, 'collection');
  await server.close();
});

test('GET with a session reports viewer permissions and no HEAD twin exists', async () => {
  const server = app();
  const response = await server.inject({
    method: 'GET', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}`, headers: auth,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canVote, true);
  const routes = server.printRoutes();
  assert.match(routes, /target \(GET\)/u);
  assert.doesNotMatch(routes, /target \([^)]*HEAD/u);
  const head = await server.inject({ method: 'HEAD', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}` });
  assert.equal(head.statusCode, 404);
  await server.close();
});

test('GET flag off is 404 resource_not_found without feature codes', async () => {
  const server = app({ enabled: false });
  const response = await server.inject({
    method: 'GET', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}`, headers: auth,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.doesNotMatch(response.body, /feature_temporarily_unavailable/u);
  await server.close();
});

test('GET rejects malformed, unknown and duplicate query keys as invalid_query', async () => {
  const server = app();
  for (const url of [
    `${TARGET_PATH}?kind=unknown&id=${COLLECTION}`,
    `${TARGET_PATH}?kind=collection`,
    `${TARGET_PATH}?kind=bookmark&id=node-1`,
    `${TARGET_PATH}?kind=collection&id=${COLLECTION}&extra=1`,
    `${TARGET_PATH}?kind=collection&id=${COLLECTION}&id=${COLLECTION}`,
  ]) {
    const response = await server.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.json().error.code, 'invalid_query', url);
  }
  await server.close();
});

test('GET concealed targets are a uniform 404 with no state leakage', async () => {
  const server = app({
    query: async () => { throw new CommunityTargetError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE); },
  });
  const response = await server.inject({
    method: 'GET', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}`, headers: auth,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.doesNotMatch(response.body, /private@example|hidden|withdrawn/iu);
  await server.close();
});

/* ——— PUT /community/vote ——— */

test('PUT requires session, Origin, CSRF and a canonical command id', async () => {
  const server = app();
  const payload = voteBody();
  const json = { 'content-type': 'application/json' };
  assert.equal((await server.inject({ method: 'PUT', url: VOTE_PATH, headers: json, payload })).statusCode, 401);
  assert.equal((await server.inject({ method: 'PUT', url: VOTE_PATH, headers: { ...auth, ...json }, payload })).statusCode, 403);
  const noCommand = await server.inject({ method: 'PUT', url: VOTE_PATH,
    headers: { ...mutation(), ...json, 'known-command-id': '' }, payload });
  assert.equal(noCommand.statusCode, 400);
  const badCommand = await server.inject({ method: 'PUT', url: VOTE_PATH,
    headers: { ...mutation(), ...json, 'known-command-id': 'not-a-uuid' }, payload });
  assert.equal(badCommand.statusCode, 400);
  await server.close();
});

test('PUT success returns the vote state with private no-store', async () => {
  const server = app();
  const response = await server.inject({ method: 'PUT', url: VOTE_PATH,
    headers: { ...mutation(), 'content-type': 'application/json' }, payload: voteBody(BOOKMARK_TARGET, -1) });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json(), { target: BOOKMARK_TARGET, up: 4, down: 1, myVote: -1 });
  await server.close();
});

test('PUT rejects malformed bodies before the command runs', async () => {
  const server = app();
  const headers = { ...mutation(), 'content-type': 'application/json' };
  for (const payload of [
    '{}',
    JSON.stringify({ target: COLLECTION_TARGET }),
    JSON.stringify({ value: 1 }),
    JSON.stringify({ target: COLLECTION_TARGET, value: 1, extra: true }),
    JSON.stringify({ target: { ...COLLECTION_TARGET, extra: 'x' }, value: 1 }),
    JSON.stringify({ target: 'collection', value: 1 }),
    JSON.stringify({ target: COLLECTION_TARGET, value: 'up' }),
    JSON.stringify({ target: COLLECTION_TARGET, value: 2 }),
  ]) {
    const response = await server.inject({ method: 'PUT', url: VOTE_PATH, headers, payload });
    assert.equal(response.statusCode, 400, payload);
    assert.equal(response.json().error.code, 'invalid_request', payload);
  }
  const malformedJson = await server.inject({ method: 'PUT', url: VOTE_PATH, headers, payload: 'not json' });
  assert.equal(malformedJson.statusCode, 400);
  assert.equal(malformedJson.json().error.code, 'invalid_json');
  await server.close();
});

test('PUT forwards command-receipt kinds through sendProductCommandReceiptOutcome', async () => {
  const replayBody = Buffer.from('{"target":{"kind":"collection"},"up":4,"down":1,"myVote":1}');
  const cases = [
    {
      outcome: {
        kind: 'replay' as const, status: 200, body: replayBody,
        stableHeaders: { 'cache-control': 'private, no-store' },
        mediaType: 'application/json',
        contractVersion: COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION,
      },
      status: 200, code: null, body: replayBody.toString(), retryAfter: undefined,
    },
    { outcome: { kind: 'reused' as const }, status: 409, code: 'command_id_reused',
      body: null, retryAfter: undefined },
    { outcome: { kind: 'in_progress' as const, retryAfterSeconds: 3 },
      status: 409, code: 'command_in_progress', body: null, retryAfter: '3' },
  ] as const;
  for (const testCase of cases) {
    const server = app({ command: async () => testCase.outcome });
    const response = await server.inject({ method: 'PUT', url: VOTE_PATH,
      headers: { ...mutation(), 'content-type': 'application/json' }, payload: voteBody() });
    assert.equal(response.statusCode, testCase.status, testCase.outcome.kind);
    if (testCase.body !== null) {
      assert.equal(response.body, testCase.body);
    } else {
      assert.equal(response.json().error.code, testCase.code);
    }
    if (testCase.retryAfter !== undefined) {
      assert.equal(response.headers['retry-after'], testCase.retryAfter);
    }
    await server.close();
  }
});

test('PUT maps command errors to stable product codes (revision_conflict is 409)', async () => {
  for (const [error, status, code] of [
    [new CommunityVoteCommandError('revision_conflict', COMMUNITY_TARGET_STALE_MESSAGE), 409, 'revision_conflict'],
    [new CommunityVoteCommandError('insufficient_permission', 'You cannot vote on your own content.'), 403, 'insufficient_permission'],
    [new CommunityVoteCommandError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE), 404, 'resource_not_found'],
    [new CommunityVoteCommandError('invalid_request', 'The community target object is invalid.'), 400, 'invalid_request'],
  ] as const) {
    const server = app({ command: async () => { throw error; } });
    const response = await server.inject({ method: 'PUT', url: VOTE_PATH,
      headers: { ...mutation(), 'content-type': 'application/json' }, payload: voteBody() });
    assert.equal(response.statusCode, status, code);
    assert.equal(response.json().error.code, code);
    await server.close();
  }
});

test('community vote quota denies repeated attempts with rate_limited', async () => {
  const server = app({ rates: { vote: 1 } });
  const headers = { ...mutation(), 'content-type': 'application/json' };
  const first = await server.inject({ method: 'PUT', url: VOTE_PATH, headers, payload: voteBody() });
  assert.equal(first.statusCode, 200);
  const limited = await server.inject({ method: 'PUT', url: VOTE_PATH, headers, payload: voteBody() });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  await server.close();
});

test('denied vote targets still consume the account vote quota', async () => {
  // CS: vote attempts count "including denied target attempts and retries" —
  // admission runs before CSRF/target validation, so a rejected vote burns
  // the same account budget a successful one does.
  const server = app({
    rates: { vote: 1 },
    command: async () => {
      throw new CommunityVoteCommandError('insufficient_permission', 'You cannot vote on your own content.');
    },
  });
  const denied = await server.inject({
    method: 'PUT', url: VOTE_PATH,
    headers: { ...mutation(), 'content-type': 'application/json' },
    payload: voteBody(BOOKMARK_TARGET),
  });
  assert.equal(denied.statusCode, 403);
  const limited = await server.inject({
    method: 'PUT', url: VOTE_PATH,
    headers: { ...mutation(), 'content-type': 'application/json' },
    payload: voteBody(),
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'rate_limited');
  await server.close();
});

test('community vote quota is keyed per account, not per client IP', async () => {
  const server = app({ rates: { vote: 1 } });
  const headers = { ...mutation(), 'content-type': 'application/json' };
  const first = await server.inject({
    method: 'PUT', url: VOTE_PATH, headers, payload: voteBody(), remoteAddress: '10.0.0.1',
  });
  assert.equal(first.statusCode, 200);
  // Same account over a different address: still the same quota bucket.
  const limited = await server.inject({
    method: 'PUT', url: VOTE_PATH, headers, payload: voteBody(), remoteAddress: '192.0.2.8',
  });
  assert.equal(limited.statusCode, 429);
  // A different account over the *same* address has an independent bucket.
  const other = await server.inject({
    method: 'PUT', url: VOTE_PATH,
    headers: { ...mutation(), cookie: '__Host-known_session=token-b', 'content-type': 'application/json' },
    payload: voteBody(), remoteAddress: '10.0.0.1',
  });
  assert.equal(other.statusCode, 200);
  await server.close();
});

test('community vote quota does not consume the public-reads budget', async () => {
  const server = app({ rates: { vote: 1, publicReads: 1 } });
  const headers = { ...mutation(), 'content-type': 'application/json' };
  const first = await server.inject({ method: 'PUT', url: VOTE_PATH, headers, payload: voteBody() });
  assert.equal(first.statusCode, 200);
  const limited = await server.inject({ method: 'PUT', url: VOTE_PATH, headers, payload: voteBody() });
  assert.equal(limited.statusCode, 429);
  // The exhausted vote bucket leaves the publicReads family untouched.
  const read = await server.inject({
    method: 'GET', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}`, headers: auth,
  });
  assert.equal(read.statusCode, 200);
  const readLimited = await server.inject({
    method: 'GET', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}`, headers: auth,
  });
  assert.equal(readLimited.statusCode, 429);
  await server.close();
});

function hangOnAbort(received: { signal?: AbortSignal }) {
  return <Result>(
    _work: (ports: CommunityTargetQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result> => {
    received.signal = options?.signal;
    return new Promise<never>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal) return;
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

test('GET timeout aborts the query unit of work so PostgreSQL can cancel', async () => {
  const received: { signal?: AbortSignal } = {};
  const server = app({ timeoutMs: 40, queryExecute: hangOnAbort(received) });
  const response = await server.inject({ method: 'GET', url: `${TARGET_PATH}?kind=collection&id=${COLLECTION}` });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.ok(received.signal);
  assert.equal(received.signal.aborted, true);
  await server.close();
});
