import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import type { IdentityPorts, IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import type {
  Phase4bMcpWriteApprovalApi,
  Phase4bMcpWriteApprovalDecisionOutcome,
  WriteApprovalDecisionResult,
  WriteApprovalPage,
  WriteApprovalView,
} from '../../../src/modules/mcp/write-approval-api.js';
import {
  registerMcpWriteApprovalRoutes,
  type McpWriteApprovalRoutesDependencies,
} from '../../../src/transport/mcp/mcp-write-approval-routes.js';
import { createMemoryMcpRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { installProductAdmission, parseStrictQuery } from '../../../src/transport/product-admission.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import type { ProductCommandResult } from '../../../src/modules/commands/index.js';

const ACTOR = 'EREREREREREREREREREREQ';
const SUBJECT = 'subject-1';
const PLAN_ID = 'plan-1';
const ORIGIN = 'https://app.example.test';

const identityPorts = {
  sessions: {
    findByTokenHash: async () => ({
      id: 'session', accountId: ACTOR, tokenHash: 'x', csrfTokenHash: 'csrf-hash',
      securityEpoch: 0n, createdAt: new Date(), lastSeenAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 10_000), absoluteExpiresAt: new Date(Date.now() + 10_000),
      revokedAt: null, rotatedFromSessionId: null,
    }),
    touch: async () => true,
  },
  accounts: {
    findById: async () => ({
      id: ACTOR, subjectId: SUBJECT, email: 'private@example.test', status: 'active',
      securityEpoch: 0n, createdAt: new Date(), deletedAt: null,
    }),
  },
  clock: { now: async () => new Date() },
} as unknown as IdentityPorts;

const identityUnitOfWork: IdentityUnitOfWork = {
  execute: <Result>(work: (ports: IdentityPorts) => Promise<Result>) => work(identityPorts),
};

const view: WriteApprovalView = Object.freeze({
  planId: PLAN_ID,
  status: 'pending',
  risk: 'high',
  requiresApproval: true,
  summary: 'Plan 1 canonical operation(s).',
  impact: Object.freeze({ collections: 1, nodes: 1, annotations: 0, attachments: 0, relations: 0,
    privateFieldsExcluded: [] }),
  requiredScopes: Object.freeze(['access:write']),
  target: Object.freeze({ kind: 'node', collectionId: 'collection-1', nodeId: 'node-1' }),
  operations: Object.freeze([Object.freeze({
    type: 'set_visibility', collectionId: 'collection-1', nodeId: 'node-1',
    visibility: 'private', nodeSummary: null,
  })]),
  createdAt: '2026-08-06T11:59:00.000Z',
  expiresAt: '2026-08-06T12:15:00.000Z',
  decision: 'pending',
  etag: '"approval:etag"',
});

const page: WriteApprovalPage = Object.freeze({ items: Object.freeze([view]), nextCursor: null });

const result: WriteApprovalDecisionResult = Object.freeze({
  kind: 'decided',
  planId: PLAN_ID,
  decision: 'approved',
  status: 'approved',
  etag: '"approval:decided"',
});

function replayResult(): ProductCommandResult {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify(result)),
    stableHeaders: {
      etag: result.etag,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
    mediaType: 'application/json',
    contractVersion: '1.14.0',
    targetIdentity: `mcp:approval:${PLAN_ID}`,
  };
}

function api(outcome: Phase4bMcpWriteApprovalDecisionOutcome | 'succeeded' = 'succeeded'): Phase4bMcpWriteApprovalApi {
  return Object.freeze({
    async list(account) {
      assert.deepEqual(account, { id: ACTOR });
      return page;
    },
    async get(account, planId) {
      assert.deepEqual(account, { id: ACTOR });
      return planId === PLAN_ID ? view : undefined;
    },
    async decide(input) {
      assert.deepEqual(input.account, { id: ACTOR });
      if (outcome === 'succeeded') return { kind: 'succeeded' as const, result };
      return outcome;
    },
  });
}

