import type { betterAuth, BetterAuthOptions } from 'better-auth';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type {
  AuthEmailSender,
  BusinessAccountUnitOfWork,
  OAuthOccupancyAdoptedInput,
} from '../../modules/auth/index.js';
import type { Metrics } from '../telemetry/index.js';

/**
 * Public contracts and endpoint declarations for the Better Auth runtime.
 *
 * Keeping these data-only declarations separate from construction, product
 * hooks, and the Fastify bridge makes the runtime composition easier to
 * audit without changing its established facade.
 */

export interface BetterAuthAllowlistEntry {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}
/**
 * G1 §10 confirmed endpoints, extended with the email surface (A4
 * registration). C3 flipped the OAuth authorization-code chains (start +
 * callback) to registered — BOTH the Better Auth built-in social chain
 * (sign-in/social + callback/:providerId, used by the production
 * socialProviders google/github mapping) and the genericOAuth plugin chain
 * (sign-in/oauth2 + oauth2/callback/:providerId, used by the controlled test
 * providers); the explicit link endpoint moved to the product route surface
 * (browser-auth-routes.ts) where the session + Origin/CSRF + re-auth gate
 * lives.
 *
 * Email endpoints (password reset / verification / emailOTP plugin) are
 * mounted against the real BA 1.7.1 paths (G1 §17 P2 enumeration). When a
 * plugin is not wired (e.g. the emailOTP plugin without
 * BETTER_AUTH_EMAIL_OTP_ENABLED, or no C1 sender), the bridge still forwards
 * and BA answers its own 404/disabled shapes — the allowlisted surface stays
 * uniform and fail-closed. The two-factor (MFA) plugin endpoints stay
 * gated/pending until the MFA product surface registers.
 */
export const BETTER_AUTH_BROWSER_ALLOWLIST: readonly BetterAuthAllowlistEntry[] = Object.freeze([
  Object.freeze({ method: 'POST', path: '/sign-up/email' }),
  Object.freeze({ method: 'GET', path: '/registration-state' }),
  Object.freeze({ method: 'POST', path: '/sign-in/email' }),
  Object.freeze({ method: 'POST', path: '/sign-in/username' }),
  Object.freeze({ method: 'GET', path: '/get-session' }),
  Object.freeze({ method: 'POST', path: '/sign-out' }),
  Object.freeze({ method: 'POST', path: '/revoke-session' }),
  Object.freeze({ method: 'POST', path: '/change-password' }),
  // C3: OAuth authorization-code chains (G1 §10 paths):
  // - /sign-in/social + /callback/:providerId: Better Auth BUILT-IN chain —
  //   the production socialProviders (google/github) mapping uses it, and the
  //   provider authorize URL carries redirect_uri={baseURL}/callback/{id}.
  // - /sign-in/oauth2 + /oauth2/callback/:providerId: genericOAuth plugin
  //   chain — used by the controlled test providers only (the production
  //   runtime does not enable the plugin; NODE_ENV=test may inject
  //   `testGenericOAuth`. The bridge still forwards and BA answers 404
  //   without the plugin, so the allowlisted surface stays uniform).
  Object.freeze({ method: 'POST', path: '/sign-in/social' }),
  Object.freeze({ method: 'GET', path: '/callback/:providerId' }),
  Object.freeze({ method: 'POST', path: '/sign-in/oauth2' }),
  Object.freeze({ method: 'GET', path: '/oauth2/callback/:providerId' }),
  // C2/A4: email surface (BA 1.7.1 actual paths; G1 §17 P2 enumeration):
  // emailAndPassword reset + email verification + emailOTP plugin. All are
  // POST except /verify-email (BA 1.7.1 registers it GET, token in query).
  Object.freeze({ method: 'POST', path: '/reset-password' }),
  Object.freeze({ method: 'POST', path: '/request-password-reset' }),
  Object.freeze({ method: 'GET', path: '/verify-email' }),
  Object.freeze({ method: 'POST', path: '/send-verification-email' }),
  Object.freeze({ method: 'POST', path: '/sign-in/email-otp' }),
  Object.freeze({ method: 'POST', path: '/email-otp/send-verification-otp' }),
  Object.freeze({ method: 'POST', path: '/email-otp/check-verification-otp' }),
  Object.freeze({ method: 'POST', path: '/email-otp/verify-email' }),
  Object.freeze({ method: 'POST', path: '/email-otp/request-password-reset' }),
  Object.freeze({ method: 'POST', path: '/email-otp/reset-password' }),
  Object.freeze({ method: 'POST', path: '/forget-password/email-otp' }),
  Object.freeze({ method: 'POST', path: '/email-otp/request-email-change' }),
  Object.freeze({ method: 'POST', path: '/email-otp/change-email' }),
]);

