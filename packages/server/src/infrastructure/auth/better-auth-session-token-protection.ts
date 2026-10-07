import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const ENVELOPE_PREFIX = 'knst1';
const LOOKUP_PREFIX = 'knsh1';
const ENCRYPTION_CONTEXT = 'known.auth-session-token.encryption.v1';
const LOOKUP_CONTEXT = 'known.auth-session-token.lookup.v1';
const HKDF_SALT = Buffer.from('known.auth-session-token.hkdf.v1', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_TOKEN_BYTES = 256;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface BetterAuthSessionTokenProtectionKey {
  readonly version: number;
  readonly key: Buffer;
}

export interface BetterAuthSessionTokenProtectionOptions {
  /** First key writes; all entries can decrypt and build lookup candidates. */
  readonly keys: readonly BetterAuthSessionTokenProtectionKey[];
  /** Explicit, bounded bridge for rows written before this protection existed. */
  readonly legacyPlaintextReadUntil: Date | null;
  /** Test seam only; production uses the process clock. */
  readonly now?: () => Date;
}

export interface ProtectedBetterAuthSessionToken {
  readonly ciphertext: string;
  readonly lookupHash: string;
}

export interface BetterAuthSessionTokenProtector {
  protect(token: string): ProtectedBetterAuthSessionToken;
  reveal(storedToken: string): string;
  lookupHashes(token: string): readonly string[];
  legacyLookupValue(token: string): string | null;
}

/** Stable error class whose messages never contain token/key/ciphertext bytes. */
export class BetterAuthSessionTokenProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BetterAuthSessionTokenProtectionError';
  }
}

interface DerivedKey {
  readonly version: number;
  readonly encryptionKey: Buffer;
  readonly lookupKey: Buffer;
}

/**
 * Randomized AES-256-GCM envelope plus a purpose-separated keyed lookup value.
 *
 * Random encryption avoids equality leakage. The HMAC column supplies indexed
 * equality lookup without making ciphertext a bearer credential. Version IDs
 * live in both values, allowing the first key to rotate while retained keys
 * continue serving sessions minted before the rotation.
 */
export function createBetterAuthSessionTokenProtector(
  options: BetterAuthSessionTokenProtectionOptions,
): BetterAuthSessionTokenProtector {
  const keys = validateAndDeriveKeys(options.keys);
  const keyByVersion = new Map(keys.map((key) => [key.version, key]));
  const active = keys[0]!;
  const now = options.now ?? (() => new Date());
  const legacyDeadline = options.legacyPlaintextReadUntil === null
    ? null
    : new Date(options.legacyPlaintextReadUntil);
  if (legacyDeadline !== null && !Number.isFinite(legacyDeadline.getTime())) {
    throw new BetterAuthSessionTokenProtectionError('legacy plaintext deadline is invalid');
  }

  return Object.freeze({
    protect(token: string): ProtectedBetterAuthSessionToken {
      const plaintext = tokenBytes(token);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', active.encryptionKey, iv);
      cipher.setAAD(envelopeAad(active.version));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Object.freeze({
        ciphertext: [
          ENVELOPE_PREFIX,
          String(active.version),
          iv.toString('base64url'),
          ciphertext.toString('base64url'),
          tag.toString('base64url'),
        ].join('.'),
        lookupHash: lookupHash(active, token),
      });
    },
    reveal(storedToken: string): string {
      if (!storedToken.startsWith(`${ENVELOPE_PREFIX}.`)) {
        if (legacyAllowed(legacyDeadline, now())) return assertToken(storedToken);
        throw new BetterAuthSessionTokenProtectionError('plaintext session token is not accepted');
      }
      const parts = storedToken.split('.');
      if (parts.length !== 5 || parts[0] !== ENVELOPE_PREFIX) {
        throw new BetterAuthSessionTokenProtectionError('session token envelope is malformed');
      }
      const version = parseVersion(parts[1]);
      const key = keyByVersion.get(version);
      if (key === undefined) {
        throw new BetterAuthSessionTokenProtectionError('session token key version is unavailable');
      }
      const iv = decodePart(parts[2], IV_BYTES, 'iv');
      const ciphertext = decodePart(parts[3], undefined, 'ciphertext');
      const tag = decodePart(parts[4], TAG_BYTES, 'tag');
      if (ciphertext.length < 1 || ciphertext.length > MAX_TOKEN_BYTES) {
        throw new BetterAuthSessionTokenProtectionError('session token ciphertext length is invalid');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key.encryptionKey, iv);
        decipher.setAAD(envelopeAad(version));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const token = plaintext.toString('utf8');
        if (!Buffer.from(token, 'utf8').equals(plaintext)) {
          throw new BetterAuthSessionTokenProtectionError('session token plaintext encoding is invalid');
        }
        return assertToken(token);
      } catch (error) {
        if (error instanceof BetterAuthSessionTokenProtectionError) throw error;
        throw new BetterAuthSessionTokenProtectionError('session token authentication failed');
      }
    },
    lookupHashes(token: string): readonly string[] {
      assertToken(token);
      return Object.freeze(keys.map((key) => lookupHash(key, token)));
    },
    legacyLookupValue(token: string): string | null {
      assertToken(token);
      // Never let a leaked protected DB value enter the plaintext compatibility
      // branch, even while an explicit legacy window is open.
      if (token.startsWith(`${ENVELOPE_PREFIX}.`)) return null;
      return legacyAllowed(legacyDeadline, now()) ? token : null;
    },
  });
}

