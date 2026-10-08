import type { FastifyInstance, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import { secretsMatch, type IdentityUnitOfWork } from '../../modules/identity/index.js';
import type {
  Phase4bMcpWriteApprovalApi,
  WriteApprovalAccount,
  WriteApprovalDecision,
  WriteApprovalDecisionInput,
} from '../../modules/mcp/index.js';
import { AgentPlanUndoError, WriteApprovalApiError } from '../../modules/mcp/index.js';
import type { McpRateLimiter } from '../../infrastructure/rate-limit/index.js';
import {
  readKnownCommandId,
  readRequiredIfMatch,
} from '../product/collection-route-helpers.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import { sendProductCommandReceiptOutcome } from '../product-command-mapping.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { authenticationRequired, requireBrowserSessionActor } from '../session-auth.js';
import { hasAuthorizationHeader, rejectMixedCarriers } from '../product-actor.js';
import { requireAllowedOrigin, requireCsrfHeader } from '../auth/origin-csrf.js';
import { productErrorStatus } from '../product-codes.js';

const LIST = '/api/v1/mcp/approvals';
const ITEM = '/api/v1/mcp/approvals/:planId';
const DECISION = '/api/v1/mcp/approvals/:planId/decision';
const UNDO = '/api/v1/mcp/approvals/:planId/undo';
const POLICY = '/api/v1/me/agents/:clientId/policy';
const PLAN_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/u;
const MAX_LIST_LIMIT = 100;

export interface McpWriteApprovalRoutesDependencies {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly api: Phase4bMcpWriteApprovalApi;
  /** FIX-M-018: unified MCP rate-limit port (`approval` policy), shared across replicas. */
  readonly rateLimiter: McpRateLimiter;
  readonly timeoutMs: number;
  readonly csrfMatches?: (raw: string, expectedHash: string) => boolean;
}

export function registerMcpWriteApprovalRoutes(
  app: FastifyInstance,
  deps: McpWriteApprovalRoutesDependencies,
): void {
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 30_000) {
    throw new TypeError('MCP-W07 approval route timeout is outside the application budget.');
  }
  const privateTransport = {
    duplicateQueryErrorCode: 'invalid_request' as const,
    queryErrorCode: 'invalid_request' as const,
    cacheControl: 'private-no-store' as const,
  };

  app.get(LIST, {
    config: {
      ...productRouteMetadata('GET', LIST),
      productTransport: {
        ...privateTransport,
        allowedQuery: ['limit'],
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
      },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    const account = await actor(request, deps, false, LIST);
    const limit = parseLimit(request.query as Readonly<Record<string, string>>);
    try {
      const page = await withCancellation(request, deps.timeoutMs, () =>
        deps.api.list(account, { limit }));
      return reply.code(200).type('application/json; charset=utf-8').send(page);
    } catch (error) {
      throw mapWriteApprovalError(error);
    }
  });

  app.get(ITEM, {
    config: {
      ...productRouteMetadata('GET', ITEM),
      productTransport: {
        ...privateTransport,
        allowedQuery: [],
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
      },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    const account = await actor(request, deps, false, ITEM);
    const planId = readPlanId(request);
    try {
      const view = await withCancellation(request, deps.timeoutMs, () =>
        deps.api.get(account, planId));
      if (view === undefined) throw notFound();
      reply.header('ETag', view.etag);
      return reply.code(200).type('application/json; charset=utf-8').send(view);
    } catch (error) {
      throw mapWriteApprovalError(error);
    }
  });

  app.post(DECISION, {
    config: {
      ...productRouteMetadata('POST', DECISION),
      productTransport: {
        ...privateTransport,
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 8_192,
      },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    // Approval authority must not be mintable by the machine creating the plan.
    const { account, session } = await requireBrowserSessionActor(
      request, deps.identityUnitOfWork, { touch: true },
    );
    requireAllowedOrigin(request, deps.allowedOrigins);
    requireCsrfHeader(request, session.csrfTokenHash, deps.csrfMatches ?? secretsMatch);
    const accountView: WriteApprovalAccount = Object.freeze({
      id: account.id,
    });
    const rateOutcome = await deps.rateLimiter.consume({
      policy: 'approval',
      facts: `${DECISION}:principal:${account.id}`,
    });
    if (rateOutcome.kind === 'denied') throw rateLimited(rateOutcome.decision.retryAfterSeconds);
    if (rateOutcome.kind === 'failed') throw unavailable();

    const planId = readPlanId(request);
    const commandId = readKnownCommandId(request);
    const ifMatch = readRequiredIfMatch(request);
    const decision = parseDecisionBody(request.body);
    const routeIdentity = `/api/v1/mcp/approvals/${planId}/decision`;
    const commandScope = httpCommandScopeV1('POST', routeIdentity);
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST',
      route: routeIdentity,
      resource: `mcp:approval:${planId}`,
      mediaType: 'application/json',
      query: {},
      conditions: { ifMatch },
      body: { decision },
    });
    const input: WriteApprovalDecisionInput = Object.freeze({
      planId,
      decision,
      account: accountView,
      commandId,
      commandScope,
      fingerprint,
      ifMatch,
    });

    try {
      const outcome = await withCancellation(request, deps.timeoutMs, (signal) =>
        deps.api.decide(Object.freeze({ ...input, signal })));
      if (outcome.kind === 'succeeded') {
        reply.header('ETag', outcome.result.etag);
        return reply.code(200).type('application/json; charset=utf-8').send(outcome.result);
      }
      if (outcome.kind === 'replay') {
        return sendProductCommandReceiptOutcome(reply, {
          kind: 'replay',
          status: outcome.result.status,
          body: outcome.result.body,
          stableHeaders: outcome.result.stableHeaders,
          mediaType: outcome.result.mediaType,
        });
      }
      return sendProductCommandReceiptOutcome(reply, outcome);
    } catch (error) {
      throw mapWriteApprovalError(error);
    }
  });

  app.get(POLICY, {
    config: {
      productTransport: {
        ...privateTransport,
        allowedQuery: [],
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
      },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    await actor(request, deps, false, POLICY);
    const clientId = readClientId(request);
    const api = policyApi(deps);
    if (api.getAgentPolicy === undefined) throw notFound();
    try {
      const view = await withCancellation(request, deps.timeoutMs, () => api.getAgentPolicy!(clientId));
      return reply.code(200).type('application/json; charset=utf-8').send(view);
    } catch (error) {
      throw mapWriteApprovalError(error);
    }
  });

  app.put(POLICY, {
    config: {
      productTransport: {
        ...privateTransport,
        allowedQuery: [],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 1_024,
      },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    const { account, session } = await requireBrowserSessionActor(
      request, deps.identityUnitOfWork, { touch: true },
    );
    requireAllowedOrigin(request, deps.allowedOrigins);
    requireCsrfHeader(request, session.csrfTokenHash, deps.csrfMatches ?? secretsMatch);
    await consumeApproval(deps, `${POLICY}:principal:${account.id}`);
    const clientId = readClientId(request);
    const policy = parsePolicyBody(request.body);
    const api = policyApi(deps);
    if (api.putAgentPolicy === undefined) throw notFound();
    try {
      const view = await withCancellation(request, deps.timeoutMs, () =>
        api.putAgentPolicy!(clientId, policy));
      return reply.code(200).type('application/json; charset=utf-8').send(view);
    } catch (error) {
      throw mapWriteApprovalError(error);
    }
  });

  app.post(UNDO, {
    config: {
      productTransport: {
        ...privateTransport,
        allowedQuery: ['force'],
        acceptedMediaTypes: ['application/json'],
        bodyLimitBytes: 1_024,
      },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    const { account, session } = await requireBrowserSessionActor(
      request, deps.identityUnitOfWork, { touch: true },
    );
    requireAllowedOrigin(request, deps.allowedOrigins);
    requireCsrfHeader(request, session.csrfTokenHash, deps.csrfMatches ?? secretsMatch);
    await consumeApproval(deps, `${UNDO}:principal:${account.id}`);
    const planId = readPlanId(request);
    const commandId = readKnownCommandId(request);
    const force = parseForce(request.query as Readonly<Record<string, string>>);
    parseEmptyUndoBody(request.body);
    const api = policyApi(deps);
    if (api.undo === undefined) throw notFound();
    try {
      const result = await withCancellation(request, deps.timeoutMs, () => api.undo!({
        accountId: account.id,
        subjectId: account.subjectId,
        planId,
        force,
        commandId,
      }));
      return reply.code(200).type('application/json; charset=utf-8').send(result);
    } catch (error) {
      throw mapWriteApprovalError(error);
    }
  });
}

function exposure(deps: McpWriteApprovalRoutesDependencies) {
  return async (request: FastifyRequest) => {
    if (!deps.enabled) {
      throw new ProductHttpError({
        statusCode: 404,
        code: 'resource_not_found',
        message: 'The requested resource was not found.',
        recovery: 'none',
      });
    }
    // Reject the credential family before reads can disclose plan IDs or ETags.
    // A same-account Product bearer is not an independent human approval.
    rejectMixedCarriers(request);
    if (hasAuthorizationHeader(request)) throw authenticationRequired();
  };
}

async function actor(
  request: FastifyRequest,
  deps: McpWriteApprovalRoutesDependencies,
  touch: boolean,
  family: string,
): Promise<WriteApprovalAccount> {
  const { account } = await requireBrowserSessionActor(request, deps.identityUnitOfWork, { touch });
  const outcome = await deps.rateLimiter.consume({
    policy: 'approval',
    facts: `${family}:principal:${account.id}`,
  });
  if (outcome.kind === 'denied') throw rateLimited(outcome.decision.retryAfterSeconds);
  if (outcome.kind === 'failed') throw unavailable();
  return Object.freeze({
    id: account.id,
  });
}

function readPlanId(request: FastifyRequest): string {
  const value = (request.params as { planId?: string }).planId;
  if (typeof value !== 'string' || !PLAN_ID_PATTERN.test(value)) {
    throw invalidRequest();
  }
  return value;
}

function parseLimit(query: Readonly<Record<string, string>>): number | undefined {
  const raw = query.limit;
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(raw) || Number(raw) > MAX_LIST_LIMIT) throw invalidRequest();
  return Number(raw);
}

function parseDecisionBody(body: unknown): WriteApprovalDecision {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidDocument();
  }
  const record = body as Readonly<Record<string, unknown>>;
  if (Object.keys(record).join('|') !== 'decision') throw invalidDocument();
  if (record.decision !== 'approve' && record.decision !== 'deny') throw invalidDocument();
  return record.decision;
}

async function withCancellation<Result>(
  request: FastifyRequest,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  let rejectAbort!: (error: ProductHttpError) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  observeBestEffort(cancellation,
    'the route race owns cancellation and must observe a rejection before race setup');
  const timeout = setTimeout(() => {
    controller.abort(unavailable());
    rejectAbort(unavailable());
  }, timeoutMs);
  timeout.unref?.();
  const abort = () => {
    controller.abort(unavailable());
    rejectAbort(unavailable());
  };
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  const running = work(controller.signal);
  try {
    return await Promise.race([running, cancellation]);
  } finally {
    clearTimeout(timeout);
    request.raw.off('aborted', abort);
    request.raw.socket.off('close', abort);
    observeBestEffort(running,
      'the route cancellation result is authoritative over a late operation rejection');
  }
}

export function mapWriteApprovalError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof AgentPlanUndoError) return mapUndoError(error);
  if (error instanceof WriteApprovalApiError) {
    switch (error.code) {
      case 'plan_not_found':
        return notFound();
      case 'precondition_failed':
        return new ProductHttpError({
          statusCode: productErrorStatus('precondition_failed'),
          code: 'precondition_failed',
          message: 'The Plan changed before the approval decision.',
          recovery: 'refresh_and_retry',
          precondition: 'resource',
          currentEtag: error.currentEtag,
        });
      case 'decision_conflict':
        return new ProductHttpError({
          statusCode: productErrorStatus('mutation_conflict'),
          code: 'mutation_conflict',
          message: 'The Plan is no longer available for this decision.',
          recovery: 'refresh_and_retry',
        });
      case 'unknown_outcome':
        return new ProductHttpError({
          statusCode: productErrorStatus('internal_error'),
          code: 'internal_error',
          message: 'The approval request could not be completed.',
          recovery: 'same_request',
        });
    }
  }
  if (error instanceof TypeError) return invalidRequest();
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return unavailable();
  }
  const kind = (error as { readonly kind?: unknown } | null)?.kind;
  if (
    kind === 'serialization_failure'
    || kind === 'deadlock'
    || kind === 'lock_timeout'
    || kind === 'unavailable'
  ) {
    return unavailable();
  }
  return new ProductHttpError({
    statusCode: productErrorStatus('internal_error'),
    code: 'internal_error',
    message: 'The approval request could not be completed.',
    recovery: 'same_request',
  });
}

