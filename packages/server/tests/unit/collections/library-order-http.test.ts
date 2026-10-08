import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import {
  LIBRARY_ORDER_COMMAND_CONTRACT_VERSION,
  LIBRARY_ORDER_MAX_ITEMS,
  LibraryOrderCommandError,
  type LibraryOrderCommandPorts,
  type LibraryOrderQueryPorts,
} from '../../../src/modules/collections/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { registerLibraryOrderRoutes } from '../../../src/transport/product/library-order-routes.js';
import { installProductRouteManifestChecks } from '../../../src/transport/product-route-manifest.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';

const ACTOR = 'EREREREREREREREREREREQ';
const COLLECTION_A = 'IiIiIiIiIiIiIiIiIiIiIg';
const COLLECTION_B = 'M2NkNGU1ZjZhN2I4YzlkMG';
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

function app(input: {
  rate?: number;
  timeoutMs?: number;
  command?: Parameters<typeof registerLibraryOrderRoutes>[1]['command'];
  query?: Parameters<typeof registerLibraryOrderRoutes>[1]['query'];
  queryExecute?: <Result>(
    work: (ports: LibraryOrderQueryPorts) => Promise<Result>,
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
  registerLibraryOrderRoutes(server, {
    allowedOrigins: ['https://app.example.test'],
    identityUnitOfWork,
    csrfMatches: (raw) => raw === 'csrf',
    commandUnitOfWork: { execute: <Result>(work: (ports: LibraryOrderCommandPorts) => Promise<Result>) =>
      work({} as LibraryOrderCommandPorts) },
    queryUnitOfWork: {
      execute: input.queryExecute ?? (<Result>(work: (ports: LibraryOrderQueryPorts) => Promise<Result>) =>
        work({} as LibraryOrderQueryPorts)),
    },
    command: input.command ?? (async (_ports, value) => ({
      kind: 'succeeded',
      order: { section: value.section, collectionIds: value.collectionIds },
    })),
    query: input.query ?? (async () => ({
      sections: { mine: [COLLECTION_A], shared: [], following: [COLLECTION_B] },
    })),
    rateLimiter: createFixedWindowRateLimiter({ maxRequests: input.rate ?? 100, windowMs: 60_000 }),
    timeoutMs: input.timeoutMs ?? 100,
  });
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };
const mutation = (extra: Record<string, string> = {}) => ({ ...auth, origin: 'https://app.example.test',
  'x-csrf-token': 'csrf', 'known-command-id': randomUUID(),
  'content-type': 'application/json', ...extra });
const GET_PATH = '/api/v1/me/library-order';
const putPath = (section = 'mine') => `/api/v1/me/library-order/${section}`;
const VALID_BODY = JSON.stringify({ collectionIds: [COLLECTION_A, COLLECTION_B] });

test('GET requires a session and returns every section with private no-store caching', async () => {
  const server = app();
  const anonymous = await server.inject({ method: 'GET', url: GET_PATH });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().error.code, 'authentication_required');
  const get = await server.inject({ method: 'GET', url: GET_PATH, headers: auth });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers['cache-control'], 'private, no-store');
  assert.deepEqual(get.json(), {
    sections: { mine: [COLLECTION_A], shared: [], following: [COLLECTION_B] },
  });
  const routes = server.printRoutes();
  assert.match(routes, /library-order \(GET\)/u);
  assert.doesNotMatch(routes, /library-order \([^)]*HEAD/u);
  const head = await server.inject({ method: 'HEAD', url: GET_PATH, headers: auth });
  assert.equal(head.statusCode, 404);
  await server.close();
});

test('PUT requires session Origin CSRF and command id; success echoes the saved order', async () => {
  const server = app();
  assert.equal((await server.inject({ method: 'PUT', url: putPath(), payload: VALID_BODY,
    headers: { 'content-type': 'application/json' } })).statusCode, 401);
  assert.equal((await server.inject({ method: 'PUT', url: putPath(), payload: VALID_BODY,
    headers: { ...auth, 'content-type': 'application/json' } })).statusCode, 403);
  const ok = await server.inject({ method: 'PUT', url: putPath(), headers: mutation(), payload: VALID_BODY });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  assert.deepEqual(ok.json(), { section: 'mine', collectionIds: [COLLECTION_A, COLLECTION_B] });
  await server.close();
});

test('PUT accepts every sidebar section and rejects unknown sections closed', async () => {
  const server = app();
  for (const section of ['mine', 'shared', 'following'] as const) {
    const ok = await server.inject({
      method: 'PUT', url: putPath(section), headers: mutation(), payload: VALID_BODY,
    });
    assert.equal(ok.statusCode, 200, section);
    assert.equal(ok.json().section, section);
  }
  for (const section of ['invitations', 'MINE', 'mine%20', 'unknown']) {
    const rejected = await server.inject({
      method: 'PUT', url: putPath(section), headers: mutation(), payload: VALID_BODY,
    });
    assert.equal(rejected.statusCode, 400, section);
    assert.equal(rejected.json().error.code, 'invalid_request', section);
  }
  await server.close();
});

