/**
 * Legacy OIDC start/callback helpers and registration (Task F1 quarantine).
 * Source retention is NOT runtime enablement. Better Auth mode never
 * registers these routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DatabaseOperationError } from '../../infrastructure/database/errors.js';
import {
  authenticateSession,
  consumeOidcLoginTransaction,
  createOidcLoginTransaction,
  createSession,
  ensureAccountFromOidcIdentity,
  revokeSession,
} from '../../modules/identity/index.js';
import { IdentityError } from '../../modules/identity/index.js';
import {
  OidcExchangeError,
  createOidcProvider,
  pkceS256Challenge,
  type OidcProviderPort,
} from './oidc-provider.js';
import { resolveBrowserReturnTo } from './origin-csrf.js';
import { productRouteMetadata } from '../product-route-manifest.js';
import { hasCode } from '../product-codes.js';
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../session-cookie.js';
import type { BrowserAuthDeps } from './browser-auth-deps.js';

/** Terminal denial / security failure — user must not replay the callback. */
const AUTH_FAILED_LOCATION = '/login?auth=failed';
/**
 * Non-replayable recovery: authorization code and/or OIDC TX were already
 * consumed, so the only safe path is a brand-new login (never re-POST the code).
 */
const AUTH_RESTART_LOCATION = '/login?auth=restart';
export const FIXED_DASHBOARD = '/';
const OIDC_BROWSER_STATE_COOKIE = '__Host-known_oidc_state';
const OIDC_BROWSER_STATE_COOKIE_INSECURE = 'known_oidc_state';

/** Callback stages used for failure classification.
 * @deprecated Legacy OIDC callback flow (Task F1 quarantine).
 */
export type OidcCallbackStage = 'pre_exchange' | 'post_exchange';

/**
 * Stable failure classes for logs (no provider text, secrets, or code/state).
 * - pre_exchange: failed before verified claims were obtained
 * - post_exchange: verified claims obtained; local identity/session work failed
 * - transient_local: local DB transient after exchange (still non-replayable)
 * - terminal: permanent denial / invalid grant / replay / bad callback shape
 *
 * @deprecated Legacy OIDC callback flow (Task F1 quarantine).
 */
export type OidcCallbackFailureClass =
  | 'pre_exchange'
  | 'post_exchange'
  | 'transient_local'
  | 'terminal';

/** @deprecated Legacy OIDC callback flow (Task F1 quarantine). */
export type OidcAuthRedirectKind = 'failed' | 'restart';

/** @deprecated Legacy OIDC callback flow (Task F1 quarantine). */
export interface ClassifiedOidcCallbackFailure {
  readonly class: OidcCallbackFailureClass;
  readonly reason: string;
  readonly redirect: OidcAuthRedirectKind;
  readonly stage: OidcCallbackStage;
}

/**
 * Wraps a callback error with the stage at which it occurred so the route
 * handler can choose auth=failed vs auth=restart without inspecting secrets.
 *
 * @deprecated Legacy OIDC callback flow (Task F1 quarantine).
 */
export class OidcCallbackStageError extends Error {
  readonly stage: OidcCallbackStage;
  readonly causeError: unknown;

  constructor(stage: OidcCallbackStage, causeError: unknown) {
    const reason = classifyAuthFailure(causeError, stage).reason;
    super(`OIDC callback failed at ${stage}: ${reason}`);
    this.name = 'OidcCallbackStageError';
    this.stage = stage;
    this.causeError = causeError;
  }
}

/** OIDC exchange reasons that are permanent denials (do not invite a silent restart loop). */
const TERMINAL_EXCHANGE_REASONS = new Set([
  'invalid_callback_shape',
  'invalid_issuer',
  'provider_error',
  'invalid_code',
  'invalid_grant',
  'invalid_nonce',
  'invalid_pkce',
  'invalid_audience',
  'missing_id_token',
  'missing_subject',
  'invalid_id_token',
  'invalid_signature',
  'disallowed_algorithm',
  'jwks_required',
]);

