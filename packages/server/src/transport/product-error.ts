import type { FastifyReply, FastifyRequest } from 'fastify';
import { productErrorStatus, type ProductErrorCode } from './product-codes.js';

export type ProductRecovery =
  | 'same_request'
  | 'refresh_and_retry'
  | 'restart_from_first_page'
  | 'user_action'
  | 'none';

export interface ProductFieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ProductErrorEnvelope {
  readonly error: {
    readonly code: ProductErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly recovery: ProductRecovery;
    readonly sameRequestRetrySafe: boolean;
    readonly precondition: 'resource' | 'content' | null;
    readonly currentEtag: string | null;
    readonly retryAfterSeconds: number | null;
    readonly fieldErrors: readonly ProductFieldError[];
  };
}

export interface ProductHttpErrorOptions {
  readonly statusCode: number;
  readonly code: ProductErrorCode;
  readonly message: string;
  readonly recovery?: ProductRecovery;
  readonly sameRequestRetrySafe?: boolean;
  readonly precondition?: 'resource' | 'content' | null;
  readonly currentEtag?: string | null;
  readonly retryAfterSeconds?: number | null;
  readonly fieldErrors?: readonly ProductFieldError[];
  readonly headers?: Readonly<Record<string, string>>;
}

export class ProductHttpError extends Error {
  readonly statusCode: number;
  readonly productCode: ProductErrorCode;
  readonly recovery: ProductRecovery;
  readonly sameRequestRetrySafe: boolean;
  readonly precondition: 'resource' | 'content' | null;
  readonly currentEtag: string | null;
  readonly retryAfterSeconds: number | null;
  readonly fieldErrors: readonly ProductFieldError[];
  readonly headers: Readonly<Record<string, string>>;

  constructor(options: ProductHttpErrorOptions) {
    super(options.message);
    this.name = 'ProductHttpError';
    this.statusCode = options.statusCode;
    this.productCode = options.code;
    this.recovery = options.recovery ?? 'user_action';
    this.sameRequestRetrySafe = options.sameRequestRetrySafe ?? false;
    this.precondition = options.precondition ?? null;
    this.currentEtag = options.currentEtag ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.fieldErrors = options.fieldErrors ?? [];
    this.headers = options.headers ?? {};
  }
}

export function sendProductError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: ProductHttpError,
): FastifyReply {
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
  return reply
    .code(error.statusCode)
    .type('application/json; charset=utf-8')
    .send(productErrorEnvelope(request.id, error));
}

/** Build the wire envelope for a product error (shared with onSend rewrites). */
export function productErrorEnvelope(requestId: string, error: ProductHttpError): ProductErrorEnvelope {
  return {
    error: {
      code: error.productCode,
      message: error.message,
      requestId,
      recovery: error.recovery,
      sameRequestRetrySafe: error.sameRequestRetrySafe,
      precondition: error.precondition,
      currentEtag: error.currentEtag,
      retryAfterSeconds: error.retryAfterSeconds,
      fieldErrors: error.fieldErrors,
    },
  };
}

// ---------------------------------------------------------------------------
// Task A4: unified Better Auth error classification (plan §7 A4 step 5).
//
// Every translation uses a FIXED product message — the BA message, the email,
// an OTP and any raw token are never echoed (no enumeration, no secret
// leakage). Unknown BA codes fail closed to invalid_request.
// ---------------------------------------------------------------------------

interface BetterAuthErrorTranslation {
  readonly code: ProductErrorCode;
  readonly message: string;
  readonly recovery: ProductRecovery;
}

/**
 * Frozen BA 1.7.1 error-code mapping (verified against the installed
 * better-auth source; G1 §10 / spike §4.7). BA already collapses
 * unknown-email vs wrong-password to one code; the product translation keeps
 * that and also maps sign-up existence to invalid_credentials so the
 * response never reveals whether an email exists.
 */
