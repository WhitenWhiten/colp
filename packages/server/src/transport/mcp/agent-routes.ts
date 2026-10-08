import { AccountCredentialCommandError } from '../../modules/auth/index.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { observeBestEffort } from '../../infrastructure/async/best-effort.js';
import { secretsMatch } from '../../modules/identity/index.js';
import { ProductHttpError } from '../product-error.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { authenticationRequired, requireBrowserSessionActor } from '../session-auth.js';
import { hasAuthorizationHeader, rejectMixedCarriers } from '../product-actor.js';
import { requireAllowedOrigin, requireCsrfHeader } from '../auth/origin-csrf.js';
import { productErrorStatus } from '../product-codes.js';
import type { McpWriteApprovalRoutesDependencies } from './mcp-write-approval-routes.js';

const LIST = '/api/v1/me/agents';
const AUDIT = '/api/v1/me/agents/:id/audit';
const REVOKE = '/api/v1/me/agents/:id/revoke';
const AGENT_ID = /^[A-Za-z0-9._~-]{1,256}$/u;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

interface AgentDirectoryApi {
  issueAgentKey?(accountId: string, name: string, commandId: string): Promise<{ id: string; name: string; secret: string }>;
  listAgents?(accountId: string): Promise<{ readonly agents: readonly unknown[] }>;
  listAgentAudit?(
    accountId: string,
    agentId: string,
    limit: number,
  ): Promise<{ readonly records: readonly unknown[] } | undefined>;
  revokeAgent?(
    accountId: string,
    agentId: string,
  ): Promise<{ readonly id: string; readonly revoked: true; readonly cancelledPlanCount: number } | undefined>;
}