/** Identity policy failures that restarting OIDC will not fix without claim changes. */
const TERMINAL_IDENTITY_CODES = new Set([
  'email_unverified',
  'email_conflict',
  'account_disabled',
  'account_deleted',
  'invalid_email',
  'invalid_identity_input',
  'invalid_display_name',
  'invalid_about',
  'invalid_handle',
  'invalid_return_to',
  'transaction_not_found',
  'transaction_consumed',
  'transaction_expired',
]);

/** Transient OIDC exchange reasons after TX consume — restart a new login. */
const RESTARTABLE_EXCHANGE_REASONS = new Set([
  'token_endpoint_error',
  'id_token_verification_failed',
]);

export function registerLegacyOidcRoutes(app: FastifyInstance, deps: BrowserAuthDeps): void {
  // --- LEGACY OIDC branch (Task F1 quarantine; removal owned by Task F2) ---
  // F2: Better Auth mode removes the legacy OIDC start/callback routes from
  // the runtime composition (route absence is an acceptance gate) and never
  // constructs the legacy OIDC provider. Legacy mode keeps both registered
  // exactly as before (rollback semantics); F3 removes the manifest families.
  if (!deps.config.betterAuth.enabled) {
    const oidc = deps.oidcProvider ?? createOidcProvider(deps.config.oidc);
    const uow = deps.identityUnitOfWork;
    app.get('/api/v1/auth/oidc/start', {
      config: {
        ...productRouteMetadata('GET', '/api/v1/auth/oidc/start'),
        productTransport: {
          allowedQuery: ['returnTo'],
          cacheControl: 'no-store',
        },
      },
    }, async (request, reply) => {
      const query = request.query as { returnTo?: string };
      const returnTo = resolveBrowserReturnTo(query.returnTo, deps.config.productOrigin, FIXED_DASHBOARD);
      const started = await uow.execute((ports) =>
        createOidcLoginTransaction(ports, { returnTo }));
      const codeChallenge = pkceS256Challenge(started.codeVerifier);
      const location = oidc.buildAuthorizationUrl({
        state: started.transaction.state,
        nonce: started.transaction.nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      });
      return reply
        .code(302)
        .header('Cache-Control', 'no-store')
        // Bind the transaction to the browser that initiated it. Without a
        // browser-held state proof an attacker can start OIDC in their own
        // session and deliver the callback to a victim (login CSRF/session
        // swapping), even though state is valid in the database.
        .header('Set-Cookie', oidcBrowserStateCookieHeader(
          deps.config.productOrigin.startsWith('https://'),
          started.transaction.state,
        ))
        .header('Location', location)
        .send();
    });

    app.get('/api/v1/auth/oidc/callback', {
      config: {
        ...productRouteMetadata('GET', '/api/v1/auth/oidc/callback'),
        productTransport: {
          allowedQuery: [
            'code', 'state', 'error', 'iss', 'session_state',
            'error_description', 'error_uri',
          ],
          cacheControl: 'no-store',
        },
      },
    }, async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      try {
        await completeOidcCallback(request, reply, deps, oidc, query);
      } catch (error: unknown) {
        const classified = classifyOidcCallbackFailure(error);
        request.log.warn(
          {
            authFailure: classified.reason,
            authFailureClass: classified.class,
            authFailureStage: classified.stage,
            authRedirect: classified.redirect,
            requestId: request.id,
          },
          'oidc callback failed',
        );
        return failAuthRedirect(reply, classified.redirect, request);
      }
    });
  }
}

