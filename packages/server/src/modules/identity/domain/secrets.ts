import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Purpose tag so session-cookie material cannot be reused as CSRF directly. */
const CSRF_DERIVE_PURPOSE = 'known-session-csrf-v1';
const ROTATION_DERIVE_PURPOSE = 'known-session-rotation-v2';

/** 32 random bytes → base64url (43 chars). */
export function generateCsrfTokenRaw(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Derive the session-bound CSRF secret from the raw session cookie secret.
 * Allows GET /session to re-issue CSRF without rotating or storing the raw value.
 * Cross-site attackers that only auto-include the HttpOnly cookie cannot compute this.
 */
export function deriveCsrfTokenRaw(rawSessionToken: string): string {
  if (!rawSessionToken) {
    throw new Error('session token is required to derive csrf');
  }
  return createHmac('sha256', rawSessionToken)
    .update(CSRF_DERIVE_PURPOSE, 'utf8')
    .digest('base64url');
}

/** 32+ random bytes for the session cookie secret. */
export function generateSessionTokenRaw(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Deterministic successor secret for a single predecessor rotation race.
 * A server-held key is the HMAC key, so possession of a predecessor cookie
 * cannot be used to predict its successor offline.
 */
export function deriveRotatedSessionTokenRaw(
  serverSecret: string,
  predecessorRawSessionToken: string,
  predecessorSessionId: string,
): string {
  if (!serverSecret || !predecessorRawSessionToken || !predecessorSessionId) {
    throw new Error('server secret, predecessor token and session id are required for rotation');
  }
  return createHmac('sha256', serverSecret)
    .update(`${ROTATION_DERIVE_PURPOSE}\0${predecessorSessionId}\0${predecessorRawSessionToken}`, 'utf8')
    .digest('base64url');
}

export interface SessionRotationSecretsPort {
  deriveSuccessorToken(predecessorRawSessionToken: string, predecessorSessionId: string): string;
}

export function createSessionRotationSecrets(serverSecret: string): SessionRotationSecretsPort {
  if (typeof serverSecret !== 'string' || serverSecret.trim() === '') {
    throw new Error('session rotation server secret is required');
  }
  return {
    deriveSuccessorToken: (predecessorRawSessionToken, predecessorSessionId) =>
      deriveRotatedSessionTokenRaw(serverSecret, predecessorRawSessionToken, predecessorSessionId),
  };
}

/** Deterministic test-only key; production composition supplies config-backed material. */
export function createTestSessionRotationSecrets(): SessionRotationSecretsPort {
  return createSessionRotationSecrets('test-session-rotation-server-secret-v2');
}

export function generateOpaqueId(): string {
  return randomBytes(16).toString('base64url');
}

/** High-entropy state/nonce material (32 bytes base64url). */
export function generateOidcStateMaterial(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE code_verifier: 32 bytes base64url (43 chars, within 43..128). */
export function generatePkceCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest for stored session/CSRF secrets. Raw values are never stored. */
export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function secretsMatch(raw: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(raw), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function hashesMatch(leftHash: string, rightHash: string): boolean {
  const left = Buffer.from(leftHash, 'utf8');
  const right = Buffer.from(rightHash, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
