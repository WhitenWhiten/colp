/**
 * T-03 MCP compatibility admission adapter.
 *
 * POST `/collections/-/mcp-compat` enters in plan §5.1 order through this
 * module. SDK dispatch is T-04 (`mcp-compat-handler.ts`) after a successful
 * admission. GET/DELETE stay at the method gate in the route file and never
 * call this adapter.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthInfo } from '@modelcontextprotocol/server';
import {
  createAnonymousPublicBinding,
  type McpAuthorizationBinding,
} from '@know-n/colp/mcp';
import {
  MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY,
  McpOauthVerificationError,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS,
  MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE,
  createMcpApplicationContext,
  requiredScopesForMcpReadOperation,
  type McpApplicationContext,
  type McpOauthVerifier,
  type McpReadFeatureConfig,
  type McpCompatOutcome,
  type McpCompatRejectCategory,
} from '../../modules/mcp/index.js';
import {
  createMemoryMcpRateLimiter,
  type McpRateLimiter,
} from '../../infrastructure/rate-limit/index.js';
import { ProductHttpError, productErrorEnvelope } from '../product-error.js';
import { mapMcpOauthChallengeToProductError } from './mcp-protected-resource-routes.js';
import { attachMcpCompatAuthInfo, mapMcpCompatAuthInfo } from './mcp-compat-authinfo.js';
import {
  admitMcpHost,
  applyMcpSecurityHeaders,
  createConnectionBudget,
  headerBudgetViolation,
  mcpRateLimitSubject,
  readMcpHeaderPairs,
  singleMcpHeader,
  type McpConnectionBudget,
  type McpTrustedHostAuthority,
} from './mcp-shared-admission.js';

export class McpAdmissionHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpAdmissionHttpError';
  }
}

/** Fail-closed MCP-Protocol-Version gate; thrown before OAuth and SDK factory. */
export class McpCompatProtocolVersionAdmissionError extends Error {
  readonly statusCode = MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS;
  constructor() {
    super(MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE);
    this.name = 'McpCompatProtocolVersionAdmissionError';
  }
}

export interface McpCompatVerifiedAdmission {
  readonly applicationContext: McpApplicationContext;
  readonly authInfo: AuthInfo;
  readonly allowedOrigin: string | undefined;
  readonly release: () => void;
}

export interface McpCompatAdmissionDependencies {
  readonly oauthVerifier?: McpOauthVerifier;
  readonly securityEpoch?: () => string | Promise<string>;
  readonly requestRateLimiter?: McpRateLimiter;
  readonly requestConnectionBudget?: McpConnectionBudget;
  readonly compatOnAdmitted?: (
    admission: McpCompatVerifiedAdmission,
    request: FastifyRequest,
  ) => void;
}

function readBodyMethod(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const method = (body as { readonly method?: unknown }).method;
  return typeof method === 'string' ? method : 'unknown';
}

