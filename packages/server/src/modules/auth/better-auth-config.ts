import * as argon2 from '@node-rs/argon2';
import { assertAuthOtpPolicy } from './application/auth-token-policy.js';
import {
  PASSWORD_HASH_ARGON2ID_PARAMS,
  verifyArgon2idHash,
} from './application/password-hasher.js';

/**
 * A1/A2/C2 typed Better Auth configuration wrapper (module layer leaf).
 *
 * Maps the typed configuration section (`AppConfig['betterAuth']`, pinned
 * structurally by tests/unit/auth/better-auth-config-builder.test.ts) onto the Better Auth
 * 1.7.1 settings contract WITHOUT constructing a Better Auth instance:
 * `buildBetterAuthConfig` returns `null` when Better Auth is disabled, so the
 * runtime never calls `betterAuth()` in disabled mode (A1 zero-registration
 * contract, G1 §6).
 *
 * C2 (security contract): the Argon2id parameters are single-sourced from the
 * modules/auth password-hasher port (`PASSWORD_HASH_ARGON2ID_PARAMS`) and the
 * OTP policy is re-checked against the frozen G1 §8 invariants
 * (`assertAuthOtpPolicy`) as a second line of defense after the env parsing.
 *
 * C4 (MFA contract): the two-factor TOTP settings (`mfa`) are validated
 * against frozen library-safe bounds and emitted as `BetterAuthMfaConfig`
 * (secret/recovery codes stay inside the Better Auth library contract:
 * encrypted at rest, codes shown once — G0/G1); MFA stays off until the
 * typed config carries `mfa: { enabled: true }`.
 *
 * This file is intentionally a leaf of the import-boundary graph: its only
 * local imports are same-module application files (password-hasher.ts,
 * auth-token-policy.ts), so bootstrap/transport composition can consume it
 * without dependency-graph changes.
 */

/** Frozen single browser session cookie (G1 §4; spike §4.1). */
export const BETTER_AUTH_COOKIE_NAME = '__Host-known_session' as const;

/** Default Better Auth base path (G1 §10). */
export const BETTER_AUTH_DEFAULT_BASE_PATH = '/api/v1/auth' as const;

/** RFC 8414 issuer-inserted AS metadata path prefix (ADR D6 / T-05). */
export const OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN_PREFIX =
  '/.well-known/oauth-authorization-server' as const;

/** Absolute well-known path for the built-in issuer (`/.well-known/...` + basePath). */
export function oauthAuthorizationServerMetadataPath(
  basePath: string = BETTER_AUTH_DEFAULT_BASE_PATH,
): string {
  return `${OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN_PREFIX}${basePath}`;
}

/** Frozen MCP OAuth access-token TTL (ADR P3, 2026-08-28: 3600s). */
export const BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 3_600 as const;

/** Reserved refresh scope; Better Auth issues `refresh_token` only when granted. */
export const BETTER_AUTH_OAUTH_OFFLINE_ACCESS_SCOPE = 'offline_access' as const;

/** Ordinary Product bearer scopes registered on the existing OAuth consent set. */
export const BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE = 'product:read' as const;
export const BETTER_AUTH_OAUTH_PRODUCT_WRITE_SCOPE = 'product:write' as const;

/** Capability scopes plus ordinary product scopes and the reserved refresh scope. */
export function withBetterAuthOauthIssuerScopes(
  scopes: readonly string[],
): readonly string[] {
  const unique: string[] = [];
  for (const scope of scopes) {
    if (!unique.includes(scope)) unique.push(scope);
  }
  for (const scope of [BETTER_AUTH_OAUTH_PRODUCT_READ_SCOPE, BETTER_AUTH_OAUTH_PRODUCT_WRITE_SCOPE]) {
    if (!unique.includes(scope)) unique.push(scope);
  }
  if (!unique.includes(BETTER_AUTH_OAUTH_OFFLINE_ACCESS_SCOPE)) {
    unique.push(BETTER_AUTH_OAUTH_OFFLINE_ACCESS_SCOPE);
  }
  return Object.freeze(unique);
}

/** Host-compat MCP path; must stay equal to `MCP_COMPAT_ENDPOINT_PATH`. */
export const BETTER_AUTH_MCP_COMPAT_RESOURCE_PATH = '/collections/-/mcp-compat' as const;