function validateAndDeriveKeys(
  input: readonly BetterAuthSessionTokenProtectionKey[],
): readonly DerivedKey[] {
  if (input.length < 1 || input.length > 8) {
    throw new BetterAuthSessionTokenProtectionError('session token keyring must contain 1 to 8 keys');
  }
  const versions = new Set<number>();
  const material = new Set<string>();
  const derived = input.map((entry) => {
    if (!Number.isSafeInteger(entry.version) || entry.version < 1 || entry.version > 2_147_483_647) {
      throw new BetterAuthSessionTokenProtectionError('session token key version is invalid');
    }
    if (!Buffer.isBuffer(entry.key) || entry.key.length !== KEY_BYTES) {
      throw new BetterAuthSessionTokenProtectionError('session token key must contain 32 bytes');
    }
    if (versions.has(entry.version)) {
      throw new BetterAuthSessionTokenProtectionError('session token key versions must be unique');
    }
    const fingerprint = entry.key.toString('base64');
    if (material.has(fingerprint)) {
      throw new BetterAuthSessionTokenProtectionError('session token key material must be unique');
    }
    versions.add(entry.version);
    material.add(fingerprint);
    return Object.freeze({
      version: entry.version,
      encryptionKey: deriveKey(entry.key, ENCRYPTION_CONTEXT, entry.version),
      lookupKey: deriveKey(entry.key, LOOKUP_CONTEXT, entry.version),
    });
  });
  return Object.freeze(derived);
}

function deriveKey(master: Buffer, context: string, version: number): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    master,
    HKDF_SALT,
    Buffer.from(`${context}:${version}`, 'utf8'),
    KEY_BYTES,
  ));
}

function lookupHash(key: DerivedKey, token: string): string {
  const digest = createHmac('sha256', key.lookupKey).update(token, 'utf8').digest('base64url');
  return `${LOOKUP_PREFIX}.${key.version}.${digest}`;
}

function envelopeAad(version: number): Buffer {
  return Buffer.from(`${ENVELOPE_PREFIX}:${version}`, 'utf8');
}

function tokenBytes(token: string): Buffer {
  assertToken(token);
  return Buffer.from(token, 'utf8');
}

function assertToken(token: string): string {
  if (!TOKEN_PATTERN.test(token) || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw new BetterAuthSessionTokenProtectionError('session token format is invalid');
  }
  return token;
}

function parseVersion(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new BetterAuthSessionTokenProtectionError('session token key version is invalid');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version > 2_147_483_647) {
    throw new BetterAuthSessionTokenProtectionError('session token key version is invalid');
  }
  return version;
}

function decodePart(value: string | undefined, expectedBytes: number | undefined, label: string): Buffer {
  if (value === undefined || !BASE64URL_PATTERN.test(value)) {
    throw new BetterAuthSessionTokenProtectionError(`session token ${label} is malformed`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value
      || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new BetterAuthSessionTokenProtectionError(`session token ${label} is malformed`);
  }
  return decoded;
}

function legacyAllowed(deadline: Date | null, current: Date): boolean {
  return deadline !== null && current.getTime() < deadline.getTime();
}

