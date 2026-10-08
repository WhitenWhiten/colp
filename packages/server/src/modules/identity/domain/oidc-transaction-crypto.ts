/**
 * OIDC login-transaction secret protection (contracted storage).
 *
 * - state / nonce: keyed HMAC-SHA256 digests (not reversible); constant-time verify.
 * - PKCE code_verifier: AES-256-GCM with versioned keys (keys never stored in DB).
 * - At rest only digests + ciphertext; raw browser secrets never persist.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { OidcLoginTransaction } from './types.js';

/** Purpose tags prevent cross-field digest substitution. */
export const OIDC_STATE_DIGEST_PURPOSE = 'oidc-login-state-v1' as const;
export const OIDC_NONCE_DIGEST_PURPOSE = 'oidc-login-nonce-v1' as const;

/** AES-256-GCM: 12-byte IV || 16-byte tag || ciphertext */
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const AES_KEY_LENGTH = 32;

export interface OidcEncryptionKey {
  readonly id: string;
  readonly version: number;
  /** Raw 32-byte AES-256 key material. */
  readonly key: Buffer;
}

export interface OidcTransactionSecretsConfig {
  /** HMAC key for state/nonce digests (never persisted). */
  readonly hmacSecret: string;
  /**
   * Versioned AEAD keys. Index 0 is the current write key.
   * Older keys remain for decrypt during rotation.
   */
  readonly encryptionKeys: readonly OidcEncryptionKey[];
}

export interface PkceEncryptionResult {
  readonly ciphertext: Buffer;
  readonly keyId: string;
  readonly keyVersion: number;
}

/**
 * Port bound into IdentityPorts for create/consume materialization.
 * Implementations must never log raw secrets.
 */
export interface OidcTransactionSecretsPort {
  digestState(state: string): string;
  digestNonce(nonce: string): string;
  verifyStateDigest(state: string, expectedDigest: string): boolean;
  verifyNonceDigest(nonce: string, expectedDigest: string): boolean;
  encryptPkceVerifier(codeVerifier: string): PkceEncryptionResult;
  decryptPkceVerifier(
    ciphertext: Buffer,
    keyId: string,
    keyVersion: number,
  ): string;
}

export function createOidcTransactionSecrets(
  config: OidcTransactionSecretsConfig,
): OidcTransactionSecretsPort {
  const hmacSecret = assertNonEmptyString(config.hmacSecret, 'hmacSecret');
  const encryptionKeys = assertEncryptionKeys(config.encryptionKeys);
  const current = encryptionKeys[0]!;
  const byIdVersion = new Map<string, OidcEncryptionKey>();
  for (const entry of encryptionKeys) {
    byIdVersion.set(keyMapId(entry.id, entry.version), entry);
  }

  return {
    digestState(state) {
      return keyedDigest(hmacSecret, OIDC_STATE_DIGEST_PURPOSE, state);
    },
    digestNonce(nonce) {
      return keyedDigest(hmacSecret, OIDC_NONCE_DIGEST_PURPOSE, nonce);
    },
    verifyStateDigest(state, expectedDigest) {
      return constantTimeEqualHex(
        keyedDigest(hmacSecret, OIDC_STATE_DIGEST_PURPOSE, state),
        expectedDigest,
      );
    },
    verifyNonceDigest(nonce, expectedDigest) {
      return constantTimeEqualHex(
        keyedDigest(hmacSecret, OIDC_NONCE_DIGEST_PURPOSE, nonce),
        expectedDigest,
      );
    },
    encryptPkceVerifier(codeVerifier) {
      assertNonEmptyString(codeVerifier, 'codeVerifier');
      // Unique random IV per encrypt — never reuse IV with the same key.
      const iv = randomBytes(GCM_IV_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', current.key, iv);
      const encrypted = Buffer.concat([
        cipher.update(codeVerifier, 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: Buffer.concat([iv, tag, encrypted]),
        keyId: current.id,
        keyVersion: current.version,
      };
    },
    decryptPkceVerifier(ciphertext, keyId, keyVersion) {
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length < GCM_IV_LENGTH + GCM_TAG_LENGTH + 1) {
        throw new Error('pkce verifier ciphertext is malformed');
      }
      const key = resolveDecryptKey(byIdVersion, keyId, keyVersion);
      const iv = ciphertext.subarray(0, GCM_IV_LENGTH);
      const tag = ciphertext.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH);
      const body = ciphertext.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH);
      const decipher = createDecipheriv('aes-256-gcm', key.key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('pkce verifier ciphertext failed authentication (tampered or wrong key)');
      }
    },
  };
}

/**
 * Deterministic test/dev secrets. Never use the fixed values in production.
 */
