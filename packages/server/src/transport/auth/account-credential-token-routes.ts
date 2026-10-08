import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountKeyOAuthError,
  exchangeAccountKey,
  authenticateChildKey,
  AccountCredentialCommandError,
  invalidGrant,
  featureDisabled,
  ACCOUNT_CREDENTIAL_SECRET_PATTERN,
  hashAccountCredentialSecret,
  invalidRequest,
  temporarilyUnavailable,
  tokenRateLimited,
  type AccountKeyAudienceConfig,
  type AccountKeyEs256PrivateJwk,
} from '../../modules/auth/index.js';
import type { PostgresAccountCredentialUnitOfWork } from '../../infrastructure/auth/account-credentials-postgres.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { consumeProductAdmission } from '../http-security.js';
import { ProductHttpError } from '../product-error.js';

import { productRouteMetadata } from '../product-route-manifest.js';
import { requireAuthManifestEntry } from './auth-route-manifest.js';

const PATH = '/api/v1/auth/key-token';

export interface AccountCredentialTokenRoutesDependencies {
  readonly enabled: boolean;
  readonly unitOfWork: PostgresAccountCredentialUnitOfWork;
  readonly privateJwk: AccountKeyEs256PrivateJwk | null;
  readonly issuer: string;
  readonly audienceConfig: AccountKeyAudienceConfig;
  readonly supportedScopes: readonly string[];
  readonly credentialRateLimiter: ProductAdmissionRateLimiter | null;
  readonly clientRateLimiter: ProductAdmissionRateLimiter | null;
  readonly ttlSeconds: number;
}

export function registerAccountCredentialTokenRoutes(
  app: FastifyInstance,
  deps: AccountCredentialTokenRoutesDependencies,
): void {
  requireAuthManifestEntry('POST', PATH);
  const transport = {
    allowedQuery: [] as const,
    queryErrorCode: 'invalid_request' as const,
    duplicateQueryErrorCode: 'invalid_request' as const,
    acceptedMediaTypes: ['application/json'] as const,
    bodyLimitBytes: 4_096,
    cacheControl: 'no-store' as const,
  };
  app.post(PATH, {
    exposeHeadRoute: false,
    errorHandler: tokenErrorHandler,
    config: { ...productRouteMetadata('POST', PATH), productTransport: transport },
  }, async (request, reply) => {
    try {
      await exchange(request, reply, deps);
    } catch (error) {
      sendAccountKeyOAuthError(reply, mapTokenRouteError(error));
    }
  });
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'] as const) {
    app.route({
      method,
      url: PATH,
      exposeHeadRoute: false,
      errorHandler: tokenErrorHandler,
      config: { productTransport: { allowedQuery: [], cacheControl: 'no-store' } },
      handler: (_request, reply) => {
        sendAccountKeyOAuthError(reply, new AccountKeyOAuthError(
          405, 'invalid_request', 'The request is invalid.',
        ));
      },
    });
  }
}

function tokenErrorHandler(
  error: Error,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  sendAccountKeyOAuthError(reply, mapTokenRouteError(error));
}

async function exchange(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AccountCredentialTokenRoutesDependencies,
): Promise<FastifyReply> {
  if (request.headers.cookie !== undefined || request.headers.authorization !== undefined) {
    throw invalidRequest('Cookie and Authorization are forbidden on the token endpoint.');
  }
  if (!deps.enabled || !deps.privateJwk) throw featureDisabled();
  // Charge the client before any database-backed authentication. Invalid keys
  // must not get an unlimited lookup budget; limiter failures remain fail-closed.
  await consumeClientRate(request, deps);
  const body = request.body;
  const parsedCredential = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { credential?: unknown }).credential
    : undefined;
  if (typeof parsedCredential !== 'string' || !ACCOUNT_CREDENTIAL_SECRET_PATTERN.test(parsedCredential)) {
    throw invalidRequest('The credential is invalid.');
  }
  try {
    await deps.unitOfWork.execute((ports) => authenticateChildKey(ports, parsedCredential));
  } catch (error) {
    if (error instanceof AccountCredentialCommandError) throw invalidGrant();
    throw error;
  }
  // Keep credential-specific quotas behind authentication: random submitted
  // secrets must not create an unbounded collection of credential limiter keys.
  await consumeCredentialRate(parsedCredential, deps);
  const issued = await deps.unitOfWork.execute((ports) => exchangeAccountKey(ports, {
    body,
    supportedScopes: deps.supportedScopes,
    audienceConfig: deps.audienceConfig,
    privateJwk: deps.privateJwk!,
    issuer: deps.issuer,
    ttlSeconds: deps.ttlSeconds,
  }));
  return reply.code(200).type('application/json; charset=utf-8').send(issued);
}

async function consumeClientRate(
  request: FastifyRequest,
  deps: AccountCredentialTokenRoutesDependencies,
): Promise<void> {
  if (!deps.clientRateLimiter) return;
  const ip = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  const decision = await consumeProductAdmission(deps.clientRateLimiter, `automation-token-client:${ip}`);
  if (decision.kind === 'failed') throw temporarilyUnavailable();
  if (decision.kind === 'denied') throw tokenRateLimited(decision.retryAfterSeconds);
}

async function consumeCredentialRate(
  credential: string,
  deps: AccountCredentialTokenRoutesDependencies,
): Promise<void> {
  if (!deps.credentialRateLimiter) return;
  const decision = await consumeProductAdmission(
    deps.credentialRateLimiter,
    `automation-token-credential:${hashAccountCredentialSecret(credential)}`,
  );
  if (decision.kind === 'failed') throw temporarilyUnavailable();
  if (decision.kind === 'denied') throw tokenRateLimited(decision.retryAfterSeconds);
}

export function isAccountKeyTokenPath(url: string): boolean {
  return (url.split('?', 1)[0] ?? url) === PATH;
}

export function mapTokenRouteError(error: unknown): AccountKeyOAuthError {
  if (error instanceof AccountKeyOAuthError) return error;
  if (error instanceof ProductHttpError) {
    if (error.statusCode === 413 || error.statusCode === 415 || error.statusCode === 400) {
      return invalidRequest(error.message.slice(0, 256));
    }
    if (error.statusCode === 429) {
      return tokenRateLimited(error.retryAfterSeconds ?? 1);
    }
    if (error.statusCode >= 500) return temporarilyUnavailable();
    return invalidRequest('The request is invalid.');
  }
  return temporarilyUnavailable();
}

export function sendAccountKeyOAuthError(
  reply: FastifyReply,
  error: AccountKeyOAuthError,
): FastifyReply {
  if (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
    return reply.code(404).header('Cache-Control', 'no-store')
      .send({ code: 'resource_not_found', message: 'The requested resource was not found.' });
  }
  if (error.retryAfterSeconds !== null) {
    reply.header('Retry-After', String(error.retryAfterSeconds));
  }
  return reply
    .code(error.statusCode)
    .header('Cache-Control', 'no-store')
    .type('application/json; charset=utf-8')
    .send(error.toJSON());
}
