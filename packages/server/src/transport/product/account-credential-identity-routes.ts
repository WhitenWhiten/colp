import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { productRouteMetadata } from '../product-route-manifest.js';
import { ProductHttpError } from '../product-error.js';
import {
  hasAuthorizationHeader,
  hasCookieHeader,
  productBearerAuthorityOf,
} from '../product-actor.js';

const PATH = '/api/v1/me/credential-identity';

export function registerAccountCredentialIdentityRoutes(app: FastifyInstance, deps: {
  readonly enabled: boolean;
}): void {
  const actors = new WeakMap<FastifyRequest, Parameters<typeof sendIdentity>[1]>();
  const credentialAccess = async (request: FastifyRequest) => {
    const notFound = () => new ProductHttpError({ statusCode: 404, code: 'resource_not_found', message: 'The requested resource was not found.' });
    const authority = productBearerAuthorityOf(request);
    if (!deps.enabled || hasCookieHeader(request) || !authority || !hasAuthorizationHeader(request)) throw notFound();
    try { actors.set(request, await authority.inspect(request)); }
    catch (error) {
      if (error instanceof ProductHttpError && error.statusCode < 500) throw notFound();
      throw error;
    }
  };
  app.get(PATH, {
    exposeHeadRoute: false,
    config: {
      credentialAccess,
      ...productRouteMetadata('GET', PATH),
      productTransport: {
        allowedQuery: [],
        queryErrorCode: 'invalid_query',
        acceptedMediaTypes: [],
        bodyLimitBytes: 1,
        cacheControl: 'private-no-store',
      },
    },
  }, async (request, reply) => {
    if (!actors.has(request)) await credentialAccess(request);
    return sendIdentity(reply, actors.get(request)!);
  });
}

function sendIdentity(
  reply: FastifyReply,
  actor: {
    readonly account: { readonly id: string; readonly subjectId: string };
    readonly credentialId: string;
    readonly scopes: readonly string[];
    readonly expiresAt: Date;
  },
): FastifyReply {
  return reply.code(200).type('application/json; charset=utf-8').send({
    accountId: actor.account.id,
    subjectId: actor.account.subjectId,
    credentialId: actor.credentialId,
    scopes: [...actor.scopes],
    expiresAt: actor.expiresAt.toISOString(),
  });
}

