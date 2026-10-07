import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface SyncRecoveryBoundary {
  readonly commitOrdinal: string;
  readonly streamKind: 'operation' | 'conflict';
  readonly stableId: string;
}

export interface SyncRecoveryCapabilityClaims {
  readonly purpose: 'sync-recovery-bootstrap-ack';
  readonly version: 1;
  readonly sessionId: string;
  readonly accountId: string;
  readonly replicaId: string;
  readonly collectionId: string;
  readonly oldLeaseGeneration: string;
  readonly purgeBoundary: SyncRecoveryBoundary;
  readonly snapshotId: string;
  readonly snapshotRevision: string;
  readonly snapshotPageCount: number;
  readonly snapshotNodeCount: number;
  readonly snapshotCursor: string;
}

export interface SyncRecoveryCapabilityKey {
  readonly id: string;
  readonly secret: string;
}

export type SyncRecoveryCapabilityVerification = Readonly<
  | { readonly valid: true; readonly claims: SyncRecoveryCapabilityClaims; readonly keyId: string;
      readonly expiresAt: number }
  | { readonly valid: false; readonly code: 'invalid_cursor_scope' | 'sync_cursor_expired' }
>;

export interface SyncRecoveryCapabilityKeyring {
  sign(claims: SyncRecoveryCapabilityClaims, issuedAt?: number, keyId?: string): string;
  /**
   * F006 replay: sign for an exact expiry instant instead of an issue instant. The
   * persisted capability row is immutable and the recovery Ack looks the token up by
   * digest, so a re-issue for the same identity must reproduce the stored token
   * (same key, same second-floored expiry -> same MAC) rather than mint a new window
   * the Ack could never resolve. `expiresAt` is floored to the second like `sign`.
   */
  signWithExpiry(claims: SyncRecoveryCapabilityClaims, expiresAt: number, keyId?: string): string;
  verify(capability: string, expected: SyncRecoveryCapabilityClaims): SyncRecoveryCapabilityVerification;
}

/**
 * Recovery capabilities (`src1.<keyId>.<expiry>.<claimsDigest>.<mac>`) are
 * request MACs over a claims digest, not the shared cursor codec payload
 * pattern. Left local; sync cannot import `commands`.
 */
export function createSyncRecoveryCapabilityKeyring(options: {
  readonly active: SyncRecoveryCapabilityKey;
  readonly retained: readonly SyncRecoveryCapabilityKey[];
  readonly ttlMs: number;
  readonly now?: () => number;
}): SyncRecoveryCapabilityKeyring {
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1_000 || options.ttlMs > 3_600_000) {
    throw new TypeError('Sync recovery capability TTL must be from one second through one hour.');
  }
  const all = [options.active, ...options.retained].map(parseKey);
  if (new Set(all.map((key) => key.id)).size !== all.length) throw new TypeError('Recovery key IDs must be unique.');
  const keys = new Map(all.map((key) => [key.id, key]));
  const mint = (claims: SyncRecoveryCapabilityClaims, expiresAt: number, requestedKeyId: string) => {
    const signingKey = keys.get(requestedKeyId);
    if (!signingKey) throw new TypeError('Requested recovery signing key is not retained.');
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new TypeError('Invalid recovery expiry.');
    const claimsDigest = digestClaims(claims);
    const expiry = Math.floor(expiresAt / 1_000).toString(36);
    const unsigned = `src1.${signingKey.id}.${expiry}.${claimsDigest}`;
    return `${unsigned}.${createHmac('sha256', signingKey.secret)
      .update(unsigned).digest('base64url')}`;
  };
  return Object.freeze({
    sign(rawClaims: SyncRecoveryCapabilityClaims, issuedAt = now(), requestedKeyId = options.active.id) {
      const claims = validateClaims(rawClaims);
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('Invalid recovery issue time.');
      return mint(claims, issuedAt + options.ttlMs, requestedKeyId);
    },
    signWithExpiry(rawClaims: SyncRecoveryCapabilityClaims, expiresAt: number,
      requestedKeyId = options.active.id) {
      const claims = validateClaims(rawClaims);
      return mint(claims, expiresAt, requestedKeyId);
    },
    verify(capability: string, rawExpected: SyncRecoveryCapabilityClaims) {
      const expected = validateClaims(rawExpected);
      const [version, keyId, rawExpiry, suppliedDigest, suppliedTag, extra] = capability.split('.');
      if (version !== 'src1' || !keyId || !rawExpiry || !suppliedDigest || !suppliedTag || extra) return invalid();
      const key = keys.get(keyId); if (!key) return invalid();
      const expiry = Number.parseInt(rawExpiry, 36) * 1_000;
      if (!Number.isSafeInteger(expiry)) return invalid();
      if (expiry <= now()) return Object.freeze({ valid: false, code: 'sync_cursor_expired' });
      const expectedDigest = digestClaims(expected);
      if (suppliedDigest !== expectedDigest) return invalid();
      const unsigned = [version, keyId, rawExpiry, suppliedDigest].join('.');
      const expectedTag = createHmac('sha256', key.secret).update(unsigned).digest();
      let supplied: Buffer;
      try { supplied = Buffer.from(suppliedTag, 'base64url'); } catch { return invalid(); }
      if (supplied.length !== expectedTag.length || supplied.toString('base64url') !== suppliedTag
          || !timingSafeEqual(supplied, expectedTag)) return invalid();
      return Object.freeze({ valid: true, claims: expected, keyId, expiresAt: expiry });
    },
  });
}