/**
 * MCP OAuth built-in issuer surface (T-04). Mounted only when
 * BETTER_AUTH_OAUTH_ISSUER_ENABLED=true. POST `/oauth2/register` is RFC 7591
 * DCR (CIMD stays advertised; DCR is the compatibility fallback).
 */
export const BETTER_AUTH_OAUTH_ISSUER_ALLOWLIST: readonly BetterAuthAllowlistEntry[] = Object.freeze([
  Object.freeze({ method: 'GET', path: '/oauth2/authorize' }),
  Object.freeze({ method: 'POST', path: '/oauth2/authorize' }),
  Object.freeze({ method: 'POST', path: '/oauth2/token' }),
  Object.freeze({ method: 'GET', path: '/oauth2/userinfo' }),
  Object.freeze({ method: 'POST', path: '/oauth2/userinfo' }),
  Object.freeze({ method: 'GET', path: '/jwks' }),
  Object.freeze({ method: 'POST', path: '/oauth2/consent' }),
  Object.freeze({ method: 'GET', path: '/oauth2/public-client' }),
  Object.freeze({ method: 'GET', path: '/oauth2/consent-transaction' }),
  Object.freeze({ method: 'POST', path: '/oauth2/register' }),
]);

/**
 * Grant types the built-in issuer actually serves. `@better-auth/oauth-provider`
 * advertises `client_credentials` by default; that grant has no confidential
 * client onboarding path here (DCR and CIMD both mint public authorization-code
 * clients). Token-endpoint auth methods cannot be trimmed by a supported plugin option.
 */
export const BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES = Object.freeze([
  'authorization_code',
  'refresh_token',
] as const);

/** Full BA allowlist (browser + issuer). Flag-off mount uses the browser subset. */
export const BETTER_AUTH_ALLOWLIST: readonly BetterAuthAllowlistEntry[] = Object.freeze([
  ...BETTER_AUTH_BROWSER_ALLOWLIST,
  ...BETTER_AUTH_OAUTH_ISSUER_ALLOWLIST,
]);

/**
 * Register OTP send (POST /email-otp/send-verification-otp) carries this
 * header so the explicit verification step can create a new account. Login
 * and registration sends both keep a uniform successful response; occupancy
 * is enforced only after mailbox proof at the verify endpoint.
 */
export const SIGNUP_OTP_INTENT_HEADER = 'x-known-auth-intent';
export const SIGNUP_OTP_INTENT_VALUE = 'sign-up';

/** Frontend route the verification email must land on (not the BA API path). */
export const PRODUCT_EMAIL_VERIFICATION_PATH = '/verify-email';