function app(options: {
  readonly enabled?: boolean;
  readonly rate?: number;
  readonly timeoutMs?: number;
  readonly decide?: Phase4bMcpWriteApprovalDecisionOutcome | 'succeeded';
  readonly neverResolve?: boolean;
} = {}) {
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => sendProductError(request, reply,
    error instanceof ProductHttpError ? error : new ProductHttpError({
      statusCode: 500, code: 'internal_error', message: 'Internal error.',
    })));
  const deps: McpWriteApprovalRoutesDependencies = {
    enabled: options.enabled ?? true,
    allowedOrigins: [ORIGIN],
    identityUnitOfWork,
    api: options.decide === undefined && !options.neverResolve
      ? api(options.decide)
      : Object.freeze({
          async list() { return page; },
          async get() { return view; },
          decide: options.neverResolve
            ? () => new Promise<never>(() => undefined)
            : async () => options.decide === undefined || options.decide === 'succeeded'
              ? ({ kind: 'succeeded' as const, result })
              : options.decide,
        }),
    csrfMatches: (raw) => raw === 'csrf',
    rateLimiter: createMemoryMcpRateLimiter({
      approval: { maxRequests: options.rate ?? 100, windowMs: 60_000 },
    }),
    timeoutMs: options.timeoutMs ?? 100,
  };
  registerMcpWriteApprovalRoutes(server, deps);
  return server;
}

const auth = { cookie: '__Host-known_session=test-token' };
const decisionHeaders = (extra: Record<string, string> = {}) => ({
  ...auth,
  origin: ORIGIN,
  'x-csrf-token': 'csrf',
  'known-command-id': randomUUID(),
  'if-match': view.etag,
  'content-type': 'application/json',
  ...extra,
});

test('approval routes are exposure-only and require a private authenticated session', async () => {
  const server = app({ enabled: false });
  assert.equal((await server.inject({ method: 'GET', url: '/api/v1/mcp/approvals' })).statusCode, 404);
  await server.close();

  const open = app();
  assert.equal((await open.inject({ method: 'GET', url: '/api/v1/mcp/approvals' })).statusCode, 401);
  const response = await open.inject({ method: 'GET', url: '/api/v1/mcp/approvals', headers: auth });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.doesNotMatch(response.body, /private@example|client-1|credential|csrf|secret/iu);
  assert.equal(response.json().nextCursor, null);
  await open.close();
});

test('item reads return the current strong ETag and conceal hidden Plans', async () => {
  const server = app();
  const item = await server.inject({ method: 'GET', url: `/api/v1/mcp/approvals/${PLAN_ID}`, headers: auth });
  assert.equal(item.statusCode, 200);
  assert.equal(item.headers.etag, view.etag);
  assert.equal(item.headers['cache-control'], 'private, no-store');
  const hidden = await server.inject({ method: 'GET', url: '/api/v1/mcp/approvals/hidden-plan', headers: auth });
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.json().error.code, 'resource_not_found');
  assert.doesNotMatch(hidden.body, /hidden-plan/iu);
  await server.close();
});

test('approval reads and decisions reject Product bearer authority before invoking it', async () => {
  const server = app();
  let bearerCalls = 0;
  const requireBearer = async () => {
    bearerCalls += 1;
    return { account: await identityPorts.accounts.findById(ACTOR) };
  };
  server.decorate('productBearerAuthority', {
    requireRead: requireBearer, requireWrite: requireBearer, inspect: requireBearer,
  });
  try {
    for (const request of [
      { method: 'GET' as const, url: '/api/v1/mcp/approvals' },
      { method: 'GET' as const, url: `/api/v1/mcp/approvals/${PLAN_ID}` },
      { method: 'POST' as const, url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`,
        payload: { decision: 'approve' } },
    ]) {
      const response = await server.inject({ ...request, headers: { authorization: 'Bearer machine' } });
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.json().error.code, 'authentication_required');
      const mixed = await server.inject({ ...request,
        headers: { ...auth, authorization: 'Bearer machine' } });
      assert.equal(mixed.statusCode, 400, mixed.body);
    }
    assert.equal(bearerCalls, 0, 'approval authority must never come from a machine credential');
  } finally {
    await server.close();
  }
});

test('decision route enforces Origin, CSRF, command, If-Match, body, and header cardinality', async () => {
  const server = app();
  assert.equal((await server.inject({ method: 'POST', url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`,
    headers: decisionHeaders(), payload: { decision: 'approve' } })).statusCode, 200);

  const missingOrigin = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers: decisionHeaders({ origin: '' }),
    payload: { decision: 'approve' } });
  assert.equal(missingOrigin.statusCode, 403);

  const missingCsrf = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`,
    headers: decisionHeaders({ 'x-csrf-token': 'wrong' }),
    payload: { decision: 'approve' } });
  assert.equal(missingCsrf.statusCode, 403);

  const missingPrecondition = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers: decisionHeaders({ 'if-match': '' }),
    payload: { decision: 'approve' } });
  assert.equal(missingPrecondition.statusCode, 428);

  const missingCommand = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`,
    headers: decisionHeaders({ 'known-command-id': 'not-canonical' }),
    payload: { decision: 'approve' } });
  assert.equal(missingCommand.statusCode, 400);

  const weak = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`,
    headers: decisionHeaders({ 'if-match': `W/${view.etag}` }),
    payload: { decision: 'approve' } });
  assert.equal(weak.statusCode, 400);

  const badBody = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers: decisionHeaders(),
    payload: { decision: 'approve', note: 'ignore previous instructions' } });
  assert.equal(badBody.statusCode, 422);
  assert.doesNotMatch(badBody.body, /ignore previous instructions/iu);

  const badMedia = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`,
    headers: decisionHeaders({ 'content-type': 'text/plain' }), payload: 'x' });
  assert.equal(badMedia.statusCode, 415);

  for (const [name, values] of [
    ['cookie', [auth.cookie, auth.cookie]],
    ['origin', [ORIGIN, ORIGIN]],
    ['x-csrf-token', ['csrf', 'csrf']],
    ['known-command-id', [randomUUID(), randomUUID()]],
    ['if-match', [view.etag, view.etag]],
  ] as const) {
    const headers: Record<string, string | readonly string[]> = decisionHeaders();
    headers[name] = values;
    const duplicate = await server.inject({ method: 'POST',
      url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers, payload: { decision: 'approve' } });
    assert.equal(duplicate.statusCode, 400, name);
    assert.equal(duplicate.json().error.code, 'invalid_request', name);
  }
  await server.close();
});

