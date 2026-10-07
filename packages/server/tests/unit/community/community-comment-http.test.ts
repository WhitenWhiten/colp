import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_CONCEALED_MESSAGE,
  CommunityCommentError,
  type CommunityComment,
  type CommunityCommentCommandPorts,
  type CommunityCommentCommandResult,
  type CommunityCommentManagePorts,
  type CommunityCommentQueryPorts,
  type CommunityTarget,
} from '../../../src/modules/community/index.js';
import {
  createFixedWindowRateLimiter,
  type CommunityRateLimiters,
} from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { registerCommunityCommentRoutes } from '../../../src/transport/product/community-comment-routes.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { mapFrameworkError } from '../../../src/transport/app-error-mapping.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';
import { mapCommunityError } from '../../../src/transport/product/community-routes.js';
import { communityCommentInvalidRequest } from '../../../src/modules/community/index.js';
import { productErrorStatus } from '../../../src/transport/product-codes.js';
import { createPostgresCommunityCommentQueryUnitOfWork } from '../../../src/infrastructure/community/index.js';
import { fakeKyselyDatabase } from '../../support/fake-kysely-database.js';

const ACTOR = 'EREREREREREREREREREREQ';
const COLLECTION = 'IiIiIiIiIiIiIiIiIiIiIg';
const HMAC_KEY = Buffer.alloc(32, 11);
const COMMENTS_PATH = '/api/v1/community/comments';
const COMMENT_PATH = '/api/v1/community/comments/comment-1';
const REPLIES_PATH = '/api/v1/community/comments/comment-1/replies';
const NOW = new Date('2026-10-03T10:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};

function comment(overrides: Partial<CommunityComment> = {}): CommunityComment {
  return {
    id: 'comment-1',
    target: COLLECTION_TARGET,
    rootId: 'comment-1',
    replyToId: null,
    depth: 0,
    author: { id: ACTOR, handle: 'alice', displayName: 'Alice', avatarUrl: null },
    body: 'hello',
    state: 'visible',
    revision: '1',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    replyCount: 0,
    canEdit: true,
    canDelete: true,
    canCurate: false,
    ...overrides,
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

function communityRateLimits(rate: number): CommunityRateLimiters {
  return {
    vote: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
    comment: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
    curation: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
    publicReads: createFixedWindowRateLimiter({ maxRequests: rate, windowMs: 60_000 }),
  };
}

function app(input: {
  enabled?: boolean;
  rate?: number;
  timeoutMs?: number;
  createComment?: Parameters<typeof registerCommunityCommentRoutes>[1]['createComment'];
  listComments?: Parameters<typeof registerCommunityCommentRoutes>[1]['listComments'];
  getComment?: Parameters<typeof registerCommunityCommentRoutes>[1]['getComment'];
  listReplies?: Parameters<typeof registerCommunityCommentRoutes>[1]['listReplies'];
  /** Overrides the whole read adapter, e.g. with the real PostgreSQL one. */
  queryUnitOfWork?: Parameters<typeof registerCommunityCommentRoutes>[1]['commentQueryUnitOfWork'];
} = {}) {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductRouteManifestChecks(server, { requireComplete: false });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ProductHttpError) return sendProductError(request, reply, error);
    return sendProductError(request, reply, mapFrameworkError(error));
  });
  registerCommunityCommentRoutes(server, {
    enabled: input.enabled ?? true,
    allowedOrigins: ['https://app.example.test'],
    identityUnitOfWork,
    commentQueryUnitOfWork: input.queryUnitOfWork ?? {
      execute: <Result>(work: (ports: CommunityCommentQueryPorts) => Promise<Result>) =>
        work({} as CommunityCommentQueryPorts),
    },
    commentCommandUnitOfWork: {
      execute: <Result>(work: (ports: CommunityCommentCommandPorts) => Promise<Result>) =>
        work({} as CommunityCommentCommandPorts),
    },
    commentManageUnitOfWork: {
      execute: <Result>(work: (ports: CommunityCommentManagePorts) => Promise<Result>) =>
        work({} as CommunityCommentManagePorts),
    },
    rateLimits: communityRateLimits(input.rate ?? 100),
    timeoutMs: input.timeoutMs ?? 100,
    etagHmacKey: HMAC_KEY,
    csrfMatches: (raw) => raw === 'csrf',
    ...(input.createComment !== undefined ? { createComment: input.createComment } : {}),
    ...(input.listComments !== undefined ? { listComments: input.listComments } : {}),
    ...(input.getComment !== undefined ? { getComment: input.getComment } : {}),
    ...(input.listReplies !== undefined ? { listReplies: input.listReplies } : {}),
  });
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };
const mutation = (extra: Record<string, string> = {}) => ({ ...auth, origin: 'https://app.example.test',
  'x-csrf-token': 'csrf', 'known-command-id': randomUUID(), ...extra });