export function registerAgentDirectoryRoutes(
  app: FastifyInstance,
  deps: McpWriteApprovalRoutesDependencies,
): void {
  const transport = {
    duplicateQueryErrorCode: 'invalid_request' as const,
    queryErrorCode: 'invalid_request' as const,
    cacheControl: 'private-no-store' as const,
  };
  app.post('/api/v1/me/agents/keys', {
    config: {
      ...productRouteMetadata('POST', '/api/v1/me/agents/keys'),
      productTransport: { ...transport, allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 1024 },
    }, onRequest: exposure(deps),
  }, async (request, reply) => {
    const { account: owner, session } = await requireBrowserSessionActor(request, deps.identityUnitOfWork, { touch: true });
    requireAllowedOrigin(request, deps.allowedOrigins);
    requireCsrfHeader(request, session.csrfTokenHash, deps.csrfMatches ?? secretsMatch);
    await consume(deps, `/api/v1/me/agents/keys:principal:${owner.id}`);
    const body = request.body as { name?: unknown } | null;
    const commandId = request.headers['known-command-id'];
    if (!body || Object.keys(body).join('|') !== 'name' || typeof body.name !== 'string'
        || !body.name.trim() || body.name.length > 80
        || typeof commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(commandId)) {
      throw new ProductHttpError({ statusCode: 400, code: 'invalid_request', message: 'A key name and command ID are required.' });
    }
    const api = directoryApi(deps);
    if (!api.issueAgentKey) throw unavailable();
    try {
      const issued = await withTimeout(deps.timeoutMs, () => api.issueAgentKey!(owner.id, body.name as string, commandId));
      return reply.code(201).type('application/json; charset=utf-8').send(issued);
    } catch (error) {
      if (error instanceof AccountCredentialCommandError) {
        throw new ProductHttpError({ statusCode: productErrorStatus(error.code), code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get(LIST, {
    config: {
      ...productRouteMetadata('GET', LIST),
      productTransport: { ...transport, allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1 },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    const accountId = await account(request, deps, LIST);
    const api = directoryApi(deps);
    if (api.listAgents === undefined) throw unavailable();
    const body = await withTimeout(deps.timeoutMs, () => api.listAgents!(accountId));
    return reply.code(200).type('application/json; charset=utf-8').send(body);
  });

  app.get(AUDIT, {
    config: {
      ...productRouteMetadata('GET', AUDIT),
      productTransport: { ...transport, allowedQuery: ['limit'], acceptedMediaTypes: [], bodyLimitBytes: 1 },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    const accountId = await account(request, deps, AUDIT);
    const agentId = readAgentId(request);
    const limit = parseLimit(request.query as Readonly<Record<string, string>>);
    const api = directoryApi(deps);
    if (api.listAgentAudit === undefined) throw unavailable();
    try {
      const body = await withTimeout(deps.timeoutMs, () => api.listAgentAudit!(accountId, agentId, limit));
      if (body === undefined) throw notFound();
      return reply.code(200).type('application/json; charset=utf-8').send(body);
    } catch (error) {
      throw mapAgentError(error);
    }
  });

  app.post(REVOKE, {
    config: {
      ...productRouteMetadata('POST', REVOKE),
      productTransport: {
        ...transport,
        allowedQuery: [],
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
        rejectRequestBody: true,
      },
    },
    onRequest: exposure(deps),
  }, async (request, reply) => {
    const { account: sessionAccount, session } = await requireBrowserSessionActor(
      request, deps.identityUnitOfWork, { touch: true },
    );
    requireAllowedOrigin(request, deps.allowedOrigins);
    requireCsrfHeader(request, session.csrfTokenHash, deps.csrfMatches ?? secretsMatch);
    await consume(deps, `${REVOKE}:principal:${sessionAccount.id}`);
    const agentId = readAgentId(request);
    const api = directoryApi(deps);
    if (api.revokeAgent === undefined) throw unavailable();
    try {
      const body = await withTimeout(deps.timeoutMs, () => api.revokeAgent!(sessionAccount.id, agentId));
      if (body === undefined) throw notFound();
      return reply.code(200).type('application/json; charset=utf-8').send(body);
    } catch (error) {
      throw mapAgentError(error);
    }
  });
}

function directoryApi(deps: McpWriteApprovalRoutesDependencies): AgentDirectoryApi {
  return deps.api as AgentDirectoryApi;
}

function exposure(deps: McpWriteApprovalRoutesDependencies) {
  return async (request: FastifyRequest) => {
    if (!deps.enabled) throw notFound();
    rejectMixedCarriers(request);
    if (hasAuthorizationHeader(request)) throw authenticationRequired();
  };
}

async function account(
  request: FastifyRequest,
  deps: McpWriteApprovalRoutesDependencies,
  family: string,
): Promise<string> {
  const { account: sessionAccount } = await requireBrowserSessionActor(
    request, deps.identityUnitOfWork, { touch: false },
  );
  await consume(deps, `${family}:principal:${sessionAccount.id}`);
  return sessionAccount.id;
}

async function consume(deps: McpWriteApprovalRoutesDependencies, facts: string): Promise<void> {
  const outcome = await deps.rateLimiter.consume({ policy: 'approval', facts });
  if (outcome.kind === 'denied') throw rateLimited(outcome.decision.retryAfterSeconds);
  if (outcome.kind === 'failed') throw unavailable();
}

function readAgentId(request: FastifyRequest): string {
  const value = (request.params as { id?: string }).id;
  if (typeof value !== 'string' || !AGENT_ID.test(value)) throw invalidRequest();
  return value;
}

function parseLimit(query: Readonly<Record<string, string>>): number {
  const raw = query.limit;
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/u.test(raw) || Number(raw) > MAX_LIMIT) throw invalidRequest();
  return Number(raw);
}

async function withTimeout<Result>(timeoutMs: number, work: () => Promise<Result>): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unavailable()), timeoutMs);
    timer.unref?.();
  });
  observeBestEffort(timeout, 'the agent route timeout is observed when the handler wins');
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function mapAgentError(error: unknown): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (error instanceof TypeError) return invalidRequest();
  return new ProductHttpError({
    statusCode: productErrorStatus('internal_error'),
    code: 'internal_error',
    message: 'The agent request could not be completed.',
    recovery: 'same_request',
  });
}

function invalidRequest(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('invalid_request'),
    code: 'invalid_request',
    message: 'The agent request is invalid.',
  });
}

function notFound(): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('resource_not_found'),
    code: 'resource_not_found',
    message: 'The requested agent was not found.',
    recovery: 'none',
  });
}

function rateLimited(retryAfterSeconds: number): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('rate_limited'),
    code: 'rate_limited',
    message: 'Too many agent requests. Please try again later.',
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
    message: 'Agents are temporarily unavailable.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds: 1,
    headers: { 'Retry-After': '1' },
  });
}