const BETTER_AUTH_ERROR_TRANSLATIONS: Readonly<Record<string, BetterAuthErrorTranslation>> = Object.freeze({
  PASSWORD_TOO_SHORT: Object.freeze({ code: 'invalid_request', message: 'The password is too short.', recovery: 'user_action' }),
  PASSWORD_TOO_LONG: Object.freeze({ code: 'invalid_request', message: 'The password is too long.', recovery: 'user_action' }),
  INVALID_PASSWORD: Object.freeze({ code: 'invalid_credentials', message: 'The email or password is incorrect.', recovery: 'user_action' }),
  SESSION_EXPIRED: Object.freeze({ code: 'authentication_required', message: 'Authentication is required.', recovery: 'user_action' }),
  SESSION_NOT_FRESH: Object.freeze({ code: 'authentication_required', message: 'Please sign in again to complete this action.', recovery: 'user_action' }),
  // Credentials (sign-in + sign-up existence): no enumeration.
  INVALID_EMAIL_OR_PASSWORD: Object.freeze({
    code: 'invalid_credentials',
    message: 'The email or password is incorrect.',
    recovery: 'user_action',
  }),
  USER_ALREADY_EXISTS: Object.freeze({
    code: 'invalid_credentials',
    message: 'The email or password is incorrect.',
    recovery: 'user_action',
  }),
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: Object.freeze({
    code: 'invalid_credentials',
    message: 'The email or password is incorrect.',
    recovery: 'user_action',
  }),
  // Verification prerequisite.
  EMAIL_NOT_VERIFIED: Object.freeze({
    code: 'verification_required',
    message: 'Email verification is required to complete this action.',
    recovery: 'user_action',
  }),
  // Session prerequisites (BA session middleware / generic-oauth).
  UNAUTHORIZED: Object.freeze({
    code: 'authentication_required',
    message: 'Authentication is required.',
    recovery: 'user_action',
  }),
  SESSION_REQUIRED: Object.freeze({
    code: 'authentication_required',
    message: 'Authentication is required.',
    recovery: 'user_action',
  }),
  // Origin/CSRF family (second line behind the transport pre-check).
  INVALID_ORIGIN: Object.freeze({
    code: 'csrf_failed',
    message: 'The request failed CSRF or Origin validation.',
    recovery: 'user_action',
  }),
  MISSING_OR_NULL_ORIGIN: Object.freeze({
    code: 'csrf_failed',
    message: 'The request failed CSRF or Origin validation.',
    recovery: 'user_action',
  }),
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: Object.freeze({
    code: 'csrf_failed',
    message: 'The request failed CSRF or Origin validation.',
    recovery: 'user_action',
  }),
  // Explicit account linking prerequisite (C3 scope).
  SOCIAL_ACCOUNT_ALREADY_LINKED: Object.freeze({
    code: 'account_link_required',
    message: 'This account must be linked explicitly before it can be used.',
    recovery: 'user_action',
  }),
  LINKED_ACCOUNT_ALREADY_EXISTS: Object.freeze({
    code: 'account_link_required',
    message: 'This account must be linked explicitly before it can be used.',
    recovery: 'user_action',
  }),
  // Email delivery capability.
  VERIFICATION_EMAIL_NOT_ENABLED: Object.freeze({
    code: 'email_delivery_unavailable',
    message: 'Email delivery is temporarily unavailable. Please try again later.',
    recovery: 'none',
  }),
  RESET_PASSWORD_DISABLED: Object.freeze({
    code: 'email_delivery_unavailable',
    message: 'Email delivery is temporarily unavailable. Please try again later.',
    recovery: 'none',
  }),
  // BA's own limiter (our transport family limiter usually fires first).
  TOO_MANY_REQUESTS: Object.freeze({
    code: 'rate_limited',
    message: 'Too many requests. Please try again later.',
    recovery: 'same_request',
  }),
  // OTP verify failures: fixed form copy, never occupancy.
  // Occupancy is only sign-up *send* with the intent header → USER_ALREADY_EXISTS*
  // → invalid_credentials. Mapping INVALID_OTP / OTP_EXPIRED to
  // invalid_credentials would make Register treat a wrong code as "already registered".
  INVALID_OTP: Object.freeze({
    code: 'invalid_request',
    message: 'That code did not work. Try again.',
    recovery: 'user_action',
  }),
  OTP_EXPIRED: Object.freeze({
    code: 'invalid_request',
    message: 'That code has expired. Request a new one.',
    recovery: 'user_action',
  }),
  // BA throws this as 403 FORBIDDEN; canonical product status is 429.
  // Same family as TOO_MANY_REQUESTS (betterAuthRateLimited path).
  TOO_MANY_ATTEMPTS: Object.freeze({
    code: 'rate_limited',
    message: 'Too many requests. Please try again later.',
    recovery: 'same_request',
  }),
});

/**
 * Classify a Better Auth error body into the unified product error.
 *
 * Returns null when the body is NOT a Better Auth error (product envelopes,
 * non-JSON shapes, 2xx) so the response passes through untouched. The BA
 * status is NOT trusted for the wire status — every product code carries its
 * canonical status from the central table.
 */
export function translateBetterAuthError(
  statusCode: number,
  body: unknown,
  retryAfterSeconds: number | null = null,
): ProductHttpError | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  // Success (and redirect) responses are never error translations: the
  // onSend hook only calls this for status >= 400, and the function contract
  // is "2xx passes through untouched".
  if (statusCode < 400) return null;
  const record = body as Record<string, unknown>;
  // Already a product envelope: never double-translate.
  const nested = record.error;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      && typeof (nested as { readonly code?: unknown }).code === 'string') {
    return null;
  }
  const code = typeof record.code === 'string' ? record.code : null;
  if (code === null) {
    // BA 1.6.29's own rate-limit response has no code field.
    if (statusCode === 429) return betterAuthRateLimited(retryAfterSeconds);
    // Code-less 4xx BA bodies (e.g. generic-oauth's PROVIDER_CONFIG_NOT_FOUND
    // on the C3 OAuth start) fail closed to the stable invalid_request
    // envelope: the BA message is never echoed (G1 §12.3) and provider
    // internals never reach the wire.
    if (statusCode >= 400 && statusCode < 500) {
      return new ProductHttpError({
        statusCode: productErrorStatus('invalid_request'),
        code: 'invalid_request',
        message: 'The request is invalid.',
        recovery: 'user_action',
      });
    }
    return null;
  }
  const translation: BetterAuthErrorTranslation | undefined = BETTER_AUTH_ERROR_TRANSLATIONS[code];
  if (translation === undefined) {
    // Unknown BA code: fail closed to the stable invalid_request envelope.
    return new ProductHttpError({
      statusCode: productErrorStatus('invalid_request'),
      code: 'invalid_request',
      message: 'The request is invalid.',
      recovery: 'user_action',
    });
  }
  if (translation.code === 'rate_limited') return betterAuthRateLimited(retryAfterSeconds);
  return new ProductHttpError({
    statusCode: productErrorStatus(translation.code),
    code: translation.code,
    message: translation.message,
    recovery: translation.recovery,
  });
}

function betterAuthRateLimited(retryAfterSeconds: number | null): ProductHttpError {
  return new ProductHttpError({
    statusCode: productErrorStatus('rate_limited'),
    code: 'rate_limited',
    message: 'Too many requests. Please try again later.',
    recovery: 'same_request',
    sameRequestRetrySafe: true,
    retryAfterSeconds,
    ...(retryAfterSeconds === null ? {} : { headers: { 'Retry-After': String(retryAfterSeconds) } }),
  });
}
