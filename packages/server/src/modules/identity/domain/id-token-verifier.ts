/**
 * Standards-compliant OIDC ID token verifier.
 *
 * Allowed algorithms (explicit allowlist): RS256, ES256, PS256, ES384.
 * Never accepts alg=none or HS* via header-only algorithm selection.
 * Signature verification always uses JWKS-provided asymmetric keys.
 * There is no decode-only success path.
 */
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';

/** Algorithms accepted for ID token signatures (asymmetric only). */
export const ALLOWED_ID_TOKEN_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'ES384'] as const;

export type AllowedIdTokenAlgorithm = (typeof ALLOWED_ID_TOKEN_ALGORITHMS)[number];

export type IdTokenVerificationFailureReason =
  | 'invalid_token'
  | 'disallowed_algorithm'
  | 'invalid_signature'
  | 'unknown_kid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_azp'
  | 'wrong_nonce'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid_iat'
  | 'missing_subject'
  | 'jwks_timeout'
  | 'jwks_malformed'
  | 'jwks_fetch_failed';

export class IdTokenVerificationError extends Error {
  readonly reason: IdTokenVerificationFailureReason;

  constructor(reason: IdTokenVerificationFailureReason, message?: string) {
    super(message ?? `ID token verification failed: ${reason}`);
    this.name = 'IdTokenVerificationError';
    this.reason = reason;
  }
}

export interface VerifiedIdTokenClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nbf?: number;
  readonly nonce?: string;
  readonly azp?: string;
  readonly email?: string | null;
  readonly emailVerified?: boolean;
  readonly name?: string;
  /** OIDC standard `picture` claim (profile avatar URL). */
  readonly picture?: string;
}

export interface IdTokenVerifyInput {
  readonly token: string;
  readonly expectedIssuer: string;
  readonly expectedAudience: string | readonly string[];
  /**
   * OAuth client_id. The ID token audience must contain this value; it is also
   * used for `azp` validation when the token is multi-audience or when `azp`
   * is present.
   */
  readonly clientId: string;
  /** When provided, payload.nonce must match exactly. */
  readonly expectedNonce?: string;
  /** Override wall clock (tests). Defaults to Date.now(). */
  readonly now?: Date;
}

/**
 * Port for JWKS resolution. Implementations must support force-refresh so
 * callers can recover from key rotation (unknown kid).
 */
export interface JwksProvider {
  getKeySet(options?: { readonly forceRefresh?: boolean }): Promise<JSONWebKeySet>;
}

export interface IdTokenVerifierOptions {
  readonly jwks: JwksProvider;
  /** Defaults to ALLOWED_ID_TOKEN_ALGORITHMS. */
  readonly allowedAlgorithms?: readonly AllowedIdTokenAlgorithm[];
  /** Clock skew for exp/nbf/iat (seconds). Default 60. */
  readonly clockToleranceSeconds?: number;
  /**
   * Reject tokens whose `iat` is older than this many seconds (iat sanity).
   * Default 86_400 (24h). Set 0 to disable max-age check (future iat still bounded).
   */
  readonly maxIatAgeSeconds?: number;
}

export interface IdTokenVerifier {
  verify(input: IdTokenVerifyInput): Promise<VerifiedIdTokenClaims>;
}

const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;
const DEFAULT_MAX_IAT_AGE_SECONDS = 86_400;

