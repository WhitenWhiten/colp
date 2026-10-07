/**
 * P4A-I10 owner-private delivery capability (stateless signed token).
 *
 * A delivery capability is a short-lived, single-object, single-purpose
 * bearer token that the I11 isolated-origin host will verify and consume. It
 * is deliberately NOT a JWT (no external dependency; the format is compact and
 * fully owned by this module so the verifier logic is trivially the SAME code
 * the isolated host uses):
 *
 *   `v1.<base64url(payloadJSON)>.<base64url(HMAC-SHA256(secret, "owner-delivery-v1\n" + payloadBytes))>`
 *
 * The claims bind the capability to: the isolated delivery audience (exact
 * origin, from config), the logical blob, the generation that was CURRENT at
 * admission, the method `GET` only, a bounded expiry (1..120s, mirroring the
 * I03 max-exposure window), and a random nonce. The token contains no R2
 * credential, no physical key, no download URL, and no digest — it is unusable
 * for R2 write/list or any other service (wrong audience or method fails in
 * the verifier).
 *
 * Replay semantics: the capability is a stateless short-lived bearer token, so
 * replay within the TTL is inherently valid; the max exposure window IS the
 * TTL. Natural expiry is recorded separately from authorization denial by the
 * admission use case.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MAX_SECONDS,
  ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MIN_SECONDS,
} from './attachments-config.js';

export const OWNER_DELIVERY_CAPABILITY_VERSION = 1 as const;
export const OWNER_DELIVERY_CAPABILITY_KIND = 'owner_delivery' as const;
export const OWNER_DELIVERY_CAPABILITY_METHOD = 'GET' as const;
export const OWNER_DELIVERY_CAPABILITY_TTL_MIN_SECONDS = ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MIN_SECONDS;
export const OWNER_DELIVERY_CAPABILITY_TTL_MAX_SECONDS = ATTACHMENTS_DELIVERY_CAPABILITY_TTL_MAX_SECONDS;

/** Canonical signed payload prefix; changing it is a token-format break. */
const CANONICAL_PREFIX = 'owner-delivery-v1\n';

export interface OwnerDeliveryCapabilityClaims {
  readonly version: 1;
  readonly kind: 'owner_delivery';
  /** Random nonce; unique per issuance. */
  readonly capabilityId: string;
  readonly blobId: string;
  readonly generationId: string;
  /** Signed issuer provenance, not the identity of the HTTP downloader.
   * Owner membership is checked at issuance; delivery is intentionally session-free
   * bearer access for the short TTL. The HMAC authenticates this field too. */
  readonly ownerSubject: string;
  /** Exact isolated delivery origin (no path/query/userinfo). */
  readonly audience: string;
  readonly method: 'GET';
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface OwnerDeliveryCapability {
  readonly token: string;
  readonly claims: OwnerDeliveryCapabilityClaims;
}

export interface OwnerDeliveryCapabilitySigner {
  readonly audienceOrigin: string;
  sign(input: {
    readonly blobId: string;
    readonly generationId: string;
    readonly ownerSubject: string;
    readonly ttlSeconds: number;
    readonly now?: Date;
    readonly nonce?: string;
  }): OwnerDeliveryCapability;
}

export type OwnerDeliveryCapabilityInvalidReason =
  | 'malformed'
  | 'unsupported_version'
  | 'wrong_kind'
  | 'signature'
  | 'expired'
  | 'not_yet_valid'
  | 'audience_mismatch'
  | 'method_mismatch';

export type OwnerDeliveryCapabilityVerification =
  | { outcome: 'valid'; claims: OwnerDeliveryCapabilityClaims }
  | { outcome: 'invalid'; reason: OwnerDeliveryCapabilityInvalidReason };

export interface OwnerDeliveryCapabilityVerifierInput {
  readonly token: string;
  readonly secret: string | Uint8Array;
  readonly expectedAudience: string;
  readonly now: Date;
}

function assertTtlInRange(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < OWNER_DELIVERY_CAPABILITY_TTL_MIN_SECONDS
    || ttlSeconds > OWNER_DELIVERY_CAPABILITY_TTL_MAX_SECONDS) {
    throw new Error('delivery_capability_ttl_out_of_range');
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`delivery_capability_${label}_required`);
}

function hmacDigest(secret: string | Uint8Array, payloadBytes: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(CANONICAL_PREFIX, 'utf8').update(payloadBytes).digest();
}

function signPayload(
  secret: string | Uint8Array,
  claims: OwnerDeliveryCapabilityClaims,
): { payloadBytes: Buffer; signature: Buffer; token: string } {
  const payloadBytes = Buffer.from(JSON.stringify(claims), 'utf8');
  const signature = hmacDigest(secret, payloadBytes);
  return {
    payloadBytes,
    signature,
    token: `v1.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`,
  };
}