function parseKey(input: SyncRecoveryCapabilityKey) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.id) || /(?:sync[-_]?pull|publication|editor)/iu.test(input.id)) {
    throw new TypeError('Sync recovery capability key ID is invalid or belongs to another purpose.');
  }
  const secret = Buffer.from(input.secret, 'base64');
  if (secret.length < 32 || secret.toString('base64').replace(/=+$/u, '') !== input.secret.replace(/=+$/u, '')) {
    throw new TypeError('Sync recovery capability secret must be canonical base64 with at least 32 bytes.');
  }
  return Object.freeze({ id: input.id, secret });
}

function validateClaims(input: SyncRecoveryCapabilityClaims): SyncRecoveryCapabilityClaims {
  if (!input || input.purpose !== 'sync-recovery-bootstrap-ack' || input.version !== 1) throw new TypeError('Invalid recovery claims.');
  for (const value of [input.sessionId, input.accountId, input.replicaId, input.collectionId,
    input.oldLeaseGeneration,
    input.snapshotId, input.snapshotRevision, input.snapshotCursor, input.purgeBoundary?.commitOrdinal]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 8_192) {
      throw new TypeError('Invalid recovery capability scope.');
    }
  }
  const stableId = input.purgeBoundary?.stableId;
  if (typeof stableId !== 'string' || stableId.length > 8_192) {
    throw new TypeError('Invalid recovery capability scope.');
  }
  const initialBoundary = input.purgeBoundary.commitOrdinal === '0'
    && input.purgeBoundary.streamKind === 'operation' && stableId === '';
  if (!/^[1-9][0-9]*$/u.test(input.oldLeaseGeneration)
      || !/^(?:0|[1-9][0-9]*)$/u.test(input.purgeBoundary.commitOrdinal)
      || !['operation', 'conflict'].includes(input.purgeBoundary.streamKind)
      || !initialBoundary && stableId.length < 1
      || !Number.isSafeInteger(input.snapshotPageCount) || input.snapshotPageCount < 1
      || !Number.isSafeInteger(input.snapshotNodeCount) || input.snapshotNodeCount < 0) {
    throw new TypeError('Invalid recovery capability range.');
  }
  return Object.freeze({ ...input, purgeBoundary: Object.freeze({ ...input.purgeBoundary }) });
}

function digestClaims(claims: SyncRecoveryCapabilityClaims): string {
  return createHash('sha256').update(JSON.stringify([
    claims.purpose, claims.version, claims.sessionId, claims.accountId, claims.replicaId, claims.collectionId,
    claims.oldLeaseGeneration, claims.purgeBoundary.commitOrdinal, claims.purgeBoundary.streamKind,
    claims.purgeBoundary.stableId, claims.snapshotId, claims.snapshotRevision, claims.snapshotPageCount,
    claims.snapshotNodeCount, claims.snapshotCursor,
  ])).digest('base64url');
}

function invalid(): SyncRecoveryCapabilityVerification {
  return Object.freeze({ valid: false, code: 'invalid_cursor_scope' });
}