/**
 * RFC 8707 resources the built-in issuer accepts: strict `/mcp` plus
 * `/mcp-compat`. One consent; token `aud` is the resource the client asked for.
 */
export function betterAuthMcpIssuerResources(strictResource: string): readonly string[] {
  const url = new URL(strictResource);
  const compat = `${url.origin}${BETTER_AUTH_MCP_COMPAT_RESOURCE_PATH}`;
  if (compat === strictResource) return Object.freeze([strictResource]);
  return Object.freeze([strictResource, compat]);
}

/** Frontend login page used by `mcp({ loginPage })` (ADR D10 / T-07). */
export const BETTER_AUTH_OAUTH_LOGIN_PAGE = '/login' as const;

/** Frontend consent page used by `mcp({ consentPage })` (ADR D10 / T-07). */
export const BETTER_AUTH_OAUTH_CONSENT_PAGE = '/consent' as const;

/**
 * Frozen Argon2id parameters verified against Better Auth 1.7.1 (G0 spike §4.4):
 * output `$argon2id$v=19$m=19456,t=2,p=1$...`. Single-sourced from the
 * modules/auth password-hasher contract (C2); the better-auth default
 * password hash is scrypt and MUST NOT be used (plan §1.2, contract §2).
 */
export const BETTER_AUTH_ARGON2ID_PARAMS = PASSWORD_HASH_ARGON2ID_PARAMS;

/**
 * ADR cutover enum. AUTH-P1-b: kept so AppConfig mapping stays structurally
 * assignable; unused at runtime (`buildBetterAuthConfig` keys only on `enabled`).
 */
export type BetterAuthCutoverMode = 'shadow' | 'canary' | 'on';

