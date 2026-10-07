/**
 * LEGACY OIDC/Logto boundary — the single controlled re-export exit for the
 * deprecated OIDC/Logto implementation.
 *
 * Status: legacy quarantine (Task F1,
 * docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12, and G1 ADR §11 legacy isolation rules). Source retention is NOT runtime
 * enablement: the legacy provider/transaction/JWKS/test-provider code stays in
 * the tree for audit and the legacy migration window, but new code must reach
 * it only through this file. The Better Auth runtime (Task A lane), business
 * account mapping (Task A2), Better Auth config and the frontend auth client
 * must not import the old OIDC provider directly — the import boundary script
 * (`scripts/check-import-boundaries.mjs`) rejects any module-layer or
 * unregistered consumer.
 *
 * Ownership: Better Auth migration lane F. Composition/route changes are owned
 * by Task F2; this boundary only quarantines the export surface.
 *
 * Legacy inventory (all still runtime-wired until F2, all deprecated):
 * - config: `OidcConfig` in `src/bootstrap/config.ts` (A1-owned file)
 * - discovery: `verifyOidcDiscoveryMetadata` (transport/auth/oidc-provider.ts)
 * - provider: `createOidcProvider` + `OidcProviderPort` (transport/auth/oidc-provider.ts)
 * - browser routes: `/api/v1/auth/oidc/start` + `/api/v1/auth/oidc/callback`
 *   branches in `src/transport/auth/browser-auth-routes.ts`
 * - test route: `/__test__/oidc/authorize` registration in `src/transport/app.ts`
 * - transaction: `createOidcLoginTransaction` / `consumeOidcLoginTransaction`
 *   (`src/modules/identity/application/oidc-login-transaction.ts`) and
 *   `createPostgresOidcLoginTransactionRepository`
 *   (`src/infrastructure/identity/repositories.ts`)
 * - JWKS: `createCachingJwksClient` (`src/infrastructure/identity/jwks-client.ts`)
 * - test provider: `createTestOidcProvider` / `mintTestAuthorizationCode*`
 *   (NODE_ENV=test only — enforced inside oidc-provider.ts)
 * - frontend callers: `startOidcLogin` in Known-Frontend `productClient.ts`
 *
 * @deprecated Legacy OIDC/Logto auth surface, superseded by Better Auth
 *   (better-auth-migration-development-plan.md). Retained as archive — keep
 *   behavior unchanged.
 */
export {
  createOidcProvider,
  createTestOidcProvider,
  mapIdTokenVerificationError,
  mapTokenEndpointFailure,
  mintTestAuthorizationCode,
  mintTestAuthorizationCodeFromChallenge,
  pkceS256Challenge,
  verifyOidcDiscoveryMetadata,
  OidcExchangeError,
  type CreateOidcProviderOptions,
  type OidcProviderPort,
  type OidcTokenClaims,
  type OidcTokenExchangeResult,
  type VerifyOidcDiscoveryOptions,
} from '../../transport/auth/oidc-provider.js';

export {
  createCachingJwksClient,
  createPostgresOidcLoginTransactionRepository,
  type CachingJwksClientOptions,
} from '../identity/index.js';

export {
  consumeOidcLoginTransaction,
  createOidcLoginTransaction,
  ensureAccountFromOidcIdentity,
  type CreateOidcLoginTransactionInput,
  type CreateOidcLoginTransactionResult,
  type EnsureAccountFromOidcInput,
  type OidcLoginTransactionRepository,
} from '../../modules/identity/index.js';
