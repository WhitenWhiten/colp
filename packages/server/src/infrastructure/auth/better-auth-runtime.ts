import { applyOAuthOccupancyAdoptToAdapter } from './better-auth-occupancy-adapter.js';
import { ALREADY_REGISTERED_SIGNUP_ERROR, applySignupOtpSendDeliveryToAdapter, completeExplicitSignupEmailOtp } from './better-auth-signup-otp.js';
import { createCimdClientDiscovery, type CimdOptions } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { extendOAuthProvider } from '@better-auth/oauth-provider';
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import { expireCookie } from 'better-auth/cookies';
import { emailOTP, jwt, twoFactor, username } from 'better-auth/plugins';
import { timingSafeEqual } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  AUTH_OTP_MAX_ATTEMPTS,
  authEmailIdempotencyKey,
  isOAuthCallbackPath,
  otpEmailPurpose,
  type AuthOtpType,
  type BusinessAccountUnitOfWork,
} from '../../modules/auth/index.js';
import { canonicalizeSafeReturnTo } from '../../modules/identity/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { deleteTrustDeviceVerificationsForAuthUser } from './better-auth-session-authority.js';
import {
  buildBusinessAccountHooks,
  type BetterAuthRuntimeHooksContext,
} from './better-auth-account-hooks.js';
import { opaqueClientIdGuidance } from './cimd-opaque-client-id-guidance.js';
import { oauthConsentTransaction } from './oauth-consent-transaction.js';
import {
  fetchProductionClientMetadataResource,
  type CimdClientMetadataFetch,
} from './cimd-node-fetch.js';
import {
  dispatchBetterAuthWithLoopbackRedirectContext,
  wrapCimdClientDiscoveryWithLoopbackRedirectVariance,
} from './loopback-redirect-port.js';
import {
  createDcrRegistrationCapacityGuard,
  createPostgresDcrRegistrationReservationStore,
} from './dcr-registration-capacity.js';
import {
  BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES,
  PRODUCT_EMAIL_VERIFICATION_PATH,
  SIGNUP_OTP_INTENT_HEADER,
  SIGNUP_OTP_INTENT_VALUE,
  type BetterAuthInstance,
  type BetterAuthRuntime,
  type BetterAuthRuntimeConfig,
  type BetterAuthRuntimeInput,
} from './better-auth-runtime-contract.js';
import { mountBetterAuthAllowlist } from './better-auth-fastify-bridge.js';
import { createProtectedBetterAuthKyselyAdapter } from './better-auth-protected-kysely-adapter.js';

export {
  BETTER_AUTH_ALLOWLIST,
  BETTER_AUTH_BROWSER_ALLOWLIST,
  BETTER_AUTH_OAUTH_ISSUER_ALLOWLIST,
  BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES,
  PRODUCT_EMAIL_VERIFICATION_PATH,
  SIGNUP_OTP_INTENT_HEADER,
  SIGNUP_OTP_INTENT_VALUE,
  type BetterAuthAllowlistEntry,
  type BetterAuthInstance,
  type BetterAuthRuntime,
  type BetterAuthRuntimeConfig,
  type BetterAuthRuntimeInput,
  type BetterAuthRuntimeMfaConfig,
  type BetterAuthRuntimeOauthIssuerConfig,
  type BetterAuthRuntimeSocialProvider,
} from './better-auth-runtime-contract.js';

export {
  applyFetchResponse,
  fastifyRequestToFetchRequest,
  mountBetterAuthAllowlist,
} from './better-auth-fastify-bridge.js';