export function createHmacOwnerDeliveryCapabilitySigner(options: {
  readonly secret: string | Uint8Array;
  readonly audienceOrigin: string;
  readonly nonce?: () => string;
  readonly now?: () => Date;
}): OwnerDeliveryCapabilitySigner {
  const audienceOrigin = options.audienceOrigin.trim();
  if (!audienceOrigin) throw new Error('delivery_capability_audience_required');
  const nonce = options.nonce ?? (() => randomUUID());
  const clock = options.now ?? (() => new Date());

  return {
    audienceOrigin,
    sign(input) {
      assertNonEmpty(input.blobId, 'blob');
      assertNonEmpty(input.generationId, 'generation');
      assertNonEmpty(input.ownerSubject, 'owner');
      assertTtlInRange(input.ttlSeconds);
      const issuedAt = (input.now ?? clock()).getTime();
      const claims: OwnerDeliveryCapabilityClaims = {
        version: OWNER_DELIVERY_CAPABILITY_VERSION,
        kind: OWNER_DELIVERY_CAPABILITY_KIND,
        capabilityId: input.nonce ?? nonce(),
        blobId: input.blobId,
        generationId: input.generationId,
        ownerSubject: input.ownerSubject,
        audience: audienceOrigin,
        method: OWNER_DELIVERY_CAPABILITY_METHOD,
        issuedAtEpochMs: issuedAt,
        expiresAtEpochMs: issuedAt + input.ttlSeconds * 1_000,
      };
      const { token } = signPayload(options.secret, claims);
      return { token, claims };
    },
  };
}

function safeBase64UrlDecode(segment: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) return undefined;
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    return undefined;
  }
}

/**
 * Structural parse only: field presence/types. The SEMANTIC values (version,
 * kind, method, audience, time bounds) are validated by the verifier so that
 * a forged-but-well-signed token surfaces as `method_mismatch` / `wrong_kind`
 * instead of collapsing into `malformed`.
 */
function parseClaims(payload: Buffer): OwnerDeliveryCapabilityClaims | undefined {
  try {
    const parsed = JSON.parse(payload.toString('utf8')) as Partial<OwnerDeliveryCapabilityClaims>;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (typeof parsed.version !== 'number') return undefined;
    if (typeof parsed.kind !== 'string' || parsed.kind.length === 0) return undefined;
    if (typeof parsed.capabilityId !== 'string' || parsed.capabilityId.length === 0) return undefined;
    if (typeof parsed.blobId !== 'string' || parsed.blobId.length === 0) return undefined;
    if (typeof parsed.generationId !== 'string' || parsed.generationId.length === 0) return undefined;
    if (typeof parsed.ownerSubject !== 'string' || parsed.ownerSubject.length === 0) return undefined;
    if (typeof parsed.audience !== 'string' || parsed.audience.length === 0) return undefined;
    if (typeof parsed.method !== 'string' || parsed.method.length === 0) return undefined;
    if (!Number.isSafeInteger(parsed.issuedAtEpochMs) || !Number.isSafeInteger(parsed.expiresAtEpochMs)) {
      return undefined;
    }
    return parsed as OwnerDeliveryCapabilityClaims;
  } catch {
    return undefined;
  }
}

/**
 * The verifier the I11 isolated-origin host will consume. Stateless: it only
 * checks the signature, audience, method, kind, and time bounds — it never
 * touches the database or the object store, so the credential-free delivery
 * process can use it directly.
 */
export function verifyOwnerDeliveryCapability(
  input: OwnerDeliveryCapabilityVerifierInput,
): OwnerDeliveryCapabilityVerification {
  const parts = input.token.split('.');
  if (parts.length !== 3) return { outcome: 'invalid', reason: 'malformed' };
  const [versionPrefix, payloadSegment, signatureSegment] = parts as [string, string, string];
  if (versionPrefix !== 'v1') return { outcome: 'invalid', reason: 'unsupported_version' };

  const payloadBytes = safeBase64UrlDecode(payloadSegment);
  const signatureBytes = safeBase64UrlDecode(signatureSegment);
  if (!payloadBytes || !signatureBytes) return { outcome: 'invalid', reason: 'malformed' };

  const expected = hmacDigest(input.secret, payloadBytes);
  if (expected.length !== signatureBytes.length || !timingSafeEqual(expected, signatureBytes)) {
    return { outcome: 'invalid', reason: 'signature' };
  }

  const claims = parseClaims(payloadBytes);
  if (!claims) return { outcome: 'invalid', reason: 'malformed' };
  if (claims.version !== 1) return { outcome: 'invalid', reason: 'unsupported_version' };
  if (claims.kind !== 'owner_delivery') return { outcome: 'invalid', reason: 'wrong_kind' };
  if (claims.method !== 'GET') return { outcome: 'invalid', reason: 'method_mismatch' };
  if (claims.audience !== input.expectedAudience) return { outcome: 'invalid', reason: 'audience_mismatch' };
  if (input.now.getTime() < claims.issuedAtEpochMs) return { outcome: 'invalid', reason: 'not_yet_valid' };
  if (input.now.getTime() >= claims.expiresAtEpochMs) return { outcome: 'invalid', reason: 'expired' };
  return { outcome: 'valid', claims };
}


