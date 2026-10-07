import {
  createPublicationDirectoryCursor,
  createPublicationDirectoryCursorHmacKey,
  createPublicationSnapshotCursor,
  createPublicationSnapshotCursorHmacKey,
  verifyPublicationDirectoryCursor,
  verifyPublicationSnapshotCursor,
  type PublicationDirectoryCursorContext,
  type PublicationDirectoryCursorHmacKey,
  type PublicationDirectoryCursorScope,
  type PublicationSnapshotCursorContext as ColpPublicationSnapshotCursorContext,
  type PublicationSnapshotCursorHmacKey,
  type PublicationSnapshotCursorScope as ColpPublicationSnapshotCursorScope,
} from '@know-n/colp/server';
import {
  canonicalJson,
  createKeyedCursorCodec,
  deriveHkdfSha256,
  isCursorKeyId,
  type KeyedCursorCodec,
} from '../../commands/index.js';

export const PUBLICATION_CURSOR_PURPOSES = Object.freeze({
  snapshot: 'publication-snapshot',
  directory: 'publication-directory',
  product: 'product-public-page',
  profile: 'product-public-profile',
} as const);
export const PUBLIC_PROFILE_CURSOR_TTL_MS = 15 * 60 * 1000;
const PUBLICATION_CURSOR_HKDF_SALT = 'known/publication/cursor/v1';

export interface PublicationCursorKeyConfig {
  readonly id: string;
  /** Base64-encoded deployment secret containing at least 32 random bytes. */
  readonly secret: string;
}

export interface PublicationCursorKeyringConfig {
  readonly active: PublicationCursorKeyConfig;
  readonly retained: readonly PublicationCursorKeyConfig[];
}

export type PublicationCursorVerification =
  | { readonly valid: true; readonly nextPosition: string }
  | { readonly valid: false; readonly code: 'invalid_cursor_scope' };

export interface PublicationSnapshotCursorContext extends ColpPublicationSnapshotCursorContext {
  /** Comparator contract used to interpret nextPosition. Bound into the cursor MAC only. */
  readonly comparatorVersion: string;
}

export interface PublicationSnapshotCursorScope extends PublicationSnapshotCursorContext {
  readonly nextPosition: string;
}

export interface PublicationCursorKeyring {
  readonly destroyed: boolean;
  readonly activeKeyId: string;
  readonly snapshot: {
    sign(scope: PublicationSnapshotCursorScope): string;
    verify(cursor: string, context: PublicationSnapshotCursorContext): PublicationCursorVerification;
  };
  readonly directory: {
    sign(scope: PublicationDirectoryCursorScope): string;
    verify(cursor: string, context: PublicationDirectoryCursorContext): PublicationCursorVerification;
  };
  readonly product: {
    sign(scope: Readonly<Record<string, unknown>>): string;
    verify(cursor: string, expected: Readonly<Record<string, unknown>>): PublicationCursorVerification;
  };
  readonly profile: {
    sign(scope: Readonly<Record<string, unknown>>): string;
    verify(cursor: string, expected: Readonly<Record<string, unknown>>): PublicationCursorVerification;
  };
  destroy(): void;
}

interface ImportedKey {
  readonly id: string;
  readonly snapshot: PublicationSnapshotCursorHmacKey;
  readonly directory: PublicationDirectoryCursorHmacKey;
}

const invalid = Object.freeze({ valid: false, code: 'invalid_cursor_scope' } as const);