/**
 * A1/C2 Better Auth runtime boundary (infrastructure layer).
 *
 * Constructs the Better Auth 1.7.1 instance ONLY when enabled
 * (`createBetterAuthRuntime` returns null in disabled mode, so `betterAuth()`
 * is never called). AUTH-P1-a: this file is the single production constructor;
 * composition shares `runtime.auth` with the session authority and C3
 * `auth.api`. Mounts ONLY the allowlisted `/api/v1/auth` endpoints
 * through the verified Fastify bridge (G0 spike §3.1/§4.6):
 *
 * - body: exact wire bytes buffered under the configured limit before
 *   Fastify parses them, then forwarded with `duplex: 'half'`;
 * - abort: explicit AbortController wired to 'aborted' + socket 'close'
 *   (Node 24 IncomingMessage has no `.signal`);
 * - response: status, headers, multiple `Set-Cookie` appended one-by-one in
 *   order, empty body sent as undefined, body read via `text()`.
 *
 * Unknown paths and wrong methods are rejected by the app-level router /
 * notFoundHandler as stable 404/405 — this mount is never a catch-all.
 *
 * C2 (security contract):
 * - emailAndPassword.hash/verify is the Argon2id hook (never scrypt);
 * - `revokeSessionsOnPasswordReset: true` (spike §3.9/R6);
 * - password change / reset / revokeAll drop 2FA trust-device verification
 *   rows (P5 / Invariant F) so a copied `known.trust_device` cookie cannot
 *   skip TOTP; `allowPasswordless` stays false;
 * - emailOTP is digest-only (`storeOTP: 'hashed'`), TTL/attempts from the
 *   typed config, purpose-separated, resend rotates the code;
 * - emailOTP `disableSignUp: true` (P2): login send/verify never creates a
 *   user; Register OTP create is the explicit signup-intent path;
 * - emailOTP `changeEmail.enabled: true` (P9): request-email-change sends a
 *   change-email OTP to the new mailbox; confirm updates auth_users.email
 *   on the same user id and syncs `accounts.email` (occupied target stays
 *   non-enumerating on send; product write failure fail-closes the confirm);
 * - OTP / verification / reset emails go through the C1 auth email sender
 *   (`authEmail` input; absent => reset/verification report NOT_ENABLED and
 *   OTP stays a no-op, never a claimed send);
 * - business account establishment (A2) runs on the post-commit seams:
 *   user.create.after / session.create.after / afterEmailVerification /
 *   onPasswordReset. BA 1.7.1 runs after-hooks and these option callbacks
 *   OUTSIDE the endpoint transaction (G0 §4.8) and its transaction is
 *   connection-scoped, so a nested unit-of-work could not join it anyway
 *   (a separate connection cannot see the uncommitted auth user row); the
 *   establishment is therefore atomic per se (A2 uow) and self-healing
 *   (idempotent re-run on the next session creation).
 *
 * This file consumes the modules/auth facade ONLY (infrastructure:auth ->
 * module:auth:facade edge); its structural config mirror is pinned to the
 * module-layer BetterAuthConfig by the composition tests.
 *
 * G2: the username plugin is always on. `KNOWN_EDITION=self-hosted` turns
 * email verification, email OTP, and two-factor off and lets sign-up omit
 * email. A before hook on `/sign-up/*` returns 403 `{ code: 'registration_closed' }`
 * once `auth_users` has a row unless `COLP_MULTI_USER=true`.
 * `GET /registration-state` is first-run or closed; multi-user does not open it.
 * Federated/social and generic OAuth callbacks are also refused while the
 * first-run owner slot is empty, because browser redirects cannot carry the
 * operator setup header.
 */
/** Frozen Better Auth table names (G1 §3; spike §4.2; B1 lands the schema). */
const BETTER_AUTH_MODEL_NAMES = Object.freeze({
  user: 'auth_users',
  session: 'auth_sessions',
  account: 'auth_accounts',
  verification: 'auth_verifications',
});

/**
 * C4: two-factor table name (the migration lane lands this additive table;
 * the integration suite creates the identical library-generated shape).
 */
const BETTER_AUTH_TWO_FACTOR_TABLE_NAME = 'auth_two_factor' as const;

/** T-02 will land Kysely migrations; isolated tests use library expand with these names. */
const BETTER_AUTH_OAUTH_MODEL_NAMES = Object.freeze({
  oauthClient: { modelName: 'auth_oauth_client' },
  oauthResource: { modelName: 'auth_oauth_resource' },
  oauthClientResource: { modelName: 'auth_oauth_client_resource' },
  oauthAccessToken: { modelName: 'auth_oauth_access_token' },
  oauthRefreshToken: { modelName: 'auth_oauth_refresh_token' },
  oauthConsent: { modelName: 'auth_oauth_consent' },
  oauthClientAssertion: { modelName: 'auth_oauth_client_assertion' },
});

/**
 * Map the typed config onto the Better Auth 1.7.1 options (minus nothing:
 * this is the complete options object, including the Kysely adapter binding).
 * Exported so the schema fixture and downstream lanes reuse the exact options
 * the runtime constructs.
 */
