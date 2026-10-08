import type { IdentityUnitOfWork } from '../../modules/identity/index.js';
import { registerAccountCredentialGrantRoutes } from './account-credential-grant-routes.js';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../bootstrap/config.js';
import { registerAccountCredentialParentKeyRoutes } from '../auth/account-credential-parent-key-routes.js';
import { registerAccountCredentialTokenRoutes } from '../auth/account-credential-token-routes.js';
import { registerAccountCredentialJwks } from '../auth/account-credential-jwks.js';
import { registerAccountCredentialIdentityRoutes } from './account-credential-identity-routes.js';
import {
  type AccountCredentialRouteDependencies,
} from './account-credential-routes.js';
import type { CredentialGrantCursorCodec } from '../../modules/auth/index.js';
import { composeAccountKeyRuntime } from '../../modules/auth/index.js';
import { createProductBearerAuthority } from '../product-actor.js';
import type { ProductAdmissionRateLimiter } from '../http-security.js';

export interface AccountCredentialSurfaceDependencies extends AccountCredentialRouteDependencies {
  readonly config: AppConfig;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly credentialTokenRateLimiter: ProductAdmissionRateLimiter | null;
  readonly clientTokenRateLimiter: ProductAdmissionRateLimiter | null;
  readonly grantCursors: CredentialGrantCursorCodec | null;
}

export function registerAccountCredentialSurfaces(
  app: FastifyInstance,
  deps: AccountCredentialSurfaceDependencies,
): void {
  const runtime = composeAccountKeyRuntime({
    productOrigin: deps.config.productOrigin,
    betterAuthBasePath: deps.config.betterAuth.basePath,
    ...(deps.config.mcp?.oauth.issuer ? { mcpIssuer: deps.config.mcp.oauth.issuer } : {}),
    ...(deps.config.mcp?.oauth.audience ? { mcpStrictAudience: deps.config.mcp.oauth.audience } : {}),
    ...(deps.config.mcp?.oauth.scopes ? { mcpScopes: deps.config.mcp.oauth.scopes } : {}),
    privateJwk: deps.config.accountCredentials.es256PrivateJwk,
    previousPublicJwks: deps.config.accountCredentials.es256PreviousPublicJwks,
  });
  registerAccountCredentialJwks(app, {
    enabled: deps.enabled,
    oauthIssuerEnabled: deps.config.betterAuth.oauthIssuerEnabled,
    publicKeys: runtime.publicKeys,
  });
  if (deps.enabled && runtime.publicKeys.length > 0) {
    app.decorate('productBearerAuthority', createProductBearerAuthority({
      issuer: runtime.issuer,
      productOrigin: runtime.productOrigin,
      publicKeys: runtime.publicKeys,
      clockSkewSeconds: deps.config.accountCredentials.clockSkewSeconds,
      unitOfWork: deps.unitOfWork,
      identityUnitOfWork: deps.identityUnitOfWork,
    }));
  }
  registerAccountCredentialGrantRoutes(app, deps);
  registerAccountCredentialParentKeyRoutes(app, {
    enabled: deps.enabled,
    unitOfWork: deps.unitOfWork,
    cursors: deps.cursors,
    rateLimiter: deps.rateLimiter,
    timeoutMs: deps.timeoutMs,
  });
  registerAccountCredentialTokenRoutes(app, {
    enabled: deps.enabled,
    unitOfWork: deps.unitOfWork,
    privateJwk: deps.config.accountCredentials.es256PrivateJwk,
    issuer: runtime.issuer,
    audienceConfig: runtime.audienceConfig,
    supportedScopes: runtime.supportedScopes,
    credentialRateLimiter: deps.credentialTokenRateLimiter,
    clientRateLimiter: deps.clientTokenRateLimiter,
    ttlSeconds: deps.config.accountCredentials.tokenTtlSeconds,
  });
  registerAccountCredentialIdentityRoutes(app, { enabled: deps.enabled });
}