/** Legacy OIDC callback helpers below (Task F1 quarantine). */
async function completeOidcCallback(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: BrowserAuthDeps,
  oidc: OidcProviderPort,
  query: Record<string, string | undefined>,
): Promise<void> {
  const hasCode = typeof query.code === 'string' && query.code.length > 0;
  const hasError = typeof query.error === 'string' && query.error.length > 0;
  const state = query.state;
  if (!state || (hasCode === hasError) || (!hasCode && !hasError)) {
    throw new OidcExchangeError('invalid_callback_shape');
  }
  const secureStateCookie = deps.config.productOrigin.startsWith('https://');
  const stateCookie = readOidcBrowserStateCookie(request, secureStateCookie);
  if (stateCookie === null || stateCookie !== state) {
    throw new OidcExchangeError('invalid_callback_shape');
  }
  if (query.iss !== undefined && query.iss !== deps.config.oidc.issuer) {
    // Pre-exchange validation: do not consume the TX so a correct iss retry
    // of the same browser callback remains possible before code expiry.
    throw new OidcExchangeError('invalid_issuer');
  }
  // Consume the binding before any redirect; replayed callbacks cannot reuse
  // a browser state cookie after the one-time transaction is consumed. Keep
  // this after issuer pre-validation so a valid retry is still possible.
  reply.header('Set-Cookie', oidcBrowserStateCookieHeader(secureStateCookie, null));
  if (hasError) {
    // Consume transaction if present, then fixed failure redirect.
    await deps.identityUnitOfWork.execute(async (ports) => {
      try {
        await consumeOidcLoginTransaction(ports, state);
      } catch {
        // ignore — failure path always clears what it can
      }
    });
    throw new OidcExchangeError('provider_error');
  }

  // Success branch: consume TX first (DB), then network token exchange outside lock.
  // Materialize decrypts PKCE; nonce is verified via keyed digest only (no plaintext nonce).
  // Consume-once: never resurrect this state after this UoW commits.
  let consumed: Awaited<ReturnType<typeof consumeOidcLoginTransaction>>;
  let matchesExpectedNonce: (tokenNonce: string) => boolean;
  try {
    const consumedBundle = await deps.identityUnitOfWork.execute(
      async (ports) => {
        const consumedTx = await consumeOidcLoginTransaction(ports, state);
        const secrets = ports.oidcTransactionSecrets;
        const nonceHash = consumedTx.nonceHash;
        return {
          consumed: consumedTx,
          matchesExpectedNonce: (tokenNonce: string) =>
            secrets.verifyNonceDigest(tokenNonce, nonceHash),
        };
      },
    );
    consumed = consumedBundle.consumed;
    matchesExpectedNonce = consumedBundle.matchesExpectedNonce;
  } catch (error: unknown) {
    // Consume failed (not found / expired / already consumed) — pre-exchange terminal.
    throw new OidcCallbackStageError('pre_exchange', error);
  }

  // Network I/O outside DB transaction. Authorization code must not be re-tried
  // by this server after a later local failure (provider may have consumed it).
  let exchanged: Awaited<ReturnType<OidcProviderPort['exchangeAuthorizationCode']>>;
  try {
    exchanged = await oidc.exchangeAuthorizationCode({
      code: query.code!,
      codeVerifier: consumed.codeVerifier,
      matchesExpectedNonce,
    });
  } catch (error: unknown) {
    throw new OidcCallbackStageError('pre_exchange', error);
  }

  // Anti-wrong-account: never rotateSession for OIDC login — that would keep the
  // prior cookie's accountId. Revoke any prior session, then createSession for
  // the OIDC-bound account. Retry once on concurrent first-login identity claim.
  let issued: Awaited<ReturnType<typeof createSession>>;
  try {
    issued = await issueSessionForOidcClaims(request, deps, {
      issuer: exchanged.claims.issuer,
      subject: exchanged.claims.subject,
      email: exchanged.claims.email ?? null,
      emailVerified: exchanged.claims.emailVerified === true,
      displayName: exchanged.claims.name ?? '',
      ...(exchanged.claims.picture !== undefined
        ? { avatarUrl: exchanged.claims.picture }
        : {}),
    });
  } catch (error: unknown) {
    // Local work failed after code exchange. TX and (likely) code are spent —
    // classify as post_exchange so the client gets auth=restart, not a dead end.
    throw new OidcCallbackStageError('post_exchange', error);
  }

  setSessionCookie(reply, issued.rawSessionToken, issued.session.absoluteExpiresAt);
  const location = resolveBrowserReturnTo(
    consumed.returnTo,
    deps.config.productOrigin,
    FIXED_DASHBOARD,
  );
  reply
    .code(303)
    .header('Cache-Control', 'no-store')
    .header('Location', location)
    .send();
}