export function buildBetterAuthOptions<DB>(input: BetterAuthRuntimeInput<DB>): BetterAuthOptions {
  const { config } = input;
  const selfHosted = isSelfHostedEdition();
  const emailDelivery = buildAuthEmailDelivery({
    authEmail: input.authEmail,
    logger: input.logger,
    productOrigin: config.baseURL,
  });
  const productHooks = buildProductAuthHooks({
    onPasswordChanged: input.onPasswordChanged,
    onOAuthOccupancyAdopted: input.onOAuthOccupancyAdopted,
    logger: input.logger,
    otpMaxAttempts: input.config.emailOtp?.maxAttempts,
    db: input.database.db as unknown as Kysely<DatabaseSchema>,
    businessAccount: input.businessAccount,
  });
  const establishment = buildBusinessAccountHooks({
    authEmail: input.authEmail,
    businessAccount: input.businessAccount,
    database: { db: input.database.db as unknown as Kysely<DatabaseSchema> },
    logger: input.logger,
    onPasswordReset: input.onPasswordReset,
    onProviderLinked: input.onProviderLinked,
  });
  return {
    appName: 'known',
    baseURL: config.baseURL,
    basePath: config.basePath,
    secret: config.secret,
    database: createProtectedBetterAuthKyselyAdapter(
      input.database.db as unknown as Kysely<unknown>,
      config.sessionTokenProtection,
    ),
    trustedOrigins: [...config.trustedOrigins],
    advanced: {
      cookiePrefix: 'known',
      // Keep false: flipping useSecureCookies would fight the explicit
      // `__Host-known_session` name (__Host- already requires Secure+Path=/+no Domain).
      useSecureCookies: false,
      // Explicit session_token attributes so HttpOnly / Secure / SameSite=Lax
      // do not depend on Better Auth defaultCookieAttributes merge.
      // Match transport/session-cookie.ts (HttpOnly; Secure; SameSite=Lax).
      //
      // Better Auth still sees the library's plaintext token contract, while
      // the protected Kysely adapter encrypts the DB column and uses a keyed
      // lookup field. The browser cookie remains HMAC-signed with
      // BETTER_AUTH_SECRET and `__Host-` prefixed.
      cookies: {
        session_token: {
          name: config.cookieName,
          attributes: {
            httpOnly: true,
            // `__Host-known_session` requires Secure. `known_session` (G3
            // insecure HTTP) must not be Secure or browsers drop it.
            secure: config.cookieName !== 'known_session',
            sameSite: 'Lax',
          },
        },
      },
      defaultCookieAttributes: { secure: config.cookieName !== 'known_session' },
      // G1 §9: trustedOrigins validation must be active in EVERY environment.
      // better-auth 1.7.1 defaults skipOriginCheck=true under NODE_ENV=test;
      // the explicit override keeps the production CSRF/origin contract in
      // test environments (disableOriginCheck=false enables, never disables).
      disableOriginCheck: false,
    },
    session: {
      expiresIn: config.sessionExpiresInSeconds,
      updateAge: config.sessionUpdateAgeSeconds,
      cookieCache: { enabled: false },
      modelName: BETTER_AUTH_MODEL_NAMES.session,
      additionalFields: {
        tokenLookupHash: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
          unique: true,
          fieldName: 'tokenLookupHash',
        },
      },
    },
    user: { modelName: BETTER_AUTH_MODEL_NAMES.user },
    account: {
      modelName: BETTER_AUTH_MODEL_NAMES.account,
      // G1/contract: implicit same-email linking stays disabled.
      accountLinking: { disableImplicitLinking: true },
    },
    verification: {
      modelName: BETTER_AUTH_MODEL_NAMES.verification,
      // G1 §8 / spike R7: digest-only storage MUST be explicit (default plaintext).
      storeIdentifier: 'hashed',
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // P1: occupancy is not a product actor. Unverified password sign-up
      // still creates the user + credential + sends mail (sendOnSignUp) but
      // skips auto sign-in; unverified password sign-in returns BA
      // EMAIL_NOT_VERIFIED (wire verification_required).
      // G2 self-hosted: email is optional and unverified, so sign-up may
      // create a session immediately.
      requireEmailVerification: selfHosted ? false : true,
      // G1 §2 / spike §4.4: Argon2id hook (never the default scrypt).
      password: {
        hash: config.passwordHash.hash,
        verify: config.passwordHash.verify,
      },
      // G1 §8 / spike §3.9 (R6): password reset MUST revoke every existing
      // session — the better-auth default keeps them, so this is explicit.
      revokeSessionsOnPasswordReset: true,
      // Reset email through the C1 sender; absent sender => the endpoint
      // reports RESET_PASSWORD_DISABLED (fail closed, never a claimed send).
      ...(emailDelivery.sendResetPassword !== null
        ? { sendResetPassword: emailDelivery.sendResetPassword }
        : {}),
      ...(establishment.onPasswordReset !== null
        ? { onPasswordReset: establishment.onPasswordReset }
        : {}),
    },
    emailVerification: {
      // C2: the verification email goes out at registration (plan §4.3.1.3)
      // and sign-in never re-sends it (no verification spam).
      // Self-hosted sign-up does not send one (email may be absent).
      sendOnSignUp: selfHosted ? false : true,
      sendOnSignIn: false,
      // P1: after the mailbox proof, mint a session so Congratulations +
      // Continue works. Library / mutations still refuse unverified occupancy.
      autoSignInAfterVerification: true,
      // Verification email through the C1 sender; absent sender =>
      // /send-verification-email reports VERIFICATION_EMAIL_NOT_ENABLED.
      ...(emailDelivery.sendVerificationEmail !== null
        ? { sendVerificationEmail: emailDelivery.sendVerificationEmail }
        : {}),
      ...(establishment.afterEmailVerification !== null
        ? { afterEmailVerification: establishment.afterEmailVerification }
        : {}),
    },
    hooks: productHooks,
    ...(config.social ? { socialProviders: config.social } : {}),
    ...((establishment.userCreateAfter !== null || establishment.sessionCreateAfter !== null
        || establishment.accountCreateAfter !== null)
      ? {
          databaseHooks: {
            ...(establishment.userCreateAfter !== null ? { user: { create: { after: establishment.userCreateAfter } } } : {}),
            ...(establishment.sessionCreateAfter !== null ? { session: { create: { after: establishment.sessionCreateAfter } } } : {}),
            ...(establishment.accountCreateAfter !== null
              ? { account: { create: { after: establishment.accountCreateAfter } } }
              : {}),
          },
        }
      : {}),
    plugins: [
      username({ displayUsername: false }),
      colpRegistrationStatePlugin(),
      ...(!selfHosted && config.emailOtp
        ? [
            emailOTP({
              otpLength: config.emailOtp.otpLength,
              expiresIn: config.emailOtp.expiresInSeconds,
              // G1 §8 / spike R7: digest-only OTP storage (default plaintext).
              storeOTP: 'hashed',
              allowedAttempts: config.emailOtp.maxAttempts,
              // C2: resend ROTATES the code. The plugin's "reuse" strategy is
              // impossible with hashed storage anyway (falls back to rotate per
              // the plugin contract), so the rotation is pinned explicitly.
              resendStrategy: 'rotate',
              // P2: login OTP must never create users (BA default is false:
              // unknown email + code silently signs up). Register keeps an
              // explicit create path via X-Known-Auth-Intent: sign-up.
              disableSignUp: true,
              // P9: OTP email-change (BA default is disabled). Session
              // (sensitiveSessionMiddleware) is the reauth; OTP to the new
              // address is mailbox proof. Do not set verifyCurrentEmail.
              changeEmail: { enabled: true },
              // OTP email through the C1 sender; absent sender => no-op
              // (the OTP row still exists; delivery is never claimed).
              sendVerificationOTP: emailDelivery.sendVerificationOTP,
            }),
          ]
        : []),
      ...(!selfHosted && config.mfa
        ? [
            // C4: two-factor TOTP plugin (G0 §4/G1 contract). The library
            // contract stores the TOTP secret AND the backup codes encrypted
            // at rest with the BA secret (`symmetricEncrypt` /
            // `storeBackupCodes: 'encrypted'`), the backup codes are shown
            // only in the enable/generate responses, the used code is
            // CAS-removed (single use), and the server-only view endpoint is
            // never mounted over HTTP. Account lockout caps consecutive
            // failed second-factor verifications (defaults: 10 / 15min).
            twoFactor({
              twoFactorTable: BETTER_AUTH_TWO_FACTOR_TABLE_NAME,
              // Password re-auth is REQUIRED for enable/disable/get-uri/regenerate
              // (a credential account exists — allowPasswordless would weaken it).
              allowPasswordless: false,
              twoFactorCookieMaxAge: config.mfa.pendingCookieMaxAgeSeconds,
              trustDeviceMaxAge: config.mfa.trustDeviceMaxAgeSeconds,
              totpOptions: {
                digits: config.mfa.totpDigits,
                period: config.mfa.totpPeriodSeconds,
                backupCodes: {
                  amount: config.mfa.backupCodesAmount,
                  length: config.mfa.backupCodesLength,
                  storeBackupCodes: 'encrypted',
                },
              },
              backupCodeOptions: {
                amount: config.mfa.backupCodesAmount,
                length: config.mfa.backupCodesLength,
                storeBackupCodes: 'encrypted',
              },
              accountLockout: {
                enabled: true,
                maxFailedAttempts: 10,
                durationSeconds: 900,
              },
            }),
          ]
        : []),
      ...testOnlyGenericOAuthPlugins(input.testGenericOAuth),
      ...oauthIssuerPlugins(config.oauthIssuer, input.testFetchClientMetadataResource, input.database.db as unknown as Kysely<DatabaseSchema>),
    ],
  };
}

