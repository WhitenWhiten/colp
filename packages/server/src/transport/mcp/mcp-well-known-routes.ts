/**
 * MCP2-02 anonymous GET `/.well-known/mcp` discovery surface.
 *
 * Same registration pattern as `mcp-protected-resource-routes.ts`: metadata
 * only, no query, no HEAD, values stamped from frozen MCP read config.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH,
  createMcpWellKnownDiscoveryDocument,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
  type McpWellKnownDiscoveryDocument,
} from '../../modules/mcp/index.js';

export function registerMcpWellKnownDiscoveryRoutes(
  app: FastifyInstance,
  config: McpReadFeatureConfig,
  options: McpReadFeatureConfigAssertOptions = {},
): void {
  const document = createMcpWellKnownDiscoveryDocument(config, options);
  registerWellKnownDiscoveryGet(app, PHASE4B_MCP_WELL_KNOWN_DISCOVERY_PATH, document);
}

function registerWellKnownDiscoveryGet(
  app: FastifyInstance,
  path: string,
  document: McpWellKnownDiscoveryDocument,
): void {
  app.get(path, {
    exposeHeadRoute: false,
    config: {
      productTransport: {
        allowedQuery: [],
        cacheControl: 'no-store',
      },
    },
  }, async (_request, reply) => {
    mergeReplyVary(reply, ['Authorization', 'Origin']);
    return reply.type('application/json').send(document);
  });
}

function mergeReplyVary(reply: FastifyReply, additions: readonly string[]): void {
  const existing = reply.getHeader('Vary');
  const values = typeof existing === 'string'
    ? existing.split(',').map((value) => value.trim()).filter(Boolean)
    : Array.isArray(existing)
      ? existing.map((value) => String(value))
      : [];
  reply.header('Vary', [...new Set([...values, ...additions])].join(', '));
}
