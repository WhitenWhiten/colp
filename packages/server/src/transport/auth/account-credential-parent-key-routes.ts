import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountCredentialCommandError,
  parseCreateChildBody,
  parseCredentialListQuery,
  parseOpaqueId,
  parseRevokeBody,
  parseRotateBody,
} from '../../modules/auth/index.js';
import { createAccountCredentialApplication } from '../../infrastructure/auth/account-credentials-postgres.js';
import type { AccountCredentialCursorCodec } from '../../modules/auth/index.js';
import type { PostgresAccountCredentialUnitOfWork } from '../../infrastructure/auth/account-credentials-postgres.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';
import { readKnownCommandId } from '../product/collection-route-helpers.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { requireAuthManifestEntry } from './auth-route-manifest.js';
import {
  admit,
  accountCredentialNotFound,
  mapAccountCredentialError,
  readOptionalIfMatch,
  sendCredential,
  sendIssued,
  sendRevoked,
  withTimeout,
} from '../product/account-credential-routes.js';

const COLLECTION = '/api/v1/auth/credential-children';
const ITEM = '/api/v1/auth/credential-children/:credentialId';
const ROTATE = '/api/v1/auth/credential-children/:credentialId/rotate';
const REVOKE = '/api/v1/auth/credential-children/:credentialId/revoke';

export interface AccountCredentialParentKeyRoutesDependencies {
  readonly enabled: boolean;
  readonly unitOfWork: PostgresAccountCredentialUnitOfWork;
  readonly cursors: AccountCredentialCursorCodec | null;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly timeoutMs: number;
}

export function registerAccountCredentialParentKeyRoutes(
  app: FastifyInstance,
  deps: AccountCredentialParentKeyRoutesDependencies,
): void {
  for (const [method, path] of [
    ['POST', COLLECTION],
    ['GET', COLLECTION],
    ['GET', ITEM],
    ['POST', ROTATE],
    ['POST', REVOKE],
  ] as const) {
    requireAuthManifestEntry(method, path);
  }
  const api = createAccountCredentialApplication({ unitOfWork: deps.unitOfWork, cursors: deps.cursors });
  const actors = new WeakMap<FastifyRequest, Awaited<ReturnType<typeof requireParentKey>>>();
  const credentialAccess = async (request: FastifyRequest) => {
    actors.set(request, await requireParentKey(request, deps));
  };

  app.post(COLLECTION, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('POST', COLLECTION),
      productTransport: { allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 32_768, cacheControl: 'private-no-store' },
    },
  }, wrap(async (request, reply) => {
    const parent = actors.get(request) ?? await requireParentKey(request, deps);
    const commandId = readKnownCommandId(request);
    const body = parseCreateChildBody(request.body);
    const outcome = await withTimeout(request, deps.timeoutMs, () =>
      api.createChild(parent.managerAccountId, parent.parent.id, commandId, body, 'parent-key'));
    return sendIssued(reply, outcome, 201);
  }));

  app.get(COLLECTION, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('GET', COLLECTION),
      productTransport: { allowedQuery: ['state', 'limit', 'cursor'], duplicateQueryErrorCode: 'invalid_query', queryErrorCode: 'invalid_query', acceptedMediaTypes: [], bodyLimitBytes: 1, cacheControl: 'private-no-store' },
    },
  }, wrap(async (request, reply) => {
    const parent = actors.get(request) ?? await requireParentKey(request, deps);
    await admit(deps.rateLimiter, `credentials:parent-list:${parent.parent.id}`);
    const filters = parseCredentialListQuery(request.query as Record<string, string>, { allowKind: false });
    const page = await api.listChildren(parent.parent, filters);
    return reply.code(200).type('application/json; charset=utf-8').send(page);
  }));

  app.get(ITEM, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('GET', ITEM),
      productTransport: { allowedQuery: [], acceptedMediaTypes: [], bodyLimitBytes: 1, cacheControl: 'private-no-store' },
    },
  }, wrap(async (request, reply) => {
    const parent = actors.get(request) ?? await requireParentKey(request, deps);
    const credentialId = parseOpaqueId((request.params as { credentialId?: string }).credentialId, 'credentialId');
    // AC-F008: the item detail previously had no admission control (the list
    // route does) — a parent key could page all children one by one.
    await admit(deps.rateLimiter, `credentials:parent-item:${parent.parent.id}`);
    const result = await api.getChild(parent.parent.id, credentialId);
    return sendCredential(reply, result.credential, result.etag);
  }));

  app.post(ROTATE, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('POST', ROTATE),
      productTransport: { allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 32_768, cacheControl: 'private-no-store' },
    },
  }, wrap(async (request, reply) => {
    const parent = actors.get(request) ?? await requireParentKey(request, deps);
    const commandId = readKnownCommandId(request);
    const credentialId = parseOpaqueId((request.params as { credentialId?: string }).credentialId, 'credentialId');
    const ifMatch = readOptionalIfMatch(request);
    const body = parseRotateBody(request.body);
    const outcome = await withTimeout(request, deps.timeoutMs, () =>
      api.rotate(parent.managerAccountId, credentialId, commandId, ifMatch, body, parent.parent.id));
    return sendIssued(reply, outcome, 200);
  }));

  app.post(REVOKE, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('POST', REVOKE),
      productTransport: { allowedQuery: [], acceptedMediaTypes: ['application/json'], bodyLimitBytes: 32_768, cacheControl: 'private-no-store' },
    },
  }, wrap(async (request, reply) => {
    const parent = actors.get(request) ?? await requireParentKey(request, deps);
    const commandId = readKnownCommandId(request);
    const credentialId = parseOpaqueId((request.params as { credentialId?: string }).credentialId, 'credentialId');
    const ifMatch = readOptionalIfMatch(request);
    const body = parseRevokeBody(request.body);
    // AC-F008: revoke previously had NO throttling at all (rotate at least
    // consumed the issuance limiter) — a parent key could churn revocations.
    await admit(deps.rateLimiter, `credentials:parent-revoke:${parent.parent.id}`);
    const outcome = await withTimeout(request, deps.timeoutMs, () =>
      api.revoke(parent.managerAccountId, credentialId, commandId, ifMatch, body, parent.parent.id));
    return sendRevoked(reply, outcome);
  }));
}

export async function requireParentKey(
  request: FastifyRequest,
  deps: AccountCredentialParentKeyRoutesDependencies,
) {
  if (!deps.enabled || !deps.cursors) throw accountCredentialNotFound();
  // Charge every bearer attempt before looking up the secret.  Charging only
  // after successful authentication lets an attacker spray invalid parent-key
  // guesses indefinitely (and rotate among the five child-key endpoints)
  // without consuming any budget.  Fastify's request.ip is already resolved
  // through the configured trusted-ingress proxy policy.
  const clientIp = typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : 'unknown';
  await admit(deps.rateLimiter, `credentials:parent-auth:${clientIp}`);
  if (request.headers.cookie !== undefined) throw accountCredentialNotFound();
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw accountCredentialNotFound();
  }
  const secret = authorization.slice('Bearer '.length);
  const api = createAccountCredentialApplication({ unitOfWork: deps.unitOfWork, cursors: deps.cursors });
  try {
    return await api.authenticateParent(secret);
  } catch (error) {
    if (error instanceof AccountCredentialCommandError && error.code === 'invalid_request') {
      throw accountCredentialNotFound();
    }
    throw error;
  }
}

function wrap(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      throw mapAccountCredentialError(error);
    }
  };
}
