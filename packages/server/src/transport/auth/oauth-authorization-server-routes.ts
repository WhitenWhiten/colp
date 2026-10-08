/**
 * T-05 / ADR D6: RFC 8414 issuer-inserted authorization-server metadata.
 *
 * Better Auth serves this document from `auth.handler`, but the path sits
 * outside the `/api/v1/auth` allowlist. Transport forwards GET to the same
 * handler instance. Mount condition is the issuer flag, not MCP Read.
 * mcp() protected-resource metadata is never forwarded from here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

export function registerOauthAuthorizationServerMetadataRoute(
  app: FastifyInstance,
  deps: {
    readonly basePath: string;
    readonly handle: (request: Request) => Promise<Response>;
  },
): void {
  const path = `/.well-known/oauth-authorization-server${deps.basePath}`;
  app.get(path, {
    exposeHeadRoute: false,
    config: {
      productTransport: {
        allowedQuery: [],
        cacheControl: 'no-store',
      },
    },
  }, async (request, reply) => {
    const response = await deps.handle(wellKnownFetchRequest(request));
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      const name = key.toLowerCase();
      if (name === 'set-cookie' || name === 'cache-control') return;
      reply.header(key, value);
    });
    reply.header('Cache-Control', 'no-store');
    const text = await response.text();
    return reply.send(text.length > 0 ? text : undefined);
  });
}

/** Build a Fetch Request from path + method only; Host/Origin never become the URL. */
function wellKnownFetchRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, 'http://well-known.invalid');
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.append(key, value);
    }
  }
  return new Request(url, { method: request.method, headers });
}