export interface BetterAuthSocialProviderCredential {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Structural mirror of `AppConfig['betterAuth']` (config.ts owns env parsing
 * and startup validation; this wrapper re-checks the frozen invariants as a
 * second line of defense).
 */
export interface BetterAuthConfigInput {
  readonly enabled: boolean;
  /**
   * AUTH-P1-b unused at runtime. Kept on the input type so AppConfig mapping
   * does not break. `buildBetterAuthConfig` does not read this field.
   */
  readonly cutoverMode: BetterAuthCutoverMode;
  /**
   * AUTH-P1-b unused at runtime (and unused by the BA config builder).
   * Kept on the input type so AppConfig mapping does not break.
   */
  readonly canaryAllowlist?: readonly string[];
  readonly emailOtpEnabled: boolean;
  readonly socialEnabled: boolean;
  readonly baseUrl: string;
  readonly basePath: string;
  readonly secret: string | null;
  readonly sessionTokenProtection: BetterAuthSessionTokenProtectionConfig | null;
  readonly trustedOrigins: readonly string[];
  readonly cookieName: string;
  readonly sessionExpiresInSeconds: number;
  readonly sessionUpdateAgeSeconds: number;
  readonly otpTtlSeconds: number;
  readonly otpMaxAttempts: number;
  readonly bodyLimitBytes: number;
  readonly social: Readonly<{
    readonly google?: BetterAuthSocialProviderCredential;
    readonly github?: BetterAuthSocialProviderCredential;
  }>;
  /** MFA settings input; absent = MFA off (two-factor plugin not wired). */
  readonly mfa?: BetterAuthMfaConfigInput;
  /** BETTER_AUTH_OAUTH_ISSUER_ENABLED; issuer plugins stay off when false. */
  readonly oauthIssuerEnabled: boolean;
  readonly oauthIssuer?: BetterAuthOauthIssuerInput | null;
}

export interface BetterAuthOauthIssuerInput {
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly accessTokenExpiresInSeconds?: 3600;
  readonly dcrMaxAnonymousClients: number;
  readonly dcrUnusedClientRetentionSeconds: number;
  readonly dcrMaxOwnedClientsPerUser: number;
  readonly dcrMaxOwnedClients: number;
}

export interface BetterAuthEmailOtpConfig {
  readonly enabled: true;
  readonly otpLength: 6;
  readonly expiresInSeconds: number;
  readonly maxAttempts: number;
}

export interface BetterAuthSocialProviders {
  readonly google?: BetterAuthSocialProviderCredential;
  readonly github?: BetterAuthSocialProviderCredential;
}

/**
 * MFA (two-factor TOTP) settings input (C4). Optional on the typed config:
 * when absent (the current bootstrap config surface) MFA stays off and the
 * two-factor plugin is NOT wired — the config lane lands the env parsing
 * (`BETTER_AUTH_MFA_ENABLED` etc.) later, this wrapper owns the frozen
 * library-safe defaults and the second line of defense.
 */
export interface BetterAuthMfaConfigInput {
  readonly enabled: boolean;
  /** TOTP digits (library contract: 6 or 8; default 6). */
  readonly totpDigits?: 6 | 8;
  /** TOTP period in seconds (default 30; the plugin verify window is ±1 period). */
  readonly totpPeriodSeconds?: number;
  /** Pending 2FA challenge cookie max age in seconds (default 600 = 10min). */
  readonly pendingCookieMaxAgeSeconds?: number;
  /** Backup (recovery) code count (default 10). */
  readonly backupCodesAmount?: number;
  /** Backup (recovery) code length (default 10). */
  readonly backupCodesLength?: number;
  /** Trusted-device cookie max age in seconds (default 30 days). */
  readonly trustDeviceMaxAgeSeconds?: number;
}

/** Frozen MFA settings emitted by the typed config wrapper (C4). */
export interface BetterAuthMfaConfig {
  readonly enabled: true;
  readonly totpDigits: 6 | 8;
  readonly totpPeriodSeconds: number;
  readonly pendingCookieMaxAgeSeconds: number;
  readonly backupCodesAmount: number;
  readonly backupCodesLength: number;
  readonly trustDeviceMaxAgeSeconds: number;
}

/** Library-safe MFA defaults (Better Auth two-factor plugin 1.7.1). */
export const BETTER_AUTH_MFA_DEFAULTS: Readonly<{
  readonly totpDigits: 6;
  readonly totpPeriodSeconds: 30;
  readonly pendingCookieMaxAgeSeconds: 600;
  readonly backupCodesAmount: 10;
  readonly backupCodesLength: 10;
  readonly trustDeviceMaxAgeSeconds: 2_592_000;
}> = Object.freeze({
  totpDigits: 6,
  totpPeriodSeconds: 30,
  pendingCookieMaxAgeSeconds: 600,
  backupCodesAmount: 10,
  backupCodesLength: 10,
  trustDeviceMaxAgeSeconds: 2_592_000,
});

/** Settings consumed by the Fastify bridge runtime (infrastructure layer). */
export interface BetterAuthConfig {
  readonly baseURL: string;
  readonly basePath: string;
  readonly secret: string;
  readonly sessionTokenProtection: BetterAuthSessionTokenProtectionConfig;
  readonly trustedOrigins: readonly string[];
  readonly cookieName: '__Host-known_session';
  readonly sessionExpiresInSeconds: number;
  readonly sessionUpdateAgeSeconds: number;
  readonly bodyLimitBytes: number;
  /** Non-null only when BETTER_AUTH_EMAIL_OTP_ENABLED=true (G1 §8 values). */
  readonly emailOtp: BetterAuthEmailOtpConfig | null;
  /** Non-null only when BETTER_AUTH_SOCIAL_ENABLED=true with configured providers. */
  readonly social: BetterAuthSocialProviders | null;
  /** Argon2id hook (never the better-auth default scrypt). */
  readonly passwordHash: Readonly<{
    readonly hash: (password: string) => Promise<string>;
    readonly verify: (input: { readonly hash: string; readonly password: string }) => Promise<boolean>;
  }>;
  /** Non-null only when MFA is enabled (two-factor TOTP plugin settings). */
  readonly mfa: BetterAuthMfaConfig | null;
  /** Non-null only when BETTER_AUTH_OAUTH_ISSUER_ENABLED=true. */
  readonly oauthIssuer: BetterAuthOauthIssuerConfig | null;
}

/** One active/retained at-rest key. Key bytes never cross an HTTP boundary. */
export interface BetterAuthSessionTokenProtectionKey {
  readonly version: number;
  readonly key: Buffer;
}

/**
 * Better Auth session-token at-rest protection contract. The first key writes;
 * every key may read/query, which makes rotation non-destructive.
 */
export interface BetterAuthSessionTokenProtectionConfig {
  readonly keys: readonly BetterAuthSessionTokenProtectionKey[];
  readonly legacyPlaintextReadUntil: Date | null;
}

export interface BetterAuthOauthIssuerConfig {
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

/**
 * Build the Better Auth settings for the typed configuration.
 * Returns `null` when Better Auth is disabled — the runtime must not construct
 * a Better Auth instance in that state (A1 disabled-mode contract).
 *
 * AUTH-P1-b: `cutoverMode` / `canaryAllowlist` are unused here. Runtime auth
 * is only `input.enabled` (BETTER_AUTH_ENABLED). Do not implement ADR shadow.
 */
export function buildBetterAuthConfig(input: BetterAuthConfigInput): BetterAuthConfig | null {
  if (!input.enabled) return null;
  if (input.cookieName !== BETTER_AUTH_COOKIE_NAME) {
    throw new Error('BETTER_AUTH_COOKIE_NAME is frozen to __Host-known_session (single browser session cookie contract)');
  }
  if (input.secret === null || input.secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
  }
  if (input.sessionTokenProtection === null
      || input.sessionTokenProtection === undefined
      || input.sessionTokenProtection.keys.length === 0) {
    throw new Error('BETTER_AUTH_SESSION_TOKEN_KEYS must contain at least one key');
  }
  if (input.sessionUpdateAgeSeconds >= input.sessionExpiresInSeconds) {
    throw new Error('sessionUpdateAgeSeconds must be smaller than sessionExpiresInSeconds');
  }
  if (input.emailOtpEnabled) {
    // C2: frozen G1 §8 OTP policy re-check (length 6, TTL 60..3600s,
    // attempts 1..10) — the env parsing bounds values; this wrapper is the
    // second line of defense for direct construction.
    assertAuthOtpPolicy({
      otpLength: 6,
      expiresInSeconds: input.otpTtlSeconds,
      maxAttempts: input.otpMaxAttempts,
    });
  }
  if (input.socialEnabled && !input.social.google && !input.social.github) {
    // C3: SOCIAL_ENABLED gating — the typed config must carry at least one
    // provider when the capability is on (fail closed, mirror of the env
    // parsing in config.ts; G1 §6).
    throw new Error('BETTER_AUTH_SOCIAL_ENABLED=true requires at least one configured provider');
  }
  if (input.oauthIssuerEnabled && (input.oauthIssuer === undefined || input.oauthIssuer === null)) {
    throw new Error('BETTER_AUTH_OAUTH_ISSUER_ENABLED=true requires MCP_OAUTH_AUDIENCE and MCP_OAUTH_SCOPES');
  }
  const mfa = buildBetterAuthMfaConfig(input.mfa);
  return Object.freeze({
    baseURL: input.baseUrl,
    basePath: input.basePath,
    secret: input.secret,
    sessionTokenProtection: Object.freeze({
      keys: Object.freeze(input.sessionTokenProtection.keys.map((entry) => Object.freeze({
        version: entry.version,
        key: Buffer.from(entry.key),
      }))),
      legacyPlaintextReadUntil: input.sessionTokenProtection.legacyPlaintextReadUntil === null
        ? null
        : new Date(input.sessionTokenProtection.legacyPlaintextReadUntil),
    }),
    trustedOrigins: Object.freeze([...input.trustedOrigins]),
    cookieName: BETTER_AUTH_COOKIE_NAME,
    sessionExpiresInSeconds: input.sessionExpiresInSeconds,
    sessionUpdateAgeSeconds: input.sessionUpdateAgeSeconds,
    bodyLimitBytes: input.bodyLimitBytes,
    emailOtp: input.emailOtpEnabled
      ? Object.freeze({
          enabled: true as const,
          otpLength: 6 as const,
          expiresInSeconds: input.otpTtlSeconds,
          maxAttempts: input.otpMaxAttempts,
        })
      : null,
    social: input.socialEnabled
      ? Object.freeze({
          ...(input.social.google ? { google: Object.freeze({ ...input.social.google }) } : {}),
          ...(input.social.github ? { github: Object.freeze({ ...input.social.github }) } : {}),
        })
      : null,
    passwordHash: Object.freeze({
      hash: (password: string) => argon2.hash(password, BETTER_AUTH_ARGON2ID_PARAMS),
      // Fail-closed verify shared with the infrastructure adapter
      // (malformed/foreign hashes return false, never throw).
      verify: verifyArgon2idHash,
    }),
    mfa,
    oauthIssuer: input.oauthIssuerEnabled && input.oauthIssuer
      ? Object.freeze({
          resource: input.oauthIssuer.resource,
          scopes: withBetterAuthOauthIssuerScopes(input.oauthIssuer.scopes),
          accessTokenExpiresInSeconds: BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
          loginPage: BETTER_AUTH_OAUTH_LOGIN_PAGE,
          consentPage: BETTER_AUTH_OAUTH_CONSENT_PAGE,
          dcrMaxAnonymousClients: input.oauthIssuer.dcrMaxAnonymousClients,
          dcrUnusedClientRetentionSeconds: input.oauthIssuer.dcrUnusedClientRetentionSeconds,
          dcrMaxOwnedClientsPerUser: input.oauthIssuer.dcrMaxOwnedClientsPerUser,
          dcrMaxOwnedClients: input.oauthIssuer.dcrMaxOwnedClients,
        })
      : null,
  });
}

/**
 * C4: MFA settings with frozen library-safe bounds. Every bound is a second
 * line of defense after the env parsing (the config lane) — direct
 * construction with out-of-range values fails closed at build time.
 */
function buildBetterAuthMfaConfig(input: BetterAuthMfaConfigInput | undefined): BetterAuthMfaConfig | null {
  if (input === undefined || !input.enabled) return null;
  const totpDigits = input.totpDigits ?? BETTER_AUTH_MFA_DEFAULTS.totpDigits;
  if (totpDigits !== 6 && totpDigits !== 8) {
    throw new Error('MFA totpDigits must be 6 or 8');
  }
  const totpPeriodSeconds = input.totpPeriodSeconds ?? BETTER_AUTH_MFA_DEFAULTS.totpPeriodSeconds;
  if (!Number.isSafeInteger(totpPeriodSeconds) || totpPeriodSeconds < 15 || totpPeriodSeconds > 300) {
    throw new Error('MFA totpPeriodSeconds must be 15..300');
  }
  const pendingCookieMaxAgeSeconds = input.pendingCookieMaxAgeSeconds
    ?? BETTER_AUTH_MFA_DEFAULTS.pendingCookieMaxAgeSeconds;
  if (!Number.isSafeInteger(pendingCookieMaxAgeSeconds)
      || pendingCookieMaxAgeSeconds < 60 || pendingCookieMaxAgeSeconds > 3_600) {
    throw new Error('MFA pendingCookieMaxAgeSeconds must be 60..3600');
  }
  const backupCodesAmount = input.backupCodesAmount ?? BETTER_AUTH_MFA_DEFAULTS.backupCodesAmount;
  if (!Number.isSafeInteger(backupCodesAmount) || backupCodesAmount < 4 || backupCodesAmount > 20) {
    throw new Error('MFA backupCodesAmount must be 4..20');
  }
  const backupCodesLength = input.backupCodesLength ?? BETTER_AUTH_MFA_DEFAULTS.backupCodesLength;
  if (!Number.isSafeInteger(backupCodesLength) || backupCodesLength < 6 || backupCodesLength > 32) {
    throw new Error('MFA backupCodesLength must be 6..32');
  }
  const trustDeviceMaxAgeSeconds = input.trustDeviceMaxAgeSeconds
    ?? BETTER_AUTH_MFA_DEFAULTS.trustDeviceMaxAgeSeconds;
  if (!Number.isSafeInteger(trustDeviceMaxAgeSeconds)
      || trustDeviceMaxAgeSeconds < 86_400 || trustDeviceMaxAgeSeconds > 2_592_000) {
    throw new Error('MFA trustDeviceMaxAgeSeconds must be 86400..2592000');
  }
  return Object.freeze({
    enabled: true as const,
    totpDigits,
    totpPeriodSeconds,
    pendingCookieMaxAgeSeconds,
    backupCodesAmount,
    backupCodesLength,
    trustDeviceMaxAgeSeconds,
  });
}