export function createIdTokenVerifier(options: IdTokenVerifierOptions): IdTokenVerifier {
  const allowed = new Set<string>(
    options.allowedAlgorithms ?? ALLOWED_ID_TOKEN_ALGORITHMS,
  );
  const clockTolerance = options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const maxIatAge = options.maxIatAgeSeconds ?? DEFAULT_MAX_IAT_AGE_SECONDS;

  return {
    async verify(input: IdTokenVerifyInput): Promise<VerifiedIdTokenClaims> {
      if (typeof input.token !== 'string' || input.token.trim() === '') {
        throw new IdTokenVerificationError('invalid_token', 'ID token is missing or empty');
      }

      let header: { alg?: string; kid?: string };
      try {
        header = decodeProtectedHeader(input.token);
      } catch {
        throw new IdTokenVerificationError('invalid_token', 'ID token header is malformed');
      }

      const alg = header.alg;
      if (!alg || !allowed.has(alg)) {
        throw new IdTokenVerificationError(
          'disallowed_algorithm',
          `Algorithm ${alg ?? '(missing)'} is not allowed`,
        );
      }

      const nowMs = (input.now ?? new Date()).getTime();
      const currentDate = new Date(nowMs);

      let payload: JWTPayload;
      try {
        payload = await verifyWithJwksRefresh(
          input.token,
          options.jwks,
          {
            issuer: input.expectedIssuer,
            audience: normalizeAudience(input.expectedAudience),
            algorithms: [...allowed] as AllowedIdTokenAlgorithm[],
            clockTolerance,
            currentDate,
          },
        );
      } catch (error: unknown) {
        throw mapVerificationError(error);
      }

      assertSubject(payload);
      assertIatSanity(payload, nowMs, clockTolerance, maxIatAge);
      assertClientAudience(payload, input.clientId);
      assertAzp(payload, input.clientId);
      assertNonce(payload, input.expectedNonce);

      return toVerifiedClaims(payload);
    },
  };
}

async function verifyWithJwksRefresh(
  token: string,
  jwks: JwksProvider,
  joseOptions: {
    issuer: string;
    audience: string | string[];
    algorithms: AllowedIdTokenAlgorithm[];
    clockTolerance: number;
    currentDate: Date;
  },
): Promise<JWTPayload> {
  const attempt = async (forceRefresh: boolean): Promise<JWTPayload> => {
    const document = await jwks.getKeySet({ forceRefresh });
    assertJwksShape(document);
    const keySet = createLocalJWKSet(document);
    const result = await jwtVerify(token, keySet, {
      issuer: joseOptions.issuer,
      audience: joseOptions.audience,
      algorithms: joseOptions.algorithms,
      clockTolerance: joseOptions.clockTolerance,
      currentDate: joseOptions.currentDate,
      // Required claims for OIDC ID tokens we accept.
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
    });
    return result.payload;
  };

  try {
    return await attempt(false);
  } catch (error: unknown) {
    if (isUnknownKeyError(error)) {
      try {
        return await attempt(true);
      } catch (retryError: unknown) {
        if (isUnknownKeyError(retryError)) {
          throw new IdTokenVerificationError(
            'unknown_kid',
            'No JWKS key matched the token kid after refresh',
          );
        }
        throw retryError;
      }
    }
    throw error;
  }
}

function assertJwksShape(document: JSONWebKeySet): void {
  if (
    document === null
    || typeof document !== 'object'
    || !Array.isArray(document.keys)
  ) {
    throw new IdTokenVerificationError('jwks_malformed', 'JWKS document is missing keys array');
  }
}

function isUnknownKeyError(error: unknown): boolean {
  return error instanceof joseErrors.JWKSNoMatchingKey
    || error instanceof joseErrors.JWKSInvalid
    || (error instanceof Error && /no applicable key|JWKSNoMatchingKey/i.test(error.message));
}