test('PUT rejects malformed bodies as invalid_request', async () => {
  const server = app();
  const tooMany = Array.from(
    { length: LIBRARY_ORDER_MAX_ITEMS + 1 },
    (_, index) => `${COLLECTION_A.slice(0, 18)}${String(index).padStart(4, '0')}`,
  );
  const badBodies = [
    '[]',
    '{}',
    JSON.stringify({ collectionIds: 'not-an-array' }),
    JSON.stringify({ collectionIds: [COLLECTION_A], extra: true }),
    JSON.stringify({ collectionIds: [COLLECTION_A, COLLECTION_A] }),
    JSON.stringify({ collectionIds: ['bad id with spaces'] }),
    JSON.stringify({ collectionIds: [123] }),
    JSON.stringify({ collectionIds: tooMany }),
  ];
  for (const payload of badBodies) {
    const response = await server.inject({ method: 'PUT', url: putPath(), headers: mutation(), payload });
    assert.equal(response.statusCode, 400, payload.slice(0, 60));
    assert.equal(response.json().error.code, 'invalid_request', payload.slice(0, 60));
  }
  await server.close();
});

test('PUT forwards command-receipt kinds through sendProductCommandReceiptOutcome', async () => {
  const replayBody = Buffer.from(JSON.stringify({ section: 'mine', collectionIds: [COLLECTION_A] }));
  const cases = [
    {
      outcome: {
        kind: 'replay' as const,
        status: 200,
        body: replayBody,
        stableHeaders: { 'cache-control': 'private, no-store' },
        mediaType: 'application/json',
        contractVersion: LIBRARY_ORDER_COMMAND_CONTRACT_VERSION,
      },
      status: 200,
      code: null,
      body: replayBody.toString(),
    },
    { outcome: { kind: 'reused' as const }, status: 409, code: 'command_id_reused', body: null },
    {
      outcome: { kind: 'in_progress' as const, retryAfterSeconds: 2 },
      status: 409,
      code: 'command_in_progress',
      body: null,
    },
    {
      outcome: { kind: 'expired' as const, resultDigest: 'deadbeef' },
      status: 410,
      code: 'command_result_expired',
      body: null,
    },
  ] as const;
  for (const testCase of cases) {
    const server = app({ command: async () => testCase.outcome });
    const response = await server.inject({
      method: 'PUT', url: putPath(), headers: mutation(), payload: VALID_BODY,
    });
    assert.equal(response.statusCode, testCase.status, testCase.outcome.kind);
    if (testCase.body !== null) {
      assert.equal(response.body, testCase.body);
    } else {
      assert.equal(response.json().error.code, testCase.code, testCase.outcome.kind);
    }
    await server.close();
  }
});

test('application invalid_request errors map to 400 with the closed envelope', async () => {
  const server = app({
    command: async () => { throw new LibraryOrderCommandError('invalid_request', 'The Library order is invalid.'); },
  });
  const response = await server.inject({
    method: 'PUT', url: putPath(), headers: mutation(), payload: VALID_BODY,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_request');
  assert.equal(response.json().error.message, 'The Library order is invalid.');
  await server.close();
});

test('oversized PUT bodies are rejected with 413 before reaching the handler', async () => {
  const server = app({
    command: async () => { throw new Error('must not run'); },
  });
  const oversized = JSON.stringify({
    collectionIds: Array.from({ length: 2_000 }, (_, index) => `${'A'.repeat(100)}${index}`),
  });
  const response = await server.inject({
    method: 'PUT', url: putPath(), headers: mutation(), payload: oversized,
  });
  assert.equal(response.statusCode, 413);
  await server.close();
});

test('PUT without Known-Command-Id is invalid_request', async () => {
  const server = app();
  const { 'known-command-id': _commandId, ...headers } = mutation();
  const response = await server.inject({
    method: 'PUT', url: putPath(), headers, payload: VALID_BODY,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_request');
  await server.close();
});

test('GET rejects unknown query parameters', async () => {
  const server = app();
  const response = await server.inject({
    method: 'GET', url: `${GET_PATH}?foo=1`, headers: auth,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'invalid_query');
  await server.close();
});

test('PUT accepts 200 unique ids and rejects 201', async () => {
  const server = app();
  const exact = Array.from(
    { length: LIBRARY_ORDER_MAX_ITEMS },
    (_, index) => `${COLLECTION_A.slice(0, 18)}${String(index).padStart(4, '0')}`,
  );
  const ok = await server.inject({
    method: 'PUT', url: putPath(), headers: mutation(),
    payload: JSON.stringify({ collectionIds: exact }),
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().collectionIds.length, LIBRARY_ORDER_MAX_ITEMS);
  const tooMany = await server.inject({
    method: 'PUT', url: putPath(), headers: mutation(),
    payload: JSON.stringify({ collectionIds: [...exact, `${COLLECTION_B}`] }),
  });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.json().error.code, 'invalid_request');
  await server.close();
});

test('GET and PUT share the library-order rate-limit bucket', async () => {
  const server = app({ rate: 1 });
  assert.equal((await server.inject({ method: 'GET', url: GET_PATH, headers: auth })).statusCode, 200);
  const limited = await server.inject({ method: 'GET', url: GET_PATH, headers: auth });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'rate_limited');
  await server.close();
});

test('GET timeout aborts the query unit of work so PostgreSQL can cancel', async () => {
  const received: { signal?: AbortSignal } = {};
  const server = app({
    timeoutMs: 40,
    queryExecute: <Result>(
      _work: (ports: LibraryOrderQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result> => {
      received.signal = options?.signal;
      return new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) return;
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  });
  const response = await server.inject({ method: 'GET', url: GET_PATH, headers: auth });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.ok(received.signal);
  assert.equal(received.signal.aborted, true);
  await server.close();
});