export function createTestOidcTransactionSecrets(
  overrides: Partial<OidcTransactionSecretsConfig> = {},
): OidcTransactionSecretsPort {
  const defaultKey = Buffer.alloc(AES_KEY_LENGTH, 7);
  return createOidcTransactionSecrets({
    hmacSecret: overrides.hmacSecret ?? 'test-oidc-transaction-hmac-secret-v1',
    encryptionKeys: overrides.encryptionKeys ?? [
      { id: 'oidc-pkce-test', version: 1, key: defaultKey },
    ],
  });
}

/**
 * Materialize a stored row for callback use: recover browser state (caller-provided)
 * and decrypt the PKCE verifier. Nonce is not recoverable — verify via nonceHash.
 */
export function materializeOidcLoginTransactionForUse(
  row: OidcLoginTransaction,
  browserState: string,
  secrets: OidcTransactionSecretsPort,
): OidcLoginTransaction {
  if (!secrets.verifyStateDigest(browserState, row.stateHash)) {
    // Lookup should already have matched; refuse to materialize a mismatch.
    throw new Error('OIDC transaction state digest mismatch');
  }

  const codeVerifier = secrets.decryptPkceVerifier(
    row.pkceVerifierCiphertext,
    row.encryptionKeyId,
    row.encryptionKeyVersion,
  );

  return {
    ...row,
    state: browserState,
    codeVerifier,
  };
}

/** Contracted rows always carry protected secret material. */
export function isProtectedOidcTransaction(row: OidcLoginTransaction): boolean {
  return (
    row.stateHash.length > 0
    && row.nonceHash.length > 0
    && Buffer.isBuffer(row.pkceVerifierCiphertext)
    && row.pkceVerifierCiphertext.length > 0
  );
}

function keyedDigest(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret)
    .update(purpose, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveDecryptKey(
  byIdVersion: Map<string, OidcEncryptionKey>,
  keyId: string,
  keyVersion: number,
): OidcEncryptionKey {
  const found = byIdVersion.get(keyMapId(keyId, keyVersion));
  if (found) return found;
  throw new Error('pkce verifier encryption key was not found for decryption');
}

function keyMapId(id: string, version: number): string {
  return `${id}\0${version}`;
}

function assertNonEmptyString(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertEncryptionKeys(keys: readonly OidcEncryptionKey[]): readonly OidcEncryptionKey[] {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('at least one OIDC transaction encryption key is required');
  }
  for (const [index, entry] of keys.entries()) {
    if (!entry.id || entry.id.trim() === '') {
      throw new Error(`encryptionKeys[${index}].id is required`);
    }
    if (!Number.isInteger(entry.version) || entry.version < 0) {
      throw new Error(`encryptionKeys[${index}].version must be a non-negative integer`);
    }
    if (!Buffer.isBuffer(entry.key) || entry.key.length !== AES_KEY_LENGTH) {
      throw new Error(`encryptionKeys[${index}].key must be ${AES_KEY_LENGTH} bytes`);
    }
  }
  return keys;
}

/** Encode a 32-byte key as unpadded base64 for env transport. */
export function encodeOidcEncryptionKeyBase64(key: Buffer): string {
  if (key.length !== AES_KEY_LENGTH) {
    throw new Error(`encryption key must be ${AES_KEY_LENGTH} bytes`);
  }
  return key.toString('base64');
}

/** Parse `version:id:base64key` entries (comma-separated). First is current. */
export function parseOidcEncryptionKeysEnv(raw: string): OidcEncryptionKey[] {
  const parts = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('OIDC_TRANSACTION_ENCRYPTION_KEYS is empty');
  }
  return parts.map((part, index) => {
    const segments = part.split(':');
    if (segments.length < 3) {
      throw new Error(
        `OIDC_TRANSACTION_ENCRYPTION_KEYS entry ${index} must be version:id:base64key`,
      );
    }
    const versionRaw = segments[0]!;
    const id = segments[1]!;
    const keyB64 = segments.slice(2).join(':');
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`OIDC_TRANSACTION_ENCRYPTION_KEYS entry ${index} has invalid version`);
    }
    let key: Buffer;
    try {
      key = Buffer.from(keyB64, 'base64');
    } catch {
      throw new Error(`OIDC_TRANSACTION_ENCRYPTION_KEYS entry ${index} has invalid base64 key`);
    }
    if (key.length !== AES_KEY_LENGTH) {
      throw new Error(
        `OIDC_TRANSACTION_ENCRYPTION_KEYS entry ${index} key must decode to ${AES_KEY_LENGTH} bytes`,
      );
    }
    return { id, version, key };
  });
}
