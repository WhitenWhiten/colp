/**
 * Task A4: single auth-route manifest.
 *
 * One manifest table drives the three consumers that previously duplicated
 * the auth surface (plan §7 Task A4 step 6; G1 ADR §10):
 *
 * 1. composition registration — the allowlisted Better Auth endpoints mounted
 *    by better-auth-routes.ts (the A1 runtime bridge) and the preserved
 *    product session/me/logout routes registered by browser-auth-routes.ts;
 * 2. rate-limit families — http-security.ts derives AUTH_RATE_LIMITED_PATHS
 *    and the path→family map from this manifest (no hardcoded second list);
 * 3. OpenAPI registration — every entry carries the stable operationId the
 *    product OpenAPI will use when the BA paths are registered (F2/Q1); the
 *    product/legacy entries mirror the frozen openapi/product-v1.yaml
 *    operationIds, the BA entries use BA 1.6.29 operationIds (or the plugin
 *    endpoint keys where the library defines none).
 *
 * Status semantics:
 * - `registered`: mounted today (BA allowlist, legacy OIDC until F2/F3, and
 *   the product session/me/avatar routes);
 * - `pending`: enumerated on the real BA 1.6.29 handler (G1 §17 P2) but NOT
 *   mounted — the two-factor (MFA) plugin endpoints stay gated until the MFA
 *   product surface registers. C4 assigns each pending endpoint its SEALED
 *   rate-limit family so the admission map is ready before registration (an
 *   attacker cannot launder traffic through unmounted endpoints to escape a
 *   family budget: the onRequest gate consumes the family bucket before
 *   routing).
 *
 * The legacy OIDC entries keep their sealed rate-limit families (oidc-start /
 * oidc-callback) until F3 removes them (G1 §10). C4 splits the Better Auth
 * surface into dedicated families: sign-in, sign-up, otp (email OTP
 * send/verify incl. email change), reset (password reset incl. the product
 * recovery routes), link (explicit provider link/unlink), mfa
 * (two-factor/TOTP endpoints), and oauth-callback (parameterized provider
 * callbacks; matched by Fastify `:param` segments, not exact path).
 */
import type { AuthRateLimitRouteFamily } from '../../infrastructure/rate-limit/index.js'; import { ACCOUNT_CREDENTIAL_AUTH_ROUTES } from './account-credential-auth-manifest.js';

export type AuthRouteScope = 'better-auth' | 'legacy-oidc' | 'product';
export type AuthRouteStatus = 'registered' | 'pending';

export interface AuthRouteManifestEntry {
  /** Exact HTTP method of the product route. */
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  /** Full product path (no query string). */
  readonly path: string;
  /**
   * Stable OpenAPI operationId: the product OpenAPI operationId for
   * product/legacy entries, the BA 1.6.29 operationId (or endpoint key) for
   * Better Auth entries. Unique across the manifest.
   */
  readonly operationId: string;
  /**
   * Existing sealed auth rate-limit family; null = not rate-limited.
   * C4 assigns families to pending endpoints too, so the admission map is
   * ready before registration.
   */
  readonly rateLimitFamily: AuthRateLimitRouteFamily | null;
  /** Which owning surface the entry belongs to. */
  readonly scope: AuthRouteScope;
  /** registered = mounted today; pending = enumerated, not mounted. */
  readonly status: AuthRouteStatus;
  /** Scope note (why pending / when the entry is removed). */
  readonly note?: string;
}