function mcpIssuerResourceIdentifiers(strictResource: string): readonly string[] {
  const url = new URL(strictResource);
  const compat = `${url.origin}/collections/-/mcp-compat`;
  if (compat === strictResource) return Object.freeze([strictResource]);
  return Object.freeze([strictResource, compat]);
}

function oauthIssuerPlugins(
  issuer: BetterAuthRuntimeConfig['oauthIssuer'],
  testFetch?: BetterAuthRuntimeInput<never>['testFetchClientMetadataResource'],
  db?: Kysely<DatabaseSchema>,
): NonNullable<BetterAuthOptions['plugins']> {
  if (issuer === undefined || issuer === null) return [];
  return [
    jwt({
      jwks: { keyPairConfig: { alg: 'RS256' } },
      disableSettingJwtHeader: true,
      disabledPaths: ['/token'],
      schema: { jwks: { modelName: 'auth_jwks' } },
    } as Parameters<typeof jwt>[0]),
    mcp({
      loginPage: issuer.loginPage,
      consentPage: issuer.consentPage,
      resource: issuer.resource,
      resources: [...mcpIssuerResourceIdentifiers(issuer.resource)],
      clientRegistrationDefaultResources: [...mcpIssuerResourceIdentifiers(issuer.resource)],
      enforcePerClientResources: false,
      scopes: [...issuer.scopes],
      accessTokenExpiresIn: issuer.accessTokenExpiresInSeconds,
      async customAccessTokenClaims({ user }) {
        if (!db || !user) throw new Error('OAuth token issuance requires authoritative account epoch');
        const account = await db.selectFrom('accounts as a')
          .innerJoin('auth_user_account_map as m', 'm.account_id', 'a.id')
          .select(['a.security_epoch', 'a.status']).where('m.auth_user_id', '=', user.id).executeTakeFirst();
        if (!account || account.status !== 'active') throw new Error('OAuth account is not active');
        const incident = (await sql<{ epoch: string }>`select epoch from mcp_oauth_security_epoch where id = 1`.execute(db)).rows[0];
        if (!incident) throw new Error('OAuth incident epoch is unavailable');
        return { known_account_epoch: account.security_epoch.toString(), known_incident_epoch: incident.epoch };
      },
      grantTypes: [...BETTER_AUTH_OAUTH_ISSUER_GRANT_TYPES],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      schema: BETTER_AUTH_OAUTH_MODEL_NAMES,
    }),
    loopbackAwareCimd({
      fetchClientMetadataResource: testOnlyCimdFetch(testFetch),
      metadataProfile: 'mcp-2026-07-28',
    }),
    // MCP-U-05: unknown non-CIMD client_id strings get the real requirement
    // instead of the misleading `client_id is required`.
    opaqueClientIdGuidance(),
    oauthConsentTransaction(),
  ];
}