export interface BetterAuthRuntimeSocialProvider {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Structural mirror of the module-layer BetterAuthConfig.mfa (C4). The
 * two-factor plugin is wired ONLY when this is present.
 */
export interface BetterAuthRuntimeMfaConfig {
  readonly enabled: true;
  readonly totpDigits: 6 | 8;
  readonly totpPeriodSeconds: number;
  readonly pendingCookieMaxAgeSeconds: number;
  readonly backupCodesAmount: number;
  readonly backupCodesLength: number;
  readonly trustDeviceMaxAgeSeconds: number;
}

/**
 * Structural mirror of the module-layer BetterAuthConfig. The module leaf is
 * not importable from infrastructure under the dependency graph; the
 * composition tests pin the two types together at compile time.
 */
export interface BetterAuthRuntimeConfig {
  readonly baseURL: string;
  readonly basePath: string;
  readonly secret: string;
  readonly sessionTokenProtection: {
    readonly keys: readonly { readonly version: number; readonly key: Buffer }[];
    readonly legacyPlaintextReadUntil: Date | null;
  };
  readonly trustedOrigins: readonly string[];
  readonly cookieName: '__Host-known_session' | 'known_session';
  readonly sessionExpiresInSeconds: number;
  readonly sessionUpdateAgeSeconds: number;
  readonly bodyLimitBytes: number;
  readonly emailOtp: {
    readonly enabled: true;
    readonly otpLength: 6;
    readonly expiresInSeconds: number;
    readonly maxAttempts: number;
  } | null;
  readonly social: {
    readonly google?: BetterAuthRuntimeSocialProvider;
    readonly github?: BetterAuthRuntimeSocialProvider;
  } | null;
  readonly passwordHash: {
    readonly hash: (password: string) => Promise<string>;
    readonly verify: (input: { readonly hash: string; readonly password: string }) => Promise<boolean>;
  };
  /** C4: two-factor TOTP settings; absent => the plugin is not wired. */
  readonly mfa?: BetterAuthRuntimeMfaConfig | null;
  /** T-04 built-in MCP OAuth issuer; absent/null => jwt/mcp/cimd stay unwired. */
  readonly oauthIssuer?: BetterAuthRuntimeOauthIssuerConfig | null;
}

export interface BetterAuthRuntimeOauthIssuerConfig {
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly accessTokenExpiresInSeconds: 3600;
  readonly loginPage: '/login';
  readonly consentPage: '/consent';
  readonly dcrMaxAnonymousClients: number;
  readonly dcrUnusedClientRetentionSeconds: number;
  readonly dcrMaxOwnedClientsPerUser: number;
  readonly dcrMaxOwnedClients: number;
}

export interface BetterAuthRuntimeInput<DB> {
  readonly enabled: boolean;
  readonly config: BetterAuthRuntimeConfig;
  /**
   * Kysely binding with a REAL transaction adapter — G0 §4.8 freezes
   * `transaction: true` (the `{db, type}` form without it is an as-is
   * pseudo-transaction with no rollback).
   */
  readonly database: {
    readonly db: Kysely<DB>;
    readonly type: 'postgres';
    readonly transaction: true;
  };
  /**
   * C1 auth email sender (composed by bootstrap in test mode as the
   * in-process mailbox sink). When absent the email callbacks stay inert:
   * request-password-reset / send-verification-email report NOT_ENABLED and
   * the OTP callback is a no-op — a delivery is NEVER claimed.
   */
  readonly authEmail?: AuthEmailSender;
  /**
   * A2 business-account establishment ports. When absent the mapping hooks
   * are no-ops (shadow mode / pre-wiring). All hooks are idempotent and run
   * post-commit; establishment failures are retried on the next session
   * creation (see the file contract).
   */
  readonly businessAccount?: { readonly unitOfWork: BusinessAccountUnitOfWork };
  /** Minimal pino-compatible logger for redacted establishment warnings. */
  readonly logger?: { warn(bindings: object, message: string): void };
  /**
   * Password-change keep-current: bump the account epoch and drop every other
   * browser / legacy session after Better Auth mints the successor. Guarded —
   * a failure must never fail the committed password change.
   */
  readonly onPasswordChanged?: (input: {
    readonly authUserId: string;
    readonly currentAuthSessionId: string;
  }) => Promise<void>;
  /**
   * Password-reset epoch revoke (token reset and email-OTP recovery). BA
   * `/reset-password` and `/email-otp/reset-password` already delete BA
   * sessions; this callback bumps the product `security_epoch` so HTTP
   * `/change-password` and recovery share the composition's epoch-revoke
   * wiring. Guarded — a failure must never fail the committed reset.
   */
  readonly onPasswordReset?: (input: {
    readonly authUserId: string;
  }) => Promise<void>;
  /**
   * P1/S-01 occupancy adopt: resolve the business mapping and revoke every
   * existing session (`BrowserSessionAuthority.revokeAll` / epoch bridge).
   * Optional so tests that construct a runtime without an authority still
   * compile; a missing callback fail-closes the adopt (throw, no half-link).
   */
  readonly onOAuthOccupancyAdopted?: (input: OAuthOccupancyAdoptedInput) => Promise<void>;
  /**
   * Explicit provider-link completion (a new non-credential auth account beside
   * an existing one). Link start does not call this. Composition raises
   * `provider_link` through the security-epoch bridge. Credential inserts must
   * not: `commit_password_security_event` already bumps those once.
   */
  readonly onProviderLinked?: (input: { readonly authUserId: string }) => Promise<void>;
  /**
   * NODE_ENV=test only: append a controlled genericOAuth plugin so occupancy
   * / linking integration can drive the oauth2 callback chain through
   * production compose. Any non-test NODE_ENV refuses this field if provided.
   */
  readonly testGenericOAuth?: NonNullable<BetterAuthOptions['plugins']>[number];
  /**
   * NODE_ENV=test only: replace the production CIMD fetch so metadata can
   * be served for a public-looking HTTPS `client_id` without opening SSRF.
   * Production (and any non-test NODE_ENV) refuses this field.
   */
  readonly testFetchClientMetadataResource?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>;
  /**
   * Optional sealed DCR admission/reclaim counters. Absent in tests that do
   * not care; production composition forwards InMemoryMetrics.
   */
  readonly metrics?: Metrics;
}

/** The Better Auth 1.7.1 instance constructed by {@link createBetterAuthRuntime}. */
export type BetterAuthInstance = ReturnType<typeof betterAuth>;

export interface BetterAuthRuntime {
  /** Registers ONLY the allowlisted /api/v1/auth endpoints on the app. */
  readonly mount: (app: FastifyInstance) => void;
  /**
   * Same Better Auth handler instance as `/api/v1/auth`. Transport forwards
   * the RFC 8414 issuer-inserted well-known path here (T-05 / ADR D6).
   */
  readonly handle: (request: Request) => Promise<Response>;
  /**
   * AUTH-P1-a: the single production instance. Composition injects this into
   * the session authority and `auth.api` (recovery/link/delete) so those
   * surfaces share `onPasswordChanged` / occupancy / epoch-revoke hooks.
   */
  readonly auth: BetterAuthInstance;
}