export function createPublicationCursorKeyring(
  config: PublicationCursorKeyringConfig,
): PublicationCursorKeyring {
  const normalized = normalizeConfig(config);
  const imported = normalized.map(importColpKey);
  const active = imported[0]!;
  const productCodec = createPrivateCursorCodec('ppc1', PUBLICATION_CURSOR_PURPOSES.product, normalized);
  const profileCodec = createPrivateCursorCodec('ppf1', PUBLICATION_CURSOR_PURPOSES.profile, normalized);
  let destroyed = false;

  function requireActive(): ImportedKey {
    if (destroyed) throw new Error('Publication cursor keyring is destroyed');
    return active;
  }

  const keyring: PublicationCursorKeyring = {
    get destroyed() { return destroyed; },
    activeKeyId: active.id,
    snapshot: Object.freeze({
      sign(scope) {
        return createPublicationSnapshotCursor(authenticatedSnapshotScope(scope), requireActive().snapshot);
      },
      verify(cursor, context) {
        if (destroyed) return invalid;
        for (const key of imported) {
          const result = verifyPublicationSnapshotCursor(cursor, authenticatedSnapshotContext(context), key.snapshot);
          if (result.valid) return result;
        }
        return invalid;
      },
    }),
    directory: Object.freeze({
      sign(scope) {
        return createPublicationDirectoryCursor(scope, requireActive().directory);
      },
      verify(cursor, context) {
        if (destroyed) return invalid;
        for (const key of imported) {
          const result = verifyPublicationDirectoryCursor(cursor, context, key.directory);
          if (result.valid) return result;
        }
        return invalid;
      },
    }),
    product: Object.freeze({
      sign(scope) {
        requireActive();
        return productCodec.sign(scope);
      },
      verify(cursor, expected) {
        return verifyPrivateCursor(productCodec, cursor, expected, destroyed, false);
      },
    }),
    profile: Object.freeze({
      sign(scope) {
        requireActive();
        return profileCodec.sign({
          ...scope,
          expiresAt: Date.now() + PUBLIC_PROFILE_CURSOR_TTL_MS,
        });
      },
      verify(cursor, expected) {
        return verifyPrivateCursor(profileCodec, cursor, expected, destroyed, true);
      },
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      productCodec.destroy();
      profileCodec.destroy();
      for (const key of imported) {
        key.snapshot.destroy();
        key.directory.destroy();
      }
    },
  };
  return Object.freeze(keyring);
}

function authenticatedSnapshotContext(
  context: PublicationSnapshotCursorContext,
): ColpPublicationSnapshotCursorContext {
  const { comparatorVersion, revision, ...rest } = context;
  return {
    ...rest,
    revision: JSON.stringify({ comparatorVersion, revision }),
  };
}

function authenticatedSnapshotScope(
  scope: PublicationSnapshotCursorScope,
): ColpPublicationSnapshotCursorScope {
  const { nextPosition, ...context } = scope;
  return { ...authenticatedSnapshotContext(context), nextPosition };
}

function normalizeConfig(config: PublicationCursorKeyringConfig): readonly PublicationCursorKeyConfig[] {
  if (!config || typeof config !== 'object' || !config.active || !Array.isArray(config.retained)) {
    throw new Error('Publication cursor keyring configuration is required');
  }
  const all = [config.active, ...config.retained].map((key, index) => {
    if (!key || typeof key !== 'object' || !isCursorKeyId(key.id)) {
      throw new Error(`Publication cursor key ${index} has an invalid id`);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(key.secret, 'base64');
    } catch {
      throw new Error(`Publication cursor key ${index} has invalid secret encoding`);
    }
    if (bytes.byteLength < 32 || bytes.toString('base64') !== key.secret) {
      bytes.fill(0);
      throw new Error(`Publication cursor key ${index} secret must be canonical base64 with at least 32 bytes`);
    }
    bytes.fill(0);
    return Object.freeze({ id: key.id, secret: key.secret });
  });
  if (new Set(all.map((key) => key.id)).size !== all.length) {
    throw new Error('Publication cursor key ids must be unique');
  }
  if (new Set(all.map((key) => key.secret)).size !== all.length) {
    throw new Error('Publication cursor key material must not be reused');
  }
  return Object.freeze(all);
}

function importColpKey(config: PublicationCursorKeyConfig): ImportedKey {
  const secret = Buffer.from(config.secret, 'base64');
  try {
    const snapshot = derive(secret, PUBLICATION_CURSOR_PURPOSES.snapshot);
    const directory = derive(secret, PUBLICATION_CURSOR_PURPOSES.directory);
    try {
      return Object.freeze({
        id: config.id,
        snapshot: createPublicationSnapshotCursorHmacKey(snapshot),
        directory: createPublicationDirectoryCursorHmacKey(directory),
      });
    } finally {
      snapshot.fill(0);
      directory.fill(0);
    }
  } finally {
    secret.fill(0);
  }
}

function createPrivateCursorCodec(
  prefix: 'ppc1' | 'ppf1',
  purpose: typeof PUBLICATION_CURSOR_PURPOSES.product | typeof PUBLICATION_CURSOR_PURPOSES.profile,
  keys: readonly PublicationCursorKeyConfig[],
): KeyedCursorCodec<Record<string, unknown>> {
  const current = keys[0]!;
  return createKeyedCursorCodec({
    mode: 'hmac-sha256',
    hmac: {
      variant: 'prefixed',
      prefix,
      encoding: 'ascii',
      hkdfSalt: PUBLICATION_CURSOR_HKDF_SALT,
      purpose,
    },
    keys: {
      current: { id: current.id, secret: current.secret },
      previous: keys.slice(1),
    },
    invalid: () => new Error('invalid publication cursor'),
    validate: assertPrivateCursorPayload,
    messages: {
      invalidKey: 'Publication cursor key has an invalid id',
      canonicalSecret: 'Publication cursor key secret must be canonical base64 with at least 32 bytes',
      uniqueKeys: 'Publication cursor key ids must be unique',
    },
  });
}

function verifyPrivateCursor(
  codec: KeyedCursorCodec<Record<string, unknown>>,
  cursor: string,
  expected: Readonly<Record<string, unknown>>,
  destroyed: boolean,
  expires: boolean,
): PublicationCursorVerification {
  if (destroyed || typeof cursor !== 'string') return invalid;
  let decoded: Record<string, unknown>;
  try {
    decoded = codec.verify(cursor, new Date());
  } catch {
    return invalid;
  }
  if (typeof decoded.nextPosition !== 'string') return invalid;
  const decodedContext = { ...decoded };
  delete decodedContext.nextPosition;
  if (expires) {
    const expiresAt = decodedContext.expiresAt;
    delete decodedContext.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return invalid;
  }
  if (canonicalJson(decodedContext) !== canonicalJson(expected)) return invalid;
  return decoded.nextPosition
    ? Object.freeze({ valid: true, nextPosition: decoded.nextPosition })
    : invalid;
}

function assertPrivateCursorPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.nextPosition !== 'string') throw new Error();
  return value;
}

function derive(secret: Buffer, purpose: string): Buffer {
  return deriveHkdfSha256(secret, PUBLICATION_CURSOR_HKDF_SALT, purpose);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