function oidcBrowserStateCookieName(secure: boolean): string {
  return secure ? OIDC_BROWSER_STATE_COOKIE : OIDC_BROWSER_STATE_COOKIE_INSECURE;
}

function oidcBrowserStateCookieHeader(secure: boolean, state: string | null): string {
  const name = oidcBrowserStateCookieName(secure);
  const value = state === null ? '' : encodeURIComponent(state);
  return `${name}=${value}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${state === null ? 0 : 600}`;
}

function readOidcBrowserStateCookie(request: FastifyRequest, secure: boolean): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return null;
  const expected = oidcBrowserStateCookieName(secure);
  let value: string | null = null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0 || trimmed.slice(0, separator) !== expected) continue;
    if (value !== null) return null;
    try { value = decodeURIComponent(trimmed.slice(separator + 1)); } catch { return null; }
  }
  return value;
}

async function issueSessionForOidcClaims(
  request: FastifyRequest,
  deps: BrowserAuthDeps,
  claims: {
    readonly issuer: string;
    readonly subject: string;
    readonly email: string | null;
    readonly emailVerified: boolean;
    readonly displayName: string;
    readonly avatarUrl?: string | null;
  },
): Promise<Awaited<ReturnType<typeof createSession>>> {
  // Single UoW: partial account/profile/identity/session writes roll back together.
  const run = () => deps.identityUnitOfWork.execute(async (ports) => {
    const existingCookie = readSessionCookie(request);
    let priorSessionId: string | null = null;
    if (existingCookie) {
      try {
        const previous = await authenticateSession(ports, existingCookie, { touch: false });
        priorSessionId = previous.session.id;
      } catch {
        priorSessionId = null;
      }
    }
    const ensured = await ensureAccountFromOidcIdentity(ports, {
      issuer: claims.issuer,
      subject: claims.subject,
      email: claims.email,
      emailVerified: claims.emailVerified,
      displayName: claims.displayName,
      ...(Object.prototype.hasOwnProperty.call(claims, 'avatarUrl')
        ? { avatarUrl: claims.avatarUrl ?? null }
        : {}),
      metrics: deps.metrics,
    });
    if (priorSessionId) {
      await revokeSession(ports, priorSessionId);
      return createSession(ports, {
        accountId: ensured.account.id,
        rotatedFromSessionId: priorSessionId,
      });
    }
    return createSession(ports, { accountId: ensured.account.id });
  });

  try {
    return await run();
  } catch (error: unknown) {
    // Concurrent first-login: loser rolls back provisional rows; winner exists.
    // Retry once in a fresh transaction. Never re-exchange the authorization code.
    if (
      hasCode(error, 'identity_conflict')
      || (error instanceof DatabaseOperationError && error.kind === 'unique_violation')
    ) {
      return await run();
    }
    throw error;
  }
}

function failAuthRedirect(
  reply: FastifyReply,
  kind: OidcAuthRedirectKind = 'failed',
  request?: FastifyRequest,
): FastifyReply {
  // A malformed or forged callback is an unsolicited request. Do not turn
  // it into a logout by expiring a valid session cookie that belongs to the
  // browser. Clearing is retained for the no-session case so the legacy
  // flow still removes a stale cookie after a failed login attempt.
  if (request === undefined || readSessionCookie(request) === null) {
    clearSessionCookie(reply);
  }
  const location = kind === 'restart' ? AUTH_RESTART_LOCATION : AUTH_FAILED_LOCATION;
  return reply
    .code(303)
    .header('Cache-Control', 'no-store')
    .header('Location', location)
    .send();
}