function loopbackAwareCimd(options: CimdOptions): BetterAuthPlugin {
  const clientDiscovery = wrapCimdClientDiscoveryWithLoopbackRedirectVariance(
    createCimdClientDiscovery(options),
  );
  return {
    id: 'cimd',
    init(ctx) {
      extendOAuthProvider(ctx, { clientDiscovery });
    },
  };
}

/**
 * Production CIMD transport is the hardened-egress wrapper (Node 22 lookup +
 * IPv4 pin). A test inject is honored only under NODE_ENV=test; anywhere else
 * a provided hook is a startup refusal (never a silent ignore).
 */
function testOnlyCimdFetch(
  fetchImpl: BetterAuthRuntimeInput<never>['testFetchClientMetadataResource'],
): CimdClientMetadataFetch {
  if (fetchImpl === undefined) return fetchProductionClientMetadataResource;
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('testFetchClientMetadataResource is only honored when NODE_ENV=test');
  }
  return fetchImpl;
}

/**
 * Production plugins stay the allowlisted emailOTP / two-factor set.
 * `testGenericOAuth` is honored only under NODE_ENV=test; anywhere else a
 * provided hook is a startup refusal (never a silent ignore).
 */
function testOnlyGenericOAuthPlugins(
  plugin: BetterAuthRuntimeInput<never>['testGenericOAuth'],
): NonNullable<BetterAuthOptions['plugins']> {
  if (plugin === undefined) return [];
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('testGenericOAuth is only honored when NODE_ENV=test');
  }
  return [plugin];
}

/** C1 auth email delivery wiring for the BA email callbacks. */
function buildAuthEmailDelivery(input: BetterAuthRuntimeHooksContext) {
  const sender = input.authEmail;
  return {
    sendVerificationOTP: async ({ email, otp, type }: {
      readonly email: string;
      readonly otp: string;
      readonly type: AuthOtpType;
    }): Promise<void> => {
      if (sender === undefined) return;
      await sender.sendAuthEmail({
        // Each BA OTP type maps to its own C1 OTP template via otpEmailPurpose;
        // the type still enters the digest-only idempotency key so each
        // purpose/recipient pair has its own stable provider key.
        purpose: otpEmailPurpose(type),
        to: email,
        templateData: { otp },
        idempotencyKey: authEmailIdempotencyKey(`otp:${type}`, email),
      });
    },
    sendVerificationEmail: sender === undefined
      ? null
      : async ({ user, url }: { readonly user: { readonly email: string }; readonly url: string }): Promise<void> => {
          const verificationUrl = input.productOrigin === undefined
            ? url
            : rewriteAuthEmailVerificationUrl(url, input.productOrigin);
          await sender.sendAuthEmail({
            purpose: 'email-verification',
            to: user.email,
            templateData: { verificationUrl },
            idempotencyKey: authEmailIdempotencyKey('email-verification', user.email),
          });
        },
    sendResetPassword: sender === undefined
      ? null
      : async ({ user, url }: { readonly user: { readonly email: string }; readonly url: string }): Promise<void> => {
          await sender.sendAuthEmail({
            purpose: 'password-reset',
            to: user.email,
            templateData: { resetUrl: url },
            idempotencyKey: authEmailIdempotencyKey('password-reset', user.email),
          });
        },
  };
}

/**
 * Rewrite Better Auth's API verification URL
 * (`{origin}{basePath}/verify-email?token=&callbackURL=`) onto the product
 * `/verify-email` page so the browser shows the congratulations UI instead
 * of following BA's 302 into Library.
 */
export function rewriteAuthEmailVerificationUrl(baUrl: string, productOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baUrl);
  } catch {
    return baUrl;
  }
  const token = parsed.searchParams.get('token');
  if (token === null || token.length === 0) return baUrl;
  const dest = new URL(PRODUCT_EMAIL_VERIFICATION_PATH, productOrigin);
  dest.searchParams.set('token', token);
  const callbackURL = parsed.searchParams.get('callbackURL');
  if (callbackURL !== null && callbackURL.length > 0) {
    const returnTo = productReturnToFromCallback(callbackURL, productOrigin);
    if (returnTo !== null) dest.searchParams.set('returnTo', returnTo);
  }
  return dest.toString();
}

