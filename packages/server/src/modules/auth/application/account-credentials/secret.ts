import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const ACCOUNT_CREDENTIAL_SECRET_PATTERN = /^kn_[pc]_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/;
export const ACCOUNT_CREDENTIAL_SECRET_LENGTH = 71;

export type AccountCredentialKind = 'parent' | 'child';

export interface IssuedAccountCredentialSecret {
  readonly kind: AccountCredentialKind;
  readonly secret: string;
  readonly prefix: string;
  readonly publicId: string;
  readonly secretMaterial: Buffer;
  readonly secretHash: string;
  readonly mcpClientId: string;
}

export function issueAccountCredentialSecret(kind: AccountCredentialKind, hmacKey?: string): IssuedAccountCredentialSecret {
  const publicId = randomBytes(16).toString('base64url');
  const secretMaterial = randomBytes(32);
  const tag = kind === 'parent' ? 'p' : 'c';
  const secret = `kn_${tag}_${publicId}_${secretMaterial.toString('base64url')}`;
  if (secret.length !== ACCOUNT_CREDENTIAL_SECRET_LENGTH || !ACCOUNT_CREDENTIAL_SECRET_PATTERN.test(secret)) {
    throw new Error('account credential secret failed contract encoding');
  }
  const prefix = `kn_${tag}_${publicId}`;
  return {
    kind,
    secret,
    prefix,
    publicId,
    secretMaterial,
    secretHash: hashAccountCredentialSecret(secret, hmacKey),
    mcpClientId: randomUUID(),
  };
}

export function hashAccountCredentialSecret(secret: string, hmacKey?: string): string {
  // AC-F003: keyed HMAC-SHA256 when a deployment key is configured; the bare
  // form remains only for unconfigured/test fallbacks and the rate-limit
  // bucket key (never secret integrity).
  return hmacKey === undefined
    ? createHash('sha256').update(secret, 'utf8').digest('hex')
    : createHmac('sha256', hmacKey).update(secret, 'utf8').digest('hex');
}

export function verifyAccountCredentialSecretHash(secret: string, digest: string): boolean {
  if (typeof digest !== 'string' || digest.length !== 64) return false;
  const actual = Buffer.from(hashAccountCredentialSecret(secret), 'utf8');
  const expected = Buffer.from(digest, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseAccountCredentialSecret(secret: string): {
  readonly kind: AccountCredentialKind;
  readonly prefix: string;
  readonly publicId: string;
} {
  if (typeof secret !== 'string' || !ACCOUNT_CREDENTIAL_SECRET_PATTERN.test(secret)) {
    throw new TypeError('account credential secret is invalid');
  }
  const kind: AccountCredentialKind = secret.startsWith('kn_p_') ? 'parent' : 'child';
  const publicId = secret.slice(5, 27);
  return { kind, prefix: secret.slice(0, 27), publicId };
}
