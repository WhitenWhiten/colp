/**
 * LEGACY STATUS — partial quarantine (Task F1).
 *
 * This facade still backs the CURRENT product session/me/logout API and stays
 * in the runtime composition; only the OIDC start/callback branches
 * (`/api/v1/auth/oidc/start`, `/api/v1/auth/oidc/callback`) and their helpers
 * are legacy OIDC/Logto flow. They are deprecated by the Better Auth migration
 * (docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12 Task F1; G1 ADR §11). Source retention is NOT runtime enablement.
 *
 * Ownership: Better Auth migration lane F. New code must reach the legacy OIDC
 * provider only through `src/infrastructure/auth/legacy-oidc-boundary.ts`.
 * Task F2 removes the OIDC start/callback branch from the runtime composition
 * in Better Auth mode (route absence) while keeping it registered in legacy
 * mode; the facade keeps serving the product session/me/logout surface in both
 * modes.
 *
 * Registration stays here; handlers live in `browser-auth-handlers.ts`,
 * mapping in `browser-auth-mapping.ts`, and legacy OIDC in `browser-auth-oidc.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuthManifestEntry } from './auth-route-manifest.js';
import type { BrowserAuthDeps } from './browser-auth-deps.js';
import { registerProductBrowserAuthRoutes } from './browser-auth-handlers.js';
import { registerLegacyOidcRoutes } from './browser-auth-oidc.js';

export type { BrowserAuthDeps } from './browser-auth-deps.js';
export {
  mapAccountDeletionError,
  mapAccountLinkingError,
  mapProfileSettingsError,
} from './browser-auth-mapping.js';
export {
  classifyOidcCallbackFailure,
  OidcCallbackStageError,
  type ClassifiedOidcCallbackFailure,
  type OidcAuthRedirectKind,
  type OidcCallbackFailureClass,
  type OidcCallbackStage,
} from './browser-auth-oidc.js';

/**
 * Task A4: every product auth route registered here must exist in the single
 * auth-route manifest (auth-route-manifest.ts) — the manifest is the shared
 * source for the OpenAPI operationIds, the rate-limit families and the
 * composition registration, so a route registered outside it would silently
 * lose its rate-limit family. The legacy OIDC routes stay registered until
 * F2 removes them (their rate-limit families remain until F3).
 */
const AUTH_MANIFEST_COVERED_ROUTES = Object.freeze([
  ['GET', '/api/v1/auth/oidc/start'],
  ['GET', '/api/v1/auth/oidc/callback'],
  // C3 product linking/recovery surface (facade-gated; manifest entries).
  ['POST', '/api/v1/auth/oauth2/link'],
  ['GET', '/api/v1/auth/linked-accounts'],
  ['POST', '/api/v1/auth/unlink-account'],
  ['GET', '/api/v1/auth/sessions'],
  ['POST', '/api/v1/auth/sessions/revoke'],
  ['POST', '/api/v1/auth/account/delete'],
  ['POST', '/api/v1/auth/recovery/password-reset'],
  ['POST', '/api/v1/auth/recovery/otp-reset'],
  ['GET', '/api/v1/session'],
  ['DELETE', '/api/v1/session'],
  ['GET', '/api/v1/me'],
  ['PATCH', '/api/v1/me'],
  ['POST', '/api/v1/me/avatar'],
] as const);

function assertAuthManifestCoverage(): void {
  for (const [method, path] of AUTH_MANIFEST_COVERED_ROUTES) {
    requireAuthManifestEntry(method, path);
  }
}

export function registerBrowserAuthRoutes(
  app: FastifyInstance,
  deps: BrowserAuthDeps,
): void {
  assertAuthManifestCoverage();
  registerLegacyOidcRoutes(app, deps);
  registerProductBrowserAuthRoutes(app, deps);
}