/**
 * Classify OIDC callback failures for logging and redirect selection.
 * Never includes provider error_description, code, state, or secrets.
 *
 * @deprecated Legacy OIDC callback flow (Task F1 quarantine).
 */
export function classifyOidcCallbackFailure(error: unknown): ClassifiedOidcCallbackFailure {
  if (error instanceof OidcCallbackStageError) {
    return classifyAuthFailure(error.causeError, error.stage);
  }
  return classifyAuthFailure(error, 'pre_exchange');
}

function classifyAuthFailure(
  error: unknown,
  stage: OidcCallbackStage,
): ClassifiedOidcCallbackFailure {
  if (error instanceof OidcExchangeError) {
    return classifyExchangeError(error, stage);
  }

  if (error instanceof IdentityError) {
    return classifyIdentityError(error, stage);
  }

  if (error instanceof DatabaseOperationError) {
    return classifyDatabaseFailure(error, stage);
  }

  // Unknown / internal after successful exchange → restart (non-replayable).
  if (stage === 'post_exchange') {
    return {
      class: 'post_exchange',
      reason: 'internal',
      redirect: 'restart',
      stage,
    };
  }

  return {
    class: 'pre_exchange',
    reason: 'internal',
    redirect: 'failed',
    stage,
  };
}

function classifyExchangeError(
  error: OidcExchangeError,
  stage: OidcCallbackStage,
): ClassifiedOidcCallbackFailure {
  const reason = error.reason;

  if (TERMINAL_EXCHANGE_REASONS.has(reason)) {
    return {
      class: 'terminal',
      reason,
      redirect: 'failed',
      stage,
    };
  }

  // After TX consume, transient token-endpoint failures cannot safely re-use the
  // same authorization code — send the user through a new login.
  if (RESTARTABLE_EXCHANGE_REASONS.has(reason)) {
    return {
      class: 'pre_exchange',
      reason,
      redirect: 'restart',
      stage: 'pre_exchange',
    };
  }

  return {
    class: 'pre_exchange',
    reason,
    redirect: 'failed',
    stage: 'pre_exchange',
  };
}

function classifyIdentityError(
  error: IdentityError,
  stage: OidcCallbackStage,
): ClassifiedOidcCallbackFailure {
  if (TERMINAL_IDENTITY_CODES.has(error.code)) {
    return {
      class: 'terminal',
      reason: error.code,
      redirect: 'failed',
      stage,
    };
  }

  if (stage === 'post_exchange') {
    // e.g. identity_conflict after single retry, handle_taken races → new login.
    return {
      class: 'post_exchange',
      reason: error.code,
      redirect: 'restart',
      stage,
    };
  }

  return {
    class: 'pre_exchange',
    reason: error.code,
    redirect: 'failed',
    stage,
  };
}

function classifyDatabaseFailure(
  error: DatabaseOperationError,
  stage: OidcCallbackStage,
): ClassifiedOidcCallbackFailure {
  const transient =
    error.kind === 'serialization_failure'
    || error.kind === 'deadlock'
    || error.kind === 'database_failure'
    || error.kind === 'commit_outcome_unknown'
    || error.kind === 'unique_violation';

  if (stage === 'post_exchange' && transient) {
    return {
      class: error.retryableAtCommandBoundary || error.kind === 'database_failure'
        || error.kind === 'commit_outcome_unknown'
        ? 'transient_local'
        : 'post_exchange',
      reason: error.kind,
      // Authorization code already exchanged — not replayable; restart login.
      redirect: 'restart',
      stage,
    };
  }

  if (stage === 'pre_exchange' && transient) {
    // Consume TX UoW failed before exchange: state may or may not be consumed.
    // Safe client action is still a clean restart (never invent a code retry).
    return {
      class: 'transient_local',
      reason: error.kind,
      redirect: 'restart',
      stage,
    };
  }

  return {
    class: stage === 'post_exchange' ? 'post_exchange' : 'pre_exchange',
    reason: error.kind,
    redirect: stage === 'post_exchange' ? 'restart' : 'failed',
    stage,
  };
}