function readToolName(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const params = (body as { readonly params?: unknown }).params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const name = (params as { readonly name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

function jsonRpcIdFromBody(body: unknown): string | number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as { readonly id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Explicit MCP-Protocol-Version admission from raw header pairs.
 * `initialize` may omit the header; every other POST must carry exactly one
 * `2025-11-25`. Duplicates are detected on raw pairs, not `Headers.get()`.
 */
export function admitMcpCompatProtocolVersion(
  pairs: ReadonlyArray<readonly [string, string]>,
  body: unknown,
): void {
  const values = pairs
    .filter(([name]) => name.toLowerCase() === 'mcp-protocol-version')
    .map(([, value]) => value);
  const joined = singleMcpHeader(pairs, 'mcp-protocol-version');
  const exact = values.length === 1 && joined === MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
  if (exact) return;
  if (readBodyMethod(body) === 'initialize' && values.length === 0) return;
  throw new McpCompatProtocolVersionAdmissionError();
}

export function sendMcpCompatProtocolVersionRejected(
  reply: FastifyReply,
  body: unknown,
): unknown {
  return reply
    .code(MCP_COMPAT_UNSUPPORTED_PROTOCOL_HTTP_STATUS)
    .type('application/json; charset=utf-8')
    .send({
      jsonrpc: '2.0',
      id: jsonRpcIdFromBody(body),
      error: {
        code: MCP_COMPAT_UNSUPPORTED_PROTOCOL_RPC_CODE,
        message: MCP_COMPAT_PROTOCOL_VERSION_REJECT_MESSAGE,
        data: {
          supported: [...MCP_COMPAT_PROTOCOL_VERSIONS],
        },
      },
    });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function resolveAnonymousSecurityEpoch(
  dependencies: McpCompatAdmissionDependencies,
): Promise<string> {
  const epoch = dependencies.securityEpoch === undefined
    ? 'public'
    : await dependencies.securityEpoch();
  if (typeof epoch !== 'string' || epoch.trim() === '') {
    throw new TypeError('MCP anonymous security epoch must be a non-empty string');
  }
  return epoch;
}

async function resolveAuthorization(
  authorization: string | undefined,
  config: McpReadFeatureConfig,
  dependencies: McpCompatAdmissionDependencies,
  signal: AbortSignal,
  requiredScopes: readonly string[],
): Promise<{
  readonly binding: McpAuthorizationBinding;
  readonly scope: readonly string[];
  readonly accountSubjectId?: string;
  readonly expiresAt?: Date;
}> {
  if (authorization === undefined) {
    const securityEpoch = await withAbort(resolveAnonymousSecurityEpoch(dependencies), signal);
    return {
      binding: createAnonymousPublicBinding({
        resourceAudience: config.oauth.audience,
        securityEpoch,
      }),
      scope: [],
    };
  }
  if (dependencies.oauthVerifier === undefined) {
    throw new McpAdmissionHttpError(
      503,
      'mcp_oauth_verifier_unconfigured',
      'MCP OAuth verification is not configured.',
    );
  }
  const result = await withAbort(
    dependencies.oauthVerifier.verify({ authorization, requiredScopes }),
    signal,
  );
  return {
    binding: result.binding,
    scope: [...(result.scopes ?? [])],
    accountSubjectId: result.accountSubjectId,
    expiresAt: result.expiresAt,
  };
}

function dropAuthorizationKeys(headers: Record<string, unknown> | undefined): void {
  if (headers === undefined) return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') delete headers[key];
  }
}

/**
 * After the verifier has observed Authorization, drop it from the Fastify and
 * Node header maps so `toWebRequest(request.raw)` cannot copy the bearer onto
 * the SDK Request. Node `rawHeaders` may still hold original ingress bytes and
 * is not claimed to be physically erased.
 */
export function dropAuthorizationHeader(request: FastifyRequest): void {
  dropAuthorizationKeys(request.raw.headers as Record<string, unknown>);
  dropAuthorizationKeys(request.raw.headersDistinct as Record<string, unknown> | undefined);
  dropAuthorizationKeys(request.headers as Record<string, unknown>);
}

function buildApplicationBudgets(config: McpReadFeatureConfig) {
  return {
    maxBytes: config.budgets.output.maxBytes,
    maxDepth: config.budgets.output.maxDepth,
    maxNodes: config.budgets.output.maxItems,
    maxOperations: config.budgets.output.maxItems,
    maxListItems: config.budgets.output.maxItems,
    maxReadContents: config.budgets.output.maxItems,
    maxTextBytes: config.budgets.output.maxBytes,
    maxCursorLength: 1_024,
  };
}

export function defaultMcpCompatRateLimiter(
  config: McpReadFeatureConfig,
  dependencies: McpCompatAdmissionDependencies,
): McpRateLimiter {
  return dependencies.requestRateLimiter
    ?? createMemoryMcpRateLimiter({ request: config.requestRateLimit });
}

export function defaultMcpCompatConnectionBudget(
  config: McpReadFeatureConfig,
  dependencies: McpCompatAdmissionDependencies,
): McpConnectionBudget {
  return dependencies.requestConnectionBudget
    ?? createConnectionBudget(
      config.budgets.request.maxConcurrent,
      config.budgets.request.maxQueue,
    );
}

/**
 * Run plan §5.1 steps 1–5 for a compat POST. Throws on reject; the caller
 * maps errors onto the same HTTP classes as strict. On success the raw
 * Authorization value has been dropped and AuthInfo.token is the sentinel.
 */
export async function admitMcpCompatPost(
  request: FastifyRequest,
  reply: FastifyReply,
  config: McpReadFeatureConfig,
  dependencies: McpCompatAdmissionDependencies,
  connectionBudget: McpConnectionBudget,
  requestRateLimiter: McpRateLimiter,
  signal: AbortSignal,
  trustedHost: McpTrustedHostAuthority,
): Promise<McpCompatVerifiedAdmission> {
  const requestId = String(request.id);
  const pairs = readMcpHeaderPairs(request);
  const violation = headerBudgetViolation(pairs, config.budgets.request);
  if (violation !== undefined) {
    applyMcpSecurityHeaders(reply, requestId, undefined);
    throw new McpAdmissionHttpError(431, violation.code, 'MCP header budget exceeded.');
  }

  admitMcpHost(pairs, trustedHost);

  admitMcpCompatProtocolVersion(pairs, request.body);

  const origin = singleMcpHeader(pairs, 'origin');
  const allowedOrigin = origin !== undefined && config.allowedOrigins.includes(origin)
    ? origin
    : undefined;
  if (origin !== undefined && allowedOrigin === undefined) {
    throw new ProductHttpError({
      statusCode: 403,
      code: 'csrf_failed',
      message: 'The request failed CSRF or Origin validation.',
      recovery: 'user_action',
      headers: {
        'Cache-Control': 'no-store',
        'Vary': 'Authorization, Origin',
      },
    });
  }

  const acquired = await connectionBudget.acquire(signal);
  if (!acquired) {
    if (!signal.aborted) {
      throw new McpAdmissionHttpError(
        503,
        'mcp_connection_budget_exhausted',
        'MCP connection budget exhausted.',
      );
    }
    throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    connectionBudget.release();
  };

  try {
    let authorization = singleMcpHeader(pairs, 'authorization');
    const bodyMethod = readBodyMethod(request.body);
    const requiredScopes = requiredScopesForMcpReadOperation({
      method: bodyMethod,
      ...(bodyMethod === 'tools/call' ? { toolName: readToolName(request.body) } : {}),
    });
    const trusted = await resolveAuthorization(
      authorization,
      config,
      dependencies,
      signal,
      requiredScopes,
    );
    authorization = undefined;
    dropAuthorizationHeader(request);

    const rateOutcome = await requestRateLimiter.consume(
      mcpRateLimitSubject(request, trusted.binding),
    );
    if (rateOutcome.kind === 'denied') {
      reply.header('Retry-After', String(rateOutcome.decision.retryAfterSeconds));
      throw new McpAdmissionHttpError(429, 'mcp_rate_limited', 'Too many MCP requests.');
    }
    if (rateOutcome.kind === 'failed') {
      throw new McpAdmissionHttpError(
        503,
        'mcp_rate_limit_unavailable',
        'Rate limiting service is temporarily unavailable.',
      );
    }

    const principal = trusted.binding.kind === 'anonymous'
      ? Object.freeze({
        kind: 'anonymous' as const,
        principalId: 'public' as const,
        resourceAudience: trusted.binding.resourceAudience,
        securityEpoch: trusted.binding.securityEpoch,
      })
      : Object.freeze({
        kind: 'authenticated' as const,
        principalId: trusted.binding.principalId,
        clientId: trusted.binding.clientId,
        credentialBindingId: trusted.binding.credentialBindingId,
        resourceAudience: trusted.binding.resourceAudience,
        securityEpoch: trusted.binding.securityEpoch,
      });
    const applicationContext = createMcpApplicationContext({
      principal,
      scopes: trusted.scope,
      abortSignal: signal,
      budgets: buildApplicationBudgets(config),
      correlationId: requestId,
      authorization: trusted.accountSubjectId === undefined
        ? { requestId }
        : {
          requestId,
          [MCP_ACCOUNT_SUBJECT_ID_AUTHORIZATION_KEY]: trusted.accountSubjectId,
        },
    });
    const authInfo = mapMcpCompatAuthInfo({
      binding: trusted.binding,
      scopes: trusted.scope,
      ...(trusted.expiresAt === undefined ? {} : { expiresAt: trusted.expiresAt }),
      resourceAudience: config.oauth.audience,
    });
    attachMcpCompatAuthInfo(request.raw, authInfo);
    const admission: McpCompatVerifiedAdmission = Object.freeze({
      applicationContext,
      authInfo,
      allowedOrigin,
      release,
    });
    dependencies.compatOnAdmitted?.(admission, request);
    return admission;
  } catch (error) {
    release();
    throw error;
  }
}

export function classifyMcpCompatAdmissionFault(error: unknown): {
  readonly outcome: McpCompatOutcome;
  readonly rejectCategory?: McpCompatRejectCategory;
} {
  if (isCompatAbortError(error)) {
    return { outcome: 'cancelled' };
  }
  if (error instanceof McpCompatProtocolVersionAdmissionError) {
    return { outcome: 'rejected', rejectCategory: 'unsupported' };
  }
  if (error instanceof McpAdmissionHttpError) {
    if (error.code === 'mcp_rate_limited') {
      return { outcome: 'rate_limited', rejectCategory: 'rate_limited' };
    }
    if (error.code === 'mcp_connection_budget_exhausted') {
      return { outcome: 'rate_limited', rejectCategory: 'rate_limited' };
    }
    if (error.code === 'mcp_rate_limit_unavailable' || error.code === 'mcp_oauth_verifier_unconfigured') {
      return { outcome: 'dependency_error' };
    }
    if (error.code === 'mcp_compat_draining') {
      return { outcome: 'cancelled' };
    }
    return { outcome: 'rejected', rejectCategory: 'admission' };
  }
  if (error instanceof McpOauthVerificationError) {
    if (error.reason === 'missing_scope') {
      return { outcome: 'forbidden', rejectCategory: 'auth' };
    }
    return { outcome: 'auth_required', rejectCategory: 'auth' };
  }
  if (error instanceof ProductHttpError) {
    if (error.statusCode === 401) {
      return { outcome: 'auth_required', rejectCategory: 'auth' };
    }
    if (error.statusCode === 403) {
      return { outcome: 'forbidden', rejectCategory: 'admission' };
    }
    if (error.statusCode === 429) {
      return { outcome: 'rate_limited', rejectCategory: 'rate_limited' };
    }
    return { outcome: 'rejected', rejectCategory: 'admission' };
  }
  return { outcome: 'rejected', rejectCategory: 'admission' };
}

function isCompatAbortError(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return true;
  }
  return error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message === 'aborted');
}

export function sendMcpAdmissionError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  config: McpReadFeatureConfig,
): unknown {
  const requestId = String(request.id);
  if (error instanceof McpCompatProtocolVersionAdmissionError) {
    applyMcpSecurityHeaders(reply, requestId, undefined);
    return sendMcpCompatProtocolVersionRejected(reply, request.body);
  }
  if (error instanceof McpAdmissionHttpError) {
    applyMcpSecurityHeaders(reply, requestId, undefined);
    return reply.code(error.statusCode).type('application/json; charset=utf-8').send({
      error: error.code,
    });
  }
  if (error instanceof McpOauthVerificationError) {
    const productError = mapMcpOauthChallengeToProductError(error, config, 'compat');
    for (const [name, value] of Object.entries(productError.headers)) {
      reply.header(name, value);
    }
    return reply
      .code(productError.statusCode)
      .type('application/json; charset=utf-8')
      .send(productErrorEnvelope(requestId, productError));
  }
  if (error instanceof ProductHttpError) {
    for (const [name, value] of Object.entries(error.headers)) {
      reply.header(name, value);
    }
    return reply
      .code(error.statusCode)
      .type('application/json; charset=utf-8')
      .send(productErrorEnvelope(requestId, error));
  }
  throw error;
}