export const AUTH_ROUTE_MANIFEST: readonly AuthRouteManifestEntry[] = Object.freeze([
  // --- Better Auth allowlisted endpoints (G1 §10 confirmed; A1 bridge mounts) ---
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sign-up/email',
    operationId: 'signUpWithEmailAndPassword',
    rateLimitFamily: 'sign-up',
    scope: 'better-auth',
    status: 'registered',
    note: 'Self-hosted first-run needs the Colp-Setup-Token header (D27); 403 setup_token_required otherwise.',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/registration-state',
    operationId: 'getRegistrationState',
    rateLimitFamily: 'sign-up',
    scope: 'better-auth',
    status: 'registered',
    note: 'G2 first-run: open only when auth_users is empty (reason first-run); otherwise closed. Invite is unused. COLP_MULTI_USER does not open this.',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sign-in/email',
    operationId: 'signInEmail',
    rateLimitFamily: 'sign-in',
    scope: 'better-auth',
    status: 'registered',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sign-in/username',
    operationId: 'signInUsername',
    rateLimitFamily: 'sign-in',
    scope: 'better-auth',
    status: 'registered',
    note: 'G2 username sign-in; email sign-in stays mounted',
  }),
  // BA's own operationId for get-session is `getSession`, which the product
  // /api/v1/session already owns in openapi/product-v1.yaml — the manifest
  // operationId is unique, so the BA entry uses getAuthSession.
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/get-session',
    operationId: 'getAuthSession',
    rateLimitFamily: 'session',
    scope: 'better-auth',
    status: 'registered',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sign-out',
    operationId: 'signOut',
    rateLimitFamily: 'session',
    scope: 'better-auth',
    status: 'registered',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/revoke-session',
    operationId: 'revokeSession',
    rateLimitFamily: 'session',
    scope: 'better-auth',
    status: 'registered',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/change-password',
    operationId: 'changePassword',
    rateLimitFamily: 'session',
    scope: 'better-auth',
    status: 'registered',
  }),

  // --- Better Auth OAuth authorization-code chains (C3: flipped to registered) ---
  // The explicit link endpoint POST /api/v1/auth/oauth2/link is a product
  // route (scope 'product' below): the product route carries the session +
  // Origin/CSRF + re-auth gate the settings flow requires.
  // Built-in social chain (production socialProviders google/github):
  // POST /sign-in/social with body { provider, callbackURL } answers the
  // provider authorize URL carrying redirect_uri={baseURL}/callback/{id}.
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sign-in/social',
    operationId: 'signInSocial',
    rateLimitFamily: 'sign-in',
    scope: 'better-auth',
    status: 'registered',
    note: 'OAuth start (C3): built-in social chain; callback URL validated to the Know-N origin before the bridge',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/callback/:providerId',
    operationId: 'socialCallback',
    rateLimitFamily: 'oauth-callback',
    scope: 'better-auth',
    status: 'registered',
    note: 'OAuth callback (C3): built-in social chain; state-bound callback URL, one-time state/code, no open redirect',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sign-in/oauth2',
    operationId: 'signInWithOAuth2',
    rateLimitFamily: 'sign-in',
    scope: 'better-auth',
    status: 'registered',
    note: 'OAuth start (C3): callback URL validated to the Know-N origin before the bridge',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/oauth2/callback/:providerId',
    operationId: 'oAuth2Callback',
    rateLimitFamily: 'oauth-callback',
    scope: 'better-auth',
    status: 'registered',
    note: 'OAuth callback (C3): state-bound callback URL, one-time state/code, no open redirect',
  }),

  // --- Better Auth email endpoints (BA 1.6.29 actual paths, G1 §17 P2;
  // registered) ---
  // password reset + email verification + emailOTP plugin routes. Each entry
  // carries its sealed C4 rate-limit family (reset / otp). The C1 auth email
  // sender delivers reset/verification/OTP mail; without a sender the
  // endpoints report RESET_PASSWORD_DISABLED / VERIFICATION_EMAIL_NOT_ENABLED
  // / OTP no-op (fail closed, never a claimed send).
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/reset-password',
    operationId: 'resetPassword',
    rateLimitFamily: 'reset',
    scope: 'better-auth',
    status: 'registered',
    note: 'password reset flow (C2): BA POST /reset-password, token in body',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/request-password-reset',
    operationId: 'requestPasswordReset',
    rateLimitFamily: 'reset',
    scope: 'better-auth',
    status: 'registered',
    note: 'password reset flow (C2): non-enumerating, delivery only when the user exists',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/verify-email',
    operationId: 'verifyEmail',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email verification flow (C2): BA 1.6.29 registers GET with token in the query',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/send-verification-email',
    operationId: 'sendVerificationEmail',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email verification flow (C2): sign-in never re-sends (sendOnSignIn=false)',
  }),
  // emailOTP plugin endpoints (BA 1.6.29 default paths).
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sign-in/email-otp',
    operationId: 'signInEmailOTP',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email OTP sign-in (C2)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/email-otp/send-verification-otp',
    operationId: 'sendVerificationOTP',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email OTP send (C2). P6: login and register share this path; signup-intent is a header, not a family. A tighter register bucket needs header-aware admission plus a new Redis key codec family — keep otp.',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/email-otp/check-verification-otp',
    operationId: 'checkVerificationOTP',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email OTP verification (C2)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/email-otp/verify-email',
    operationId: 'verifyEmailOTP',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email OTP verification (C2)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/email-otp/request-password-reset',
    operationId: 'requestPasswordResetEmailOTP',
    rateLimitFamily: 'reset',
    scope: 'better-auth',
    status: 'registered',
    note: 'email OTP password reset (C2)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/email-otp/reset-password',
    operationId: 'resetPasswordEmailOTP',
    rateLimitFamily: 'reset',
    scope: 'better-auth',
    status: 'registered',
    note: 'email OTP password reset (C2)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/forget-password/email-otp',
    operationId: 'forgetPasswordEmailOTP',
    rateLimitFamily: 'reset',
    scope: 'better-auth',
    status: 'registered',
    note: 'email OTP password reset (C2)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/email-otp/request-email-change',
    operationId: 'requestEmailChangeEmailOTP',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email change (C2); OTP send/verify budget',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/email-otp/change-email',
    operationId: 'changeEmailEmailOTP',
    rateLimitFamily: 'otp',
    scope: 'better-auth',
    status: 'registered',
    note: 'email change (C2); OTP send/verify budget',
  }),

  // --- T-04 MCP OAuth built-in issuer (mounted when BETTER_AUTH_OAUTH_ISSUER_ENABLED) ---
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/oauth2/authorize',
    operationId: 'getOAuth2Authorize',
    rateLimitFamily: 'oauth-authorize',
    scope: 'better-auth',
    status: 'registered',
    note: 'MCP OAuth authorize (T-04); mounted when BETTER_AUTH_OAUTH_ISSUER_ENABLED=true',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/oauth2/authorize',
    operationId: 'postOAuth2Authorize',
    rateLimitFamily: 'oauth-authorize',
    scope: 'better-auth',
    status: 'registered',
    note: 'MCP OAuth authorize POST (T-04); mounted when BETTER_AUTH_OAUTH_ISSUER_ENABLED=true',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/oauth2/token',
    operationId: 'oauth2Token',
    rateLimitFamily: 'oauth-token',
    scope: 'better-auth',
    status: 'registered',
    note: 'MCP OAuth token (T-04); public AS endpoint, not a browser cookie mutation',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/oauth2/userinfo',
    operationId: 'getOAuth2UserInfo',
    rateLimitFamily: 'oauth-token',
    scope: 'better-auth',
    status: 'registered',
    note: 'MCP OAuth userinfo (T-04)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/oauth2/userinfo',
    operationId: 'postOAuth2UserInfo',
    rateLimitFamily: 'oauth-token',
    scope: 'better-auth',
    status: 'registered',
    note: 'MCP OAuth userinfo POST (T-04)',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/jwks',
    operationId: 'getJSONWebKeySet',
    rateLimitFamily: 'oauth-token',
    scope: 'better-auth',
    status: 'registered',
    note: 'Issuer JWKS (T-04 jwt plugin); mounted when BETTER_AUTH_OAUTH_ISSUER_ENABLED=true',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/oauth2/consent',
    operationId: 'oauth2Consent',
    rateLimitFamily: 'oauth-authorize',
    scope: 'better-auth',
    status: 'registered',
    note: 'MCP OAuth consent (T-07 frontend POST); browser Origin/CSRF contract applies',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/oauth2/public-client',
    operationId: 'getOAuthClientPublic',
    rateLimitFamily: 'oauth-authorize',
    scope: 'better-auth',
    status: 'registered',
    note: 'Public CIMD/client fields for the T-07 consent page',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/oauth2/consent-transaction',
    operationId: 'getOAuthConsentTransaction',
    rateLimitFamily: 'oauth-authorize',
    scope: 'better-auth',
    status: 'registered',
    note: 'Session-gated signed oauth_query verify for the consent page redirect URI (not a public AS endpoint)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/oauth2/register',
    operationId: 'oauth2Register',
    rateLimitFamily: 'oauth-register',
    scope: 'better-auth',
    status: 'registered',
    note: 'RFC 7591 DCR fallback (T-04); public AS endpoint, CIMD remains advertised',
  }),

  // --- C4: two-factor (MFA) endpoints (BA 1.6.29 two-factor plugin paths) ---
  // Still pending/gated: the MFA product surface has not registered them
  // (the plugin itself is already wired when the MFA config is present).
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/enable',
    operationId: 'enableTwoFactor',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: 'TOTP enrollment (C4); product registration gated',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/disable',
    operationId: 'disableTwoFactor',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: 'TOTP disable (C4); product registration gated',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/get-totp-uri',
    operationId: 'getTOTPURI',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: 'TOTP URI re-display (C4); product registration gated',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/verify-totp',
    operationId: 'verifyTOTP',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: 'pending challenge TOTP verification (C4); product registration gated',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/verify-backup-code',
    operationId: 'verifyBackupCode',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: 'single-use recovery code verification (C4); product registration gated',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/generate-backup-codes',
    operationId: 'generateBackupCodes',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: 'recovery set regeneration (C4); product registration gated',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/send-otp',
    operationId: 'sendTwoFactorOTP',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: '2FA email OTP send (C4); product registration gated',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/two-factor/verify-otp',
    operationId: 'verifyTwoFactorOTP',
    rateLimitFamily: 'mfa',
    scope: 'better-auth',
    status: 'pending',
    note: '2FA email OTP verify (C4); product registration gated',
  }),

  // --- C3 product linking/recovery surface (browser-auth-routes.ts) ---
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/oauth2/link',
    operationId: 'oAuth2LinkAccount',
    rateLimitFamily: 'link',
    scope: 'product',
    status: 'registered',
    note: 'explicit link start (C3): session + Origin/CSRF + re-auth gate, returns the provider authorization URL',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/linked-accounts',
    operationId: 'listLinkedAccounts',
    rateLimitFamily: 'link',
    scope: 'product',
    status: 'registered',
    note: 'session-gated list of linked social providers (C3) plus hasPassword (P3); no CSRF (GET, like /me); body { accounts, hasPassword }',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/unlink-account',
    operationId: 'unlinkAccount',
    rateLimitFamily: 'link',
    scope: 'product',
    status: 'registered',
    note: 'explicit unlink (C3): refused when it would remove the last recovery method',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/recovery/password-reset',
    operationId: 'requestPasswordRecovery',
    rateLimitFamily: 'reset',
    scope: 'product',
    status: 'registered',
    note: 'non-enumerating password-reset request (C3 recovery facade)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/recovery/otp-reset',
    operationId: 'resetPasswordWithEmailOTP',
    rateLimitFamily: 'reset',
    scope: 'product',
    status: 'registered',
    note: 'verified-email OTP password reset (C3 recovery facade)',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/sessions',
    operationId: 'listBrowserSessions',
    rateLimitFamily: 'session',
    scope: 'product',
    status: 'registered',
    note: 'P4: session-gated list of live sessions; body { sessions: [{ id, createdAt, updatedAt, current }] }; never token (R9); no CSRF (GET, like /me)',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/sessions/revoke',
    operationId: 'revokeBrowserSessionById',
    rateLimitFamily: 'session',
    scope: 'product',
    status: 'registered',
    note: 'P4: revoke one session by BA/metadata id (not token); session + Origin/CSRF; current calls signOut; other deletes that BA row only without epoch bump',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/auth/account/delete',
    operationId: 'deleteAccount',
    rateLimitFamily: 'session',
    scope: 'product',
    status: 'registered',
    note: 'P10: irreversible account delete; session + Origin/CSRF + reauth + confirmation DELETE; revokeAll then soft-delete accounts (email null) then BA internalAdapter.deleteUser; never BA HTTP /delete-user',
  }),

  // --- Legacy OIDC surface (F1 quarantine; registered until F2 removes the
  // routes and F3 removes the rate-limit families) ---
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/oidc/start',
    operationId: 'startOidcAuthorization',
    rateLimitFamily: 'oidc-start',
    scope: 'legacy-oidc',
    status: 'registered',
    note: 'legacy OIDC login; rate-limit family preserved until F3 removes it',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/auth/oidc/callback',
    operationId: 'completeOidcAuthorization',
    rateLimitFamily: 'oidc-callback',
    scope: 'legacy-oidc',
    status: 'registered',
    note: 'legacy OIDC login; rate-limit family preserved until F3 removes it',
  }),

  // --- Product session/me/logout routes (preserved shapes; G1 §10) ---
  Object.freeze({
    method: 'GET',
    path: '/api/v1/session',
    operationId: 'getSession',
    rateLimitFamily: 'session',
    scope: 'product',
    status: 'registered',
  }),
  Object.freeze({
    method: 'DELETE',
    path: '/api/v1/session',
    operationId: 'deleteSession',
    rateLimitFamily: 'session',
    scope: 'product',
    status: 'registered',
  }),
  Object.freeze({
    method: 'GET',
    path: '/api/v1/me',
    operationId: 'getMe',
    rateLimitFamily: 'me',
    scope: 'product',
    status: 'registered',
  }),
  Object.freeze({
    method: 'PATCH',
    path: '/api/v1/me',
    operationId: 'updateMe',
    rateLimitFamily: 'me',
    scope: 'product',
    status: 'registered',
  }),
  Object.freeze({
    method: 'POST',
    path: '/api/v1/me/avatar',
    operationId: 'uploadMyAvatar',
    rateLimitFamily: 'me',
    scope: 'product',
    status: 'registered',
  }), ...ACCOUNT_CREDENTIAL_AUTH_ROUTES]);

/**
 * Look up a manifest entry by exact method + URL path (query string ignored).
 * Returns null for anything outside the auth surface.
 */
export function authManifestEntryFor(
  method: string,
  rawPath: string,
): AuthRouteManifestEntry | null {
  const path = rawPath.split('?', 1)[0] ?? rawPath;
  const normalizedMethod = method.toUpperCase();
  return AUTH_ROUTE_MANIFEST.find((entry) =>
    entry.method === normalizedMethod && entry.path === path) ?? null;
}

/** Registration-time guard: the auth surface may never register outside the manifest. */
export function requireAuthManifestEntry(
  method: string,
  rawPath: string,
): AuthRouteManifestEntry {
  const entry = authManifestEntryFor(method, rawPath);
  if (entry === null) {
    throw new Error(
      `auth route ${method} ${rawPath} is not in the AUTH_ROUTE_MANIFEST; add it before registering`,
    );
  }
  return entry;
}