function mapVerificationError(error: unknown): IdTokenVerificationError {
  if (error instanceof IdTokenVerificationError) return error;

  if (error instanceof joseErrors.JWTExpired) {
    return new IdTokenVerificationError('expired', error.message);
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = error.claim;
    if (claim === 'iss') {
      return new IdTokenVerificationError('wrong_issuer', error.message);
    }
    if (claim === 'aud') {
      return new IdTokenVerificationError('wrong_audience', error.message);
    }
    if (claim === 'nbf' || claim === 'exp') {
      // nbf failure surfaces as not-yet-valid; exp as expired (also JWTExpired above).
      return new IdTokenVerificationError(
        claim === 'nbf' ? 'not_yet_valid' : 'expired',
        error.message,
      );
    }
    if (claim === 'sub') {
      return new IdTokenVerificationError('missing_subject', error.message);
    }
    return new IdTokenVerificationError('invalid_token', error.message);
  }
  if (
    error instanceof joseErrors.JWSSignatureVerificationFailed
    || error instanceof joseErrors.JWSInvalid
  ) {
    return new IdTokenVerificationError('invalid_signature', error.message);
  }
  if (error instanceof joseErrors.JWKSTimeout) {
    return new IdTokenVerificationError('jwks_timeout', error.message);
  }
  if (error instanceof joseErrors.JWKSNoMatchingKey) {
    return new IdTokenVerificationError('unknown_kid', error.message);
  }
  if (
    error instanceof joseErrors.JOSEError
    || error instanceof SyntaxError
    || error instanceof TypeError
  ) {
    return new IdTokenVerificationError('invalid_token', error.message);
  }
  if (error instanceof Error) {
    return new IdTokenVerificationError('invalid_token', error.message);
  }
  return new IdTokenVerificationError('invalid_token', 'Unknown verification failure');
}

function normalizeAudience(audience: string | readonly string[]): string | string[] {
  if (typeof audience === 'string') return audience;
  return [...audience];
}

function assertSubject(payload: JWTPayload): void {
  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    throw new IdTokenVerificationError('missing_subject', 'ID token subject is missing or empty');
  }
}

function assertIatSanity(
  payload: JWTPayload,
  nowMs: number,
  clockToleranceSeconds: number,
  maxIatAgeSeconds: number,
): void {
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new IdTokenVerificationError('invalid_iat', 'ID token iat claim is missing or invalid');
  }
  const iatMs = payload.iat * 1000;
  const skewMs = clockToleranceSeconds * 1000;
  if (iatMs > nowMs + skewMs) {
    throw new IdTokenVerificationError('invalid_iat', 'ID token iat is unreasonably far in the future');
  }
  if (maxIatAgeSeconds > 0 && iatMs < nowMs - maxIatAgeSeconds * 1000 - skewMs) {
    throw new IdTokenVerificationError('invalid_iat', 'ID token iat is unreasonably old');
  }
}

function assertClientAudience(payload: JWTPayload, clientId: string): void {
  const aud = payload.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(clientId)) {
    throw new IdTokenVerificationError(
      'wrong_audience',
      'ID token audience does not contain client_id',
    );
  }
}

function assertAzp(payload: JWTPayload, clientId: string): void {
  const aud = payload.aud;
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;

  // OIDC Core: multi-audience ID tokens MUST include azp equal to the client_id.
  if (audiences.length > 1) {
    if (!azp || azp !== clientId) {
      throw new IdTokenVerificationError(
        'wrong_azp',
        'Multi-audience ID token requires azp matching client_id',
      );
    }
    return;
  }

  // When present, azp must identify this client.
  if (azp !== undefined && azp !== clientId) {
    throw new IdTokenVerificationError('wrong_azp', 'ID token azp does not match client_id');
  }
}

function assertNonce(payload: JWTPayload, expectedNonce: string | undefined): void {
  if (expectedNonce === undefined) return;
  if (typeof payload.nonce !== 'string' || payload.nonce !== expectedNonce) {
    throw new IdTokenVerificationError('wrong_nonce', 'ID token nonce does not match expected value');
  }
}

function toVerifiedClaims(payload: JWTPayload): VerifiedIdTokenClaims {
  const audience = payload.aud!;
  return {
    issuer: payload.iss!,
    subject: payload.sub!,
    audience: Array.isArray(audience) ? audience : audience,
    exp: payload.exp!,
    iat: payload.iat!,
    nbf: typeof payload.nbf === 'number' ? payload.nbf : undefined,
    nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
    azp: typeof payload.azp === 'string' ? payload.azp : undefined,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