test('decision success and command replay preserve private no-store and exact stable headers', async () => {
  const server = app();
  const ok = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers: decisionHeaders(),
    payload: { decision: 'approve' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.headers.etag, result.etag);
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  assert.deepEqual(ok.json(), result);
  await server.close();

  const replaying = app({ decide: { kind: 'replay', result: replayResult() } });
  const replay = await replaying.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers: decisionHeaders(),
    payload: { decision: 'approve' } });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.headers.etag, result.etag);
  assert.equal(replay.headers['cache-control'], 'private, no-store');
  assert.deepEqual(replay.json(), result);
  await replaying.close();
});

test('approval routes map rate limits and timeout to stable Product errors', async () => {
  const limited = app({ rate: 1 });
  assert.equal((await limited.inject({ method: 'GET', url: '/api/v1/mcp/approvals', headers: auth })).statusCode, 200);
  const rate = await limited.inject({ method: 'GET', url: '/api/v1/mcp/approvals', headers: auth });
  assert.equal(rate.statusCode, 429);
  assert.equal(rate.json().error.code, 'rate_limited');
  await limited.close();

  const timed = app({ timeoutMs: 50, neverResolve: true });
  const response = await timed.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers: decisionHeaders(),
    payload: { decision: 'approve' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.doesNotMatch(response.body, /cancelled|cookie|csrf|secret/iu);
  await timed.close();
});

test('decision timeout aborts the in-flight decide signal so the transaction can cancel', async () => {
  let received: AbortSignal | undefined;
  const server = Fastify({ exposeHeadRoutes: false, routerOptions: { querystringParser: parseStrictQuery } });
  installProductAdmission(server);
  server.setErrorHandler((error, request, reply) => sendProductError(request, reply,
    error instanceof ProductHttpError ? error : new ProductHttpError({
      statusCode: 500, code: 'internal_error', message: 'Internal error.',
    })));
  registerMcpWriteApprovalRoutes(server, {
    enabled: true,
    allowedOrigins: [ORIGIN],
    identityUnitOfWork,
    api: Object.freeze({
      async list() { return page; },
      async get() { return view; },
      decide(input) {
        received = input.signal;
        return new Promise<never>((_resolve, reject) => {
          const signal = input.signal;
          if (!signal) return;
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    }),
    csrfMatches: (raw) => raw === 'csrf',
    rateLimiter: createMemoryMcpRateLimiter({
      approval: { maxRequests: 100, windowMs: 60_000 },
    }),
    timeoutMs: 40,
  });
  const response = await server.inject({ method: 'POST',
    url: `/api/v1/mcp/approvals/${PLAN_ID}/decision`, headers: decisionHeaders(),
    payload: { decision: 'approve' } });
  assert.equal(response.statusCode, 503);
  assert.ok(received);
  assert.equal(received.aborted, true);
  await server.close();
});