interface AgentPolicyApprovalMethods {
  getAgentPolicy?(clientId: string): Promise<{ readonly clientId: string; readonly policy: 'manual' | 'trusted' }>;
  putAgentPolicy?(
    clientId: string,
    policy: 'manual' | 'trusted',
  ): Promise<{ readonly clientId: string; readonly policy: 'manual' | 'trusted' }>;
  undo?(input: Readonly<{
    accountId: string;
    subjectId: string;
    planId: string;
    force: boolean;
    commandId: string;
  }>): Promise<unknown>;
}

function policyApi(deps: McpWriteApprovalRoutesDependencies): AgentPolicyApprovalMethods {
  return deps.api as Phase4bMcpWriteApprovalApi & AgentPolicyApprovalMethods;
}

function readClientId(request: FastifyRequest): string {
  const value = (request.params as { clientId?: string }).clientId;
  if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) throw invalidRequest();
  return value;
}

function parsePolicyBody(body: unknown): 'manual' | 'trusted' {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidDocument();
  const record = body as Readonly<Record<string, unknown>>;
  if (Object.keys(record).join('|') !== 'policy') throw invalidDocument();
  if (record.policy !== 'manual' && record.policy !== 'trusted') throw invalidDocument();
  return record.policy;
}

function parseForce(query: Readonly<Record<string, string>>): boolean {
  const raw = query.force;
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw invalidRequest();
}

function parseEmptyUndoBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body)) throw invalidDocument();
  if (Object.keys(body as Readonly<Record<string, unknown>>).length !== 0) throw invalidDocument();
}

async function consumeApproval(
  deps: McpWriteApprovalRoutesDependencies,
  facts: string,
): Promise<void> {
  const outcome = await deps.rateLimiter.consume({ policy: 'approval', facts });
  if (outcome.kind === 'denied') throw rateLimited(outcome.decision.retryAfterSeconds);
  if (outcome.kind === 'failed') throw unavailable();
}

function mapUndoError(error: AgentPlanUndoError): ProductHttpError {
  if (error.code === 'not_found') {
    return new ProductHttpError({
      statusCode: productErrorStatus('resource_not_found'),
      code: 'resource_not_found',
      message: error.message,
      recovery: 'none',
    });
  }
  if (error.code === 'newer_version' || error.code === 'sync_tombstone_conflict') {
    return new ProductHttpError({
      statusCode: productErrorStatus('mutation_conflict'),
      code: 'mutation_conflict',
      message: error.message,
      recovery: 'refresh_and_retry',
    });
  }
  return new ProductHttpError({
    statusCode: productErrorStatus('internal_error'),
    code: 'internal_error',
    message: error.message,
    recovery: 'same_request',
  });
}

function invalidRequest(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request',
    message: 'The approval request is invalid.',
  });
}

function invalidDocument(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_document'),
    code: 'invalid_document',
    message: 'The approval decision document is invalid.',
    recovery: 'user_action',
  });
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('resource_not_found'),
    code: 'resource_not_found',
    message: 'The requested approval was not found.',
    recovery: 'none',
  });
}

function rateLimited(retryAfterSeconds: number): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('rate_limited'),
    code: 'rate_limited',
    message: 'Too many approval requests. Please try again later.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

function unavailable(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('feature_temporarily_unavailable'),
    code: 'feature_temporarily_unavailable',
    message: 'Approvals are temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}
