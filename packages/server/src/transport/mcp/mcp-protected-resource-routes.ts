/**
 * P4B-R04 MCP protected resource HTTP surface.
 *
 * Publishes only GET on the frozen OAuth protected resource metadata path.
 * The response is metadata-only and non-cacheable; OAuth verification
 * failures are converted to stable product errors with RFC 6750 challenges
 * and no internal/config details.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  McpOauthVerificationError,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH,
  PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
  createMcpReadProtectedResourceMetadata,
  mcpProtectedResourceMetadataUrl,
  type McpProtectedResourceMetadataSurface,
  type McpReadFeatureConfig,
  type McpReadFeatureConfigAssertOptions,
  type McpReadProtectedResourceMetadata,
} from '../../modules/mcp/index.js';
import { ProductHttpError } from '../product-error.js';

export function registerMcpProtectedResourceRoutes(
  app: FastifyInstance,
  config: McpReadFeatureConfig,
  options: McpReadFeatureConfigAssertOptions = {},
): void {
  const metadata = createMcpReadProtectedResourceMetadata(config, options);
  registerProtectedResourceMetadataGet(
    app,
    PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_PATH,
    metadata,
  );
  registerProtectedResourceMetadataGet(
    app,
    PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_RESOURCE_PATH,
    metadata,
  );
  if (config.compat) {
    registerProtectedResourceMetadataGet(
      app,
      PHASE4B_MCP_CONFIG_PROTECTED_RESOURCE_METADATA_COMPAT_RESOURCE_PATH,
      createMcpReadProtectedResourceMetadata(config, { ...options, surface: 'compat' }),
    );
  }
}

function registerProtectedResourceMetadataGet(
  app: FastifyInstance,
  path: string,
  metadata: McpReadProtectedResourceMetadata,
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
    return reply.send(metadata);
  });
}

/**
 * Stable OAuth challenge header for RFC 6750 verification failures.
 * `missing_scope` advertises the configured scope support set; every
 * other verifier failure is deliberately narrowed to `invalid_token`.
 * RFC 9728 `resource_metadata` is the path-inserted PRM URL for the
 * challenged surface, built from `config.origin` (never request Host).
 */
export function createMcpOauthChallengeWwwAuthenticate(
  reason: McpOauthVerificationError['reason'] | 'invalid_token',
  scopes: readonly string[],
  resourceMetadataUrl: string,
): string {
  const resourceMetadata = `resource_metadata="${resourceMetadataUrl}"`;
  if (reason === 'missing_scope') {
    return `Bearer error="insufficient_scope", scope="${scopes.join(' ')}", ${resourceMetadata}`;
  }
  return `Bearer error="invalid_token", ${resourceMetadata}`;
}

/**
 * Maps OAuth verification failures to the product HTTP boundary without
 * exposing internal reasons, tokens, issuer, client, audience, or other
 * config values. Unknown errors also fail closed as invalid token.
 */
export function mapMcpOauthChallengeToProductError(
  error: unknown,
  config: McpReadFeatureConfig,
  surface: McpProtectedResourceMetadataSurface = 'strict',
): ProductHttpError {
  const reason = error instanceof McpOauthVerificationError ? error.reason : undefined;
  const challenge = createMcpOauthChallengeWwwAuthenticate(
    reason === 'missing_scope' ? 'missing_scope' : 'invalid_token',
    config.oauth.scopes,
    mcpProtectedResourceMetadataUrl(config, surface),
  );
  if (reason === 'missing_scope') {
    return new ProductHttpError({
      statusCode: 403,
      code: 'insufficient_permission',
      message: 'The bearer credential does not grant the scopes required for this resource.',
      headers: {
        'Cache-Control': 'no-store',
        'Vary': 'Authorization, Origin',
        'WWW-Authenticate': challenge,
      },
    });
  }
  return new ProductHttpError({
    statusCode: 401,
    code: 'authentication_required',
    message: 'Authentication is required for this resource.',
    headers: {
      'Cache-Control': 'no-store',
      'Vary': 'Authorization, Origin',
      'WWW-Authenticate': challenge,
    },
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