function productReturnToFromCallback(callbackURL: string, productOrigin: string): string | null {
  const path = canonicalizeSafeReturnTo(callbackURL, productOrigin);
  if (path === null) return null;
  if (!path.startsWith(PRODUCT_EMAIL_VERIFICATION_PATH)) return path;
  try {
    const nested = new URL(path, productOrigin).searchParams.get('returnTo');
    if (nested === null || nested.length === 0) return null;
    return canonicalizeSafeReturnTo(nested, productOrigin);
  } catch {
    return null;
  }
}

function headerValue(
  ctx: { readonly headers?: Headers; readonly request?: Request },
  name: string,
): string | null {
  const fromCtx = ctx.headers?.get(name);
  if (typeof fromCtx === 'string' && fromCtx.length > 0) return fromCtx;
  const fromRequest = ctx.request?.headers.get(name);
  return typeof fromRequest === 'string' && fromRequest.length > 0 ? fromRequest : null;
}

function isSelfHostedEdition(): boolean {
  return process.env.KNOWN_EDITION === 'self-hosted';
}

/**
 * `COLP_MULTI_USER=true` is the only value that skips the single-owner gate.
 * The self-hosted preset refuses it until invite codes ship (0.3.0, D27), so
 * only test suites reach this branch.
 */
function isColpMultiUser(): boolean {
  return process.env.COLP_MULTI_USER === 'true';
}

/** Header that carries the first-run setup token (D27). */
export const COLP_SETUP_TOKEN_HEADER = 'colp-setup-token';

/**
 * The first self-hosted sign-up must present the setup token the preset
 * derives from COLP_SERVER_SECRET. Whoever reaches a fresh public origin first
 * cannot claim the owner account without access to the server's log or shell.
 */