const commentsQuery = `?kind=collection&id=${COLLECTION}&generation=static-v1`;
const createBody = (body: unknown = 'hi', replyToId: unknown = null, target: unknown = COLLECTION_TARGET) =>
  JSON.stringify({ target, body, replyToId });

/* ——— GET /community/comments ——— */

test('GET comments anonymously returns the closed page with private no-store and no HEAD twin', async () => {
  const server = app({
    listComments: async () => ({
      items: [comment({ canEdit: false, canDelete: false })],
      nextCursor: null,
    }),
  });
  const response = await server.inject({ method: 'GET', url: `${COMMENTS_PATH}${commentsQuery}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ['items', 'nextCursor']);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, 'comment-1');
  assert.equal(body.items[0].canEdit, false);
  assert.equal(body.nextCursor, null);
  const head = await server.inject({ method: 'HEAD', url: `${COMMENTS_PATH}${commentsQuery}` });
  assert.equal(head.statusCode, 404);
  const routes = server.printRoutes();
  // CS-04: the comments/comment-settings/curation siblings share the
  // `comment` radix prefix, so the printed tree compresses `comments` into
  // `comment` + `s` — assert the collection methods on the router itself.
  assert.equal(server.hasRoute({ method: 'GET', url: COMMENTS_PATH }), true);
  assert.equal(server.hasRoute({ method: 'POST', url: COMMENTS_PATH }), true);
  assert.doesNotMatch(routes, /HEAD/u);
  await server.close();
});

test('GET comments flag-off is a uniform 404 without feature codes', async () => {
  const server = app({ enabled: false });
  const response = await server.inject({
    method: 'GET', url: `${COMMENTS_PATH}${commentsQuery}`, headers: auth,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.doesNotMatch(response.body, /feature_temporarily_unavailable/u);
  await server.close();
});

test('GET comments rejects unknown, duplicate and malformed query keys', async () => {
  const server = app({ listComments: async () => ({ items: [], nextCursor: null }) });
  for (const url of [
    `${COMMENTS_PATH}?kind=collection&id=${COLLECTION}`,
    `${COMMENTS_PATH}?kind=unknown&id=${COLLECTION}&generation=static-v1`,
    `${COMMENTS_PATH}?kind=collection&id=${COLLECTION}&generation=static-v1&extra=1`,
    `${COMMENTS_PATH}?kind=collection&id=${COLLECTION}&id=${COLLECTION}&generation=static-v1`,
    `${COMMENTS_PATH}?kind=collection&id=${COLLECTION}&generation=static-v1&limit=0`,
    `${COMMENTS_PATH}?kind=collection&id=${COLLECTION}&generation=static-v1&limit=101`,
    `${COMMENTS_PATH}?kind=collection&id=${COLLECTION}&generation=static-v1&limit=2.5`,
    `${COMMENTS_PATH}?kind=bookmark&id=node-1&generation=bm-gen-x`,
  ]) {
    const response = await server.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400, url);
    assert.match(response.json().error.code, /^invalid_(query|cursor)$/u, url);
  }
  await server.close();
});

test('GET comments maps domain errors to product codes', async () => {
  for (const [error, status, code] of [
    [new CommunityCommentError('invalid_cursor', 'The community comment cursor is invalid.'), 400, 'invalid_cursor'],
    [new CommunityCommentError('invalid_query', 'The community comments query is invalid.'), 400, 'invalid_query'],
    [new CommunityCommentError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE), 404, 'resource_not_found'],
  ] as const) {
    const server = app({ listComments: async () => { throw error; } });
    const response = await server.inject({ method: 'GET', url: `${COMMENTS_PATH}${commentsQuery}` });
    assert.equal(response.statusCode, status, code);
    assert.equal(response.json().error.code, code);
    await server.close();
  }
});

/* ——— POST /community/comments ——— */

test('POST comments requires session, Origin, CSRF and a canonical command id', async () => {
  const server = app();
  const json = { 'content-type': 'application/json' };
  assert.equal((await server.inject({ method: 'POST', url: COMMENTS_PATH,
    headers: json, payload: createBody() })).statusCode, 401);
  assert.equal((await server.inject({ method: 'POST', url: COMMENTS_PATH,
    headers: { ...auth, ...json }, payload: createBody() })).statusCode, 403);
  const noCommand = await server.inject({ method: 'POST', url: COMMENTS_PATH,
    headers: { ...mutation(), ...json, 'known-command-id': '' }, payload: createBody() });
  assert.equal(noCommand.statusCode, 400);
  const badCommand = await server.inject({ method: 'POST', url: COMMENTS_PATH,
    headers: { ...mutation(), ...json, 'known-command-id': 'not-a-uuid' }, payload: createBody() });
  assert.equal(badCommand.statusCode, 400);
  await server.close();
});

test('POST comments success returns 201 with the Comment, strong ETag and private no-store', async () => {
  const server = app({
    createComment: async (_ports, input) => ({
      kind: 'succeeded' as const,
      comment: comment({ body: input.body as string }),
    }),
  });
  const response = await server.inject({ method: 'POST', url: COMMENTS_PATH,
    headers: { ...mutation(), 'content-type': 'application/json' },
    payload: createBody('  padded body  ') });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.match(String(response.headers.etag), /^"community-comment:[A-Za-z0-9_-]{32}"$/u);
  const body = response.json();
  assert.equal(body.id, 'comment-1');
  // The wire boundary normalizes trim+NFC before the command sees the body.
  assert.equal(body.body, 'padded body');
  await server.close();
});

test('POST comments rejects malformed and non-closed bodies before the command runs', async () => {
  const server = app();
  const headers = { ...mutation(), 'content-type': 'application/json' };
  for (const payload of [
    '{}',
    JSON.stringify({ target: COLLECTION_TARGET, body: 'hi' }),
    JSON.stringify({ target: COLLECTION_TARGET, body: 'hi', replyToId: null, extra: true }),
    JSON.stringify({ target: 'collection', body: 'hi', replyToId: null }),
    JSON.stringify({ target: { ...COLLECTION_TARGET, extra: 'x' }, body: 'hi', replyToId: null }),
    JSON.stringify({ target: COLLECTION_TARGET, body: '', replyToId: null }),
    JSON.stringify({ target: COLLECTION_TARGET, body: '   ', replyToId: null }),
    JSON.stringify({ target: COLLECTION_TARGET, body: 'x'.repeat(4_001), replyToId: null }),
    JSON.stringify({ target: COLLECTION_TARGET, body: 5, replyToId: null }),
    JSON.stringify({ target: COLLECTION_TARGET, body: 'hi', replyToId: 'bad id!' }),
    'not json',
  ]) {
    const response = await server.inject({ method: 'POST', url: COMMENTS_PATH, headers, payload });
    assert.equal(response.statusCode, 400, payload);
    assert.match(response.json().error.code, /^invalid_(request|json)$/u, payload);
  }
  await server.close();
});

test('POST comments forwards command-receipt kinds through sendProductCommandReceiptOutcome', async () => {
  const replayBody = Buffer.from('{"id":"comment-9","state":"visible"}');
  const cases: readonly {
    outcome: CommunityCommentCommandResult;
    status: number;
    code: string | null;
    body: string | null;
    retryAfter?: string;
  }[] = [
    {
      outcome: {
        kind: 'replay', status: 201, body: replayBody,
        stableHeaders: { 'cache-control': 'private, no-store' },
        mediaType: 'application/json',
        contractVersion: COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
      },
      status: 201, code: null, body: replayBody.toString(),
    },
    { outcome: { kind: 'reused' }, status: 409, code: 'command_id_reused', body: null },
    { outcome: { kind: 'in_progress', retryAfterSeconds: 3 },
      status: 409, code: 'command_in_progress', body: null, retryAfter: '3' },
    { outcome: { kind: 'expired', resultDigest: null },
      status: 410, code: 'command_result_expired', body: null },
  ];
  for (const testCase of cases) {
    const server = app({ createComment: async () => testCase.outcome });
    const response = await server.inject({ method: 'POST', url: COMMENTS_PATH,
      headers: { ...mutation(), 'content-type': 'application/json' }, payload: createBody() });
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

test('POST comments maps command errors to stable product codes', async () => {
  for (const [error, status, code] of [
    [new CommunityCommentError('revision_conflict', 'stale'), 409, 'revision_conflict'],
    [new CommunityCommentError('insufficient_permission', 'locked'), 403, 'insufficient_permission'],
    [new CommunityCommentError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE), 404, 'resource_not_found'],
    [new CommunityCommentError('invalid_request', 'depth'), 400, 'invalid_request'],
  ] as const) {
    const server = app({ createComment: async () => { throw error; } });
    const response = await server.inject({ method: 'POST', url: COMMENTS_PATH,
      headers: { ...mutation(), 'content-type': 'application/json' }, payload: createBody() });
    assert.equal(response.statusCode, status, code);
    assert.equal(response.json().error.code, code);
    await server.close();
  }
});

test('POST comments flag-off still requires auth first, then conceals', async () => {
  const server = app({ enabled: false });
  const unauthenticated = await server.inject({ method: 'POST', url: COMMENTS_PATH,
    headers: { 'content-type': 'application/json' }, payload: createBody() });
  assert.equal(unauthenticated.statusCode, 401);
  const response = await server.inject({ method: 'POST', url: COMMENTS_PATH,
    headers: { ...mutation(), 'content-type': 'application/json' }, payload: createBody() });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  await server.close();
});

/* ——— GET /community/comments/{commentId} ——— */

test('GET one comment returns 200 with a strong ETag; malformed ids are 400', async () => {
  const server = app({ getComment: async () => comment() });
  const response = await server.inject({ method: 'GET', url: COMMENT_PATH, headers: auth });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers.etag), /^"community-comment:[A-Za-z0-9_-]{32}"$/u);
  assert.equal(response.json().id, 'comment-1');
  for (const bad of ['bad%20id', 'id%2Fslash']) {
    const invalid = await server.inject({ method: 'GET', url: `/api/v1/community/comments/${bad}` });
    assert.equal(invalid.statusCode, 400, bad);
    assert.equal(invalid.json().error.code, 'invalid_request');
  }
  // Unknown query keys on the singleton read reject as invalid_query.
  const unknownQuery = await server.inject({ method: 'GET', url: `${COMMENT_PATH}?extra=1` });
  assert.equal(unknownQuery.statusCode, 400);
  assert.equal(unknownQuery.json().error.code, 'invalid_query');
  await server.close();
});

test('GET one comment maps concealment to 404 resource_not_found', async () => {
  const server = app({
    getComment: async () => {
      throw new CommunityCommentError('resource_not_found', 'The community comment was not found.');
    },
  });
  const response = await server.inject({ method: 'GET', url: COMMENT_PATH });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.doesNotMatch(response.body, /private@example|hidden|deleted/iu);
  await server.close();
});

/* ——— GET /community/comments/{commentId}/replies ——— */

test('GET replies returns the flattened page; non-root is 400 invalid_request', async () => {
  const server = app({
    listReplies: async () => ({
      items: [comment({ id: 'reply-1', depth: 1, replyToId: 'comment-1' })],
      nextCursor: 'cursor-2',
    }),
  });
  const response = await server.inject({ method: 'GET', url: `${REPLIES_PATH}?limit=10` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].replyToId, 'comment-1');
  assert.equal(body.nextCursor, 'cursor-2');
  for (const url of [`${REPLIES_PATH}?limit=0`, `${REPLIES_PATH}?foo=1`, `${REPLIES_PATH}?limit=1&limit=2`]) {
    const invalid = await server.inject({ method: 'GET', url });
    assert.equal(invalid.statusCode, 400, url);
    assert.equal(invalid.json().error.code, 'invalid_query', url);
  }
  const nonRoot = app({
    listReplies: async () => {
      throw new CommunityCommentError('invalid_request', 'The replies endpoint requires the root comment id.');
    },
  });
  const nonRootResponse = await nonRoot.inject({ method: 'GET', url: REPLIES_PATH });
  assert.equal(nonRootResponse.statusCode, 400);
  assert.equal(nonRootResponse.json().error.code, 'invalid_request');
  await server.close();
  await nonRoot.close();
});

/* ——— shared admission ——— */

test('community rate limiting applies to the comment paths', async () => {
  const server = app({ rate: 1, listComments: async () => ({ items: [], nextCursor: null }) });
  assert.equal((await server.inject({ method: 'GET', url: `${COMMENTS_PATH}${commentsQuery}` })).statusCode, 200);
  const limited = await server.inject({ method: 'GET', url: `${COMMENTS_PATH}${commentsQuery}` });
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
 * The read below never settles on its own — only the cancellation can stop it —
 * and the assertions observe what the route and the adapter did, not a reaction
 * staged by the fake.
 */
test('GET comments timeout hands the abort to the query unit of work, which cancels the PostgreSQL backend', async () => {
  const received: { signal?: AbortSignal } = {};
  const cancelledByPid: number[] = [];
  const queryAdapter = createPostgresCommunityCommentQueryUnitOfWork(
    fakeKyselyDatabase(BACKEND_PID),
    async (backendPid) => { cancelledByPid.push(backendPid); return true; },
  );
  const server = app({
    timeoutMs: 40,
    listComments: () => new Promise<never>(() => {}),
    queryUnitOfWork: {
      execute: (work, options) => {
        received.signal = options?.signal;
        return queryAdapter.execute(work, options);
      },
    },
  });
  const response = await server.inject({ method: 'GET', url: `${COMMENTS_PATH}${commentsQuery}` });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.equal(response.json().error.message, 'Community comments are temporarily unavailable.');
  // (a) The route handed the unit of work a signal and its own timeout aborted it.
  assert.ok(received.signal, 'the route must hand the query unit of work a signal');
  assert.equal(received.signal.aborted, true, 'the timeout must abort that signal');
  const reason: unknown = received.signal.reason;
  assert.ok(reason instanceof ProductHttpError, 'the signal reason must be the route\'s timeout error');
  assert.equal(reason.productCode, 'feature_temporarily_unavailable');
  // (b) The adapter acted on it: the backend running the read is cancelled by PID.
  assert.deepEqual(cancelledByPid, [BACKEND_PID],
    'the abort must reach cancelBackend so PostgreSQL cancels the running statement');
  await server.close();
});

test('CS-C04 a TypeError surfaces as internal_error, not invalid_request', async () => {
  const mapped = mapCommunityError(new TypeError('Cannot read properties of undefined'));
  assert.equal(mapped.statusCode, productErrorStatus('internal_error'));
  assert.equal(mapped.productCode, 'internal_error');
  // A real input validation error still maps to 400 invalid_request.
  const invalid = mapCommunityError(communityCommentInvalidRequest('bad input'));
  assert.equal(invalid.statusCode, 400);
});