function setupTokenMatches(presented: string | null): boolean {
  const expected = process.env.COLP_SETUP_TOKEN?.trim() ?? '';
  if (expected === '' || presented === null) return false;
  const left = Buffer.from(presented.trim(), 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Federated sign-in is deliberately closed on a pristine self-hosted
 * instance.  Unlike `/sign-up/email`, a provider callback is a browser
 * redirect and cannot carry the operator's setup header, so accepting the
 * first social/OIDC callback would let whoever reaches the public origin
 * first become the owner.  The operator must create the first local owner
 * with the setup token; federated sign-in becomes available after that user
 * row exists.
 */
function isFirstOwnerFederatedAuthPath(path: string | undefined): boolean {
  return path === '/sign-in/social'
    || path === '/sign-in/oauth2'
    || isOAuthCallbackPath(path);
}

/**
 * Self-hosted sign-up may omit email. Better Auth's sign-up body still
 * requires an email string, so a missing one is filled from the username
 * before the endpoint schema runs. A supplied email is left unchanged.
 */
function fillSelfHostedOptionalSignupEmail(body: unknown): void {
  if (!isSelfHostedEdition()) return;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const record = body as { email?: unknown; username?: unknown; name?: unknown };
  if (typeof record.email === 'string' && record.email.trim().length > 0) return;
  if (typeof record.username !== 'string' || record.username.trim().length === 0) return;
  const normalized = record.username.trim().toLowerCase();
  record.email = `${normalized}@users.invalid`;
  if (typeof record.name !== 'string' || record.name.trim().length === 0) {
    record.name = record.username.trim();
  }
}

/** First-run page: open only while `auth_users` is empty. Invite is unused. */
function colpRegistrationStatePlugin(): BetterAuthPlugin {
  return {
    id: 'colp-registration-state',
    endpoints: {
      getRegistrationState: createAuthEndpoint('/registration-state', {
        method: 'GET',
      }, async (ctx) => {
        const existingUsers = await ctx.context.adapter.count({ model: 'user' });
        if (existingUsers === 0) return { open: true, reason: 'first-run' as const };
        return { open: false, reason: 'closed' as const };
      }),
    },
  };
}

function buildProductAuthHooks(input: {
  readonly onPasswordChanged?: BetterAuthRuntimeInput<never>['onPasswordChanged'];
  readonly onOAuthOccupancyAdopted?: BetterAuthRuntimeInput<never>['onOAuthOccupancyAdopted'];
  readonly logger?: BetterAuthRuntimeInput<never>['logger'];
  readonly otpMaxAttempts?: number;
  readonly db?: Kysely<DatabaseSchema>;
  readonly businessAccount?: { readonly unitOfWork: BusinessAccountUnitOfWork };
}): {
  readonly before: ReturnType<typeof createAuthMiddleware>;
  readonly after: ReturnType<typeof createAuthMiddleware>;
} {
  const otpMaxAttempts = input.otpMaxAttempts ?? AUTH_OTP_MAX_ATTEMPTS;
  const establishment: BetterAuthRuntimeHooksContext = {
    businessAccount: input.businessAccount,
    database: input.db !== undefined ? { db: input.db } : undefined,
    logger: input.logger,
  };
  return {
    before: createAuthMiddleware(async (ctx) => {
      // Better Auth's OAuth authorize endpoint authenticates the browser
      // session itself, but the product authority also tracks revocation and
      // security-epoch state in known_auth_session_metadata. Re-check that
      // authoritative row before issuing an authorization code so a cookie
      // accepted by BA cannot survive product-side session revocation.
      if (ctx.path === '/oauth2/authorize' && input.db !== undefined) {
        // User before hooks run before the OAuth endpoint loads its session.
        const session = await getAuthoritativeSessionFromCtx(ctx);
        const candidate = session?.session.id;
        // The session id is the binding between Better Auth's cookie and the
        // product revocation/epoch table. If the hook context does not expose
        // it, fail closed instead of silently bypassing the authoritative
        // session check.
        if (typeof candidate !== 'string' || candidate.length === 0) {
          throw APIError.from('UNAUTHORIZED', {
            code: 'session_context_unavailable',
            message: 'The browser session could not be verified.',
          });
        }
        {
          const row = await input.db.selectFrom('known_auth_session_metadata')
            .select(['revoked_at', 'security_epoch', 'account_id'])
            .where('auth_session_id', '=', candidate)
            .executeTakeFirst();
          if (!row || row.revoked_at !== null) {
            throw APIError.from('UNAUTHORIZED', {
              code: 'session_revoked', message: 'The browser session is no longer valid.',
            });
          }
          const account = await input.db.selectFrom('accounts').select(['security_epoch', 'status'])
            .where('id', '=', row.account_id).executeTakeFirst();
          if (!account || account.status !== 'active'
              || BigInt(account.security_epoch) !== BigInt(row.security_epoch)) {
            throw APIError.from('UNAUTHORIZED', {
              code: 'session_revoked', message: 'The browser session is no longer valid.',
            });
          }
        }
      }
      // OAuth Provider 1.7.1 dispatches registered backchannel logout URIs
      // with the process-global fetch.  It has no egress injection seam, so
      // accepting that metadata would leave a DNS-rebinding SSRF primitive in
      // the session-delete hook.  Backchannel logout is deliberately disabled
      // for this issuer; the database migration also clears legacy values and
      // installs a write-time CHECK so direct adapter writes cannot re-enable it.
      if (isOAuthBackchannelLogoutMutation(ctx.path, ctx.body)) {
        throw APIError.from('BAD_REQUEST', {
          code: 'oauth_backchannel_logout_disabled',
          message: 'OAuth backchannel logout callbacks are not supported.',
        });
      }
      if (isSelfHostedEdition() && !isColpMultiUser()
          && isFirstOwnerFederatedAuthPath(ctx.path)) {
        const existingUsers = await ctx.context.adapter.count({ model: 'user' });
        if (existingUsers === 0) {
          throw APIError.from('FORBIDDEN', {
            code: 'setup_token_required',
            message: 'Create the first local owner with the setup token before using federated sign-in.',
          });
        }
      }
      if (typeof ctx.path === 'string' && ctx.path.startsWith('/sign-up/')) {
        if (ctx.path === '/sign-up/email') fillSelfHostedOptionalSignupEmail(ctx.body);
        const existingUsers = await ctx.context.adapter.count({ model: 'user' });
        if (!isColpMultiUser() && existingUsers > 0) {
          throw APIError.from('FORBIDDEN', {
            code: 'registration_closed',
            message: 'Registration is closed.',
          });
        }
        if (isSelfHostedEdition() && existingUsers === 0
            && !setupTokenMatches(headerValue(ctx, COLP_SETUP_TOKEN_HEADER))) {
          throw APIError.from('FORBIDDEN', {
            code: 'setup_token_required',
            message: 'Enter the setup token from the server log (docker compose logs server), '
              + 'or run: docker compose exec server colp-server setup-token',
          });
        }
      }
      if (isOAuthCallbackPath(ctx.path)) {
        applyOAuthOccupancyAdoptToAdapter(ctx.context, input.onOAuthOccupancyAdopted);
      }
      if (ctx.path === '/change-password' && ctx.body !== null && typeof ctx.body === 'object') {
        (ctx.body as { revokeOtherSessions?: boolean }).revokeOtherSessions = true;
      }
      const signupIntent = headerValue(ctx, SIGNUP_OTP_INTENT_HEADER) === SIGNUP_OTP_INTENT_VALUE;
      if (ctx.path === '/sign-in/email-otp' && signupIntent) {
        return completeExplicitSignupEmailOtp(ctx, otpMaxAttempts);
      }
      if (ctx.path !== '/email-otp/send-verification-otp') return;
      // P6: Register already-registered copy is an accepted enumeration oracle.
      // Login omits this header and must stay non-enumerating (byte-identical
      // 200). auth-local-flows pins both sides of the split.
      if (!signupIntent) return;
      const body = ctx.body as { email?: unknown; type?: unknown } | undefined;
      if (body?.type !== 'sign-in' || typeof body.email !== 'string' || body.email.length === 0) {
        return;
      }
      const email = body.email.trim().toLowerCase();
      const existing = await ctx.context.internalAdapter.findUserByEmail(email);
      if (existing?.user) {
        throw APIError.from('UNPROCESSABLE_ENTITY', ALREADY_REGISTERED_SIGNUP_ERROR);
      }
      // P2: emailOTP disableSignUp skips delivery for unknown mailboxes.
      // Register send still needs the OTP minted and delivered; occupancy
      // stays at verify (dummy user is request-scoped, never persisted).
      applySignupOtpSendDeliveryToAdapter(ctx.context);
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/change-password') return;
      try {
        expireCookie(ctx, ctx.context.createAuthCookie('trust_device', { maxAge: 0 }));
      } catch (error) {
        input.logger?.warn(
          {
            classification: 'trust_device_cookie_expire_failed',
            ...(error instanceof Error ? { name: error.name } : {}),
          },
          'trust-device cookie expire failed; the password is already changed',
        );
      }
      const successor = ctx.context.newSession;
      const authUserId = successor?.user?.id;
      const currentAuthSessionId = successor?.session?.id;
      if (typeof authUserId === 'string' && authUserId.length > 0 && input.db !== undefined) {
        try {
          await deleteTrustDeviceVerificationsForAuthUser(input.db, authUserId);
        } catch (error) {
          input.logger?.warn(
            {
              classification: 'trust_device_clear_failed',
              ...(error instanceof Error ? { name: error.name } : {}),
            },
            'trust-device clear failed; the password is already changed',
          );
        }
      }
      const onPasswordChanged = input.onPasswordChanged;
      if (onPasswordChanged === undefined) return;
      if (typeof authUserId !== 'string' || authUserId.length === 0
          || typeof currentAuthSessionId !== 'string' || currentAuthSessionId.length === 0) {
        return;
      }
      try {
        await onPasswordChanged({ authUserId, currentAuthSessionId });
      } catch (error) {
        input.logger?.warn(
          {
            classification: 'password_change_session_revoke_failed',
            ...(error instanceof Error ? { name: error.name } : {}),
          },
          'password-change session revoke failed; the password is already changed',
        );
      }
    }),
  };
}

const OAUTH_BACKCHANNEL_LOGOUT_MUTATION_PATHS = new Set([
  '/oauth2/register',
  '/oauth2/create-client',
  '/oauth2/update-client',
  '/admin/oauth2/create-client',
  '/admin/oauth2/update-client',
]);

/** Reject every HTTP write path that could persist a backchannel callback. */
function isOAuthBackchannelLogoutMutation(path: unknown, body: unknown): boolean {
  if (typeof path !== 'string' || !OAUTH_BACKCHANNEL_LOGOUT_MUTATION_PATHS.has(path)) return false;
  if (body === null || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  const update = record.update;
  const candidate = update !== null && typeof update === 'object'
    ? update as Record<string, unknown>
    : record;
  return Object.hasOwn(candidate, 'backchannel_logout_uri')
    || Object.hasOwn(candidate, 'backchannel_logout_session_required');
}


/**
 * Construct the Better Auth runtime. Returns `null` when disabled — the
 * `betterAuth()` constructor is never invoked in that state (zero-registration
 * contract; the composition tests spy on the constructor).
 *
 * AUTH-P1-a: this is the single production `betterAuth(buildBetterAuthOptions`
 * site. `composeBetterAuthComposition` shares `runtime.auth` with the session
 * authority and C3 `auth.api` — callers must not construct a second instance.
 */
export function createBetterAuthRuntime<DB>(
  input: BetterAuthRuntimeInput<DB>,
): BetterAuthRuntime | null {
  if (!input.enabled) return null;
  const auth = betterAuth(buildBetterAuthOptions(input));
  const dcrCapacityGuard = input.config.oauthIssuer
    ? createDcrRegistrationCapacityGuard(createPostgresDcrRegistrationReservationStore({
        db: input.database.db,
        maxAnonymousClients: input.config.oauthIssuer.dcrMaxAnonymousClients,
        unusedClientRetentionSeconds: input.config.oauthIssuer.dcrUnusedClientRetentionSeconds,
        maxOwnedClientsPerUser: input.config.oauthIssuer.dcrMaxOwnedClientsPerUser,
        maxOwnedClients: input.config.oauthIssuer.dcrMaxOwnedClients,
      }), { metrics: input.metrics })
    : undefined;
  return {
    mount(app) {
      mountBetterAuthAllowlist(app, auth, input.config, dcrCapacityGuard, input.metrics);
    },
    handle(request) {
      return dispatchBetterAuthWithLoopbackRedirectContext(request, async (next) => {
        const response = await auth.handler(next);
        return redactDisabledOAuthBackchannelMetadata(response, next.url, input.config.basePath);
      });
    },
    auth,
  };
}

/**
 * Better Auth 1.7.1 derives these two fields from `disableJwtPlugin` and has
 * no option to override them independently.  This runtime intentionally keeps
 * JWT access tokens for MCP, while the application rejects backchannel callback
 * registration and the migration forbids stored targets.  Keep discovery
 * honest so clients do not retry an unsupported callback capability.
 */
export async function redactDisabledOAuthBackchannelMetadata(
  response: Response,
  requestUrl: string,
  basePath: string,
): Promise<Response> {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return response;
  }
  if (pathname !== `/.well-known/oauth-authorization-server${basePath}`) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) return response;
  let metadata: unknown;
  try {
    metadata = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return response;
  const body = {
    ...(metadata as Record<string, unknown>),
    backchannel_logout_supported: false,
    backchannel_logout_session_supported: false,
  };
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
