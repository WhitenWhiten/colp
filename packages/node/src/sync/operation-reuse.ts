import {
  reserveServerIds,
  ServerIdAlreadyReservedError,
  type ServerIdReservationTransaction,
} from '../shared/server-id-reservations.js';
import {
  assertNonEmpty,
  requirePromise,
} from './internal-guards.js';

export type SyncOperationReuseCode = 'sequence_reuse' | 'op_id_reused';

export interface SyncOperationClaim {
  readonly operationId: string;
  readonly digest: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
}

export interface SyncOperationClaimStore {
  load(operationId: string): Promise<SyncOperationClaim | undefined>;
  /**
   * Stages lifetime metadata for an Operation ID already reserved in the shared
   * server-ID ledger. Committed claims MUST survive receipt and Operation cleanup;
   * a retry that then finds a claim without its receipt is reported with
   * {@link SyncOperationReceiptUnavailableError}.
   * There is intentionally no delete or release operation.
   */
  save(claim: SyncOperationClaim): Promise<void>;
}

export interface SyncOperationReuseAudit {
  readonly code: SyncOperationReuseCode;
  readonly attempted: SyncOperationClaim;
  readonly stored: SyncOperationClaim;
}

export interface SyncOperationReuseAuditStore {
  /** Returns a durable transaction-local key suitable for immediate read-back. */
  append(audit: SyncOperationReuseAudit): Promise<string>;
  load(key: string): Promise<SyncOperationReuseAudit | undefined>;
}

export interface SyncOperationReuseTransaction extends ServerIdReservationTransaction {
  readonly operationClaims: SyncOperationClaimStore;
  readonly reuseAudits: SyncOperationReuseAuditStore;
}

export type SyncOperationClaimResult =
  | { readonly kind: 'claimed'; readonly claim: SyncOperationClaim }
  | { readonly kind: 'existing'; readonly claim: SyncOperationClaim };

export type SyncOperationClaimsResult =
  | { readonly kind: 'claimed'; readonly claims: readonly SyncOperationClaim[] }
  | {
      readonly kind: 'existing';
      readonly attempted: SyncOperationClaim;
      readonly claim: SyncOperationClaim;
    };

export class SyncOperationReuseError extends Error {
  readonly status = 409 as const;
  readonly code: SyncOperationReuseCode;
  readonly auditKey: string;
  readonly audit: SyncOperationReuseAudit;

  constructor(auditKey: string, audit: SyncOperationReuseAudit) {
    assertNonEmpty(auditKey, 'Sync Operation reuse audit key');
    const checkedAudit = immutableAudit(audit);
    super(`Sync Operation denied with ${checkedAudit.code}.`);
    this.name = 'SyncOperationReuseError';
    this.code = checkedAudit.code;
    this.auditKey = auditKey;
    this.audit = checkedAudit;
  }
}

/**
 * A retry reached an Operation whose lifetime claim (or consumed Sequence)
 * is still recorded but whose receipt is no longer stored — typically after
 * receipt retention cleanup. The stored result cannot be replayed and the
 * Operation must not run again.
 *
 * Hosts should answer with a non-retryable Problem telling the client that the
 * Operation was already consumed and its result is gone (for example by
 * re-synchronising from a Snapshot). It extends `TypeError` because an adapter
 * that loses a receipt it was required to keep reports the same way; hosts
 * that never purge receipts can keep treating it as an adapter fault.
 */
export class SyncOperationReceiptUnavailableError extends TypeError {
  readonly code = 'receipt_unavailable' as const;
  /** Retained lifetime claim, when one identified the consumed Operation. */
  readonly claim: SyncOperationClaim | undefined;

  constructor(message: string, claim?: SyncOperationClaim) {
    super(message);
    this.name = 'SyncOperationReceiptUnavailableError';
    this.claim = claim === undefined ? undefined : immutableSyncOperationClaim(claim);
  }
}

function assertPlainObject(candidate: object, keys: readonly string[], label: string): void {
  if (Array.isArray(candidate)) throw new TypeError(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  const actual = Reflect.ownKeys(candidate);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label} must contain only its canonical data members.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
  }
}

export function immutableSyncOperationClaim(candidate: SyncOperationClaim): SyncOperationClaim {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Sync Operation claim must be an object.');
  }
  assertPlainObject(
    candidate,
    ['operationId', 'digest', 'replicaId', 'sequenceScope', 'sequence'],
    'Sync Operation claim',
  );
  assertNonEmpty(candidate.operationId, 'Sync Operation claim operationId');
  assertNonEmpty(candidate.digest, 'Sync Operation claim digest');
  assertNonEmpty(candidate.replicaId, 'Sync Operation claim replicaId');
  assertNonEmpty(candidate.sequenceScope, 'Sync Operation claim sequenceScope');
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    throw new TypeError('Sync Operation claim sequence must be a positive safe integer.');
  }
  return Object.freeze({
    operationId: candidate.operationId,
    digest: candidate.digest,
    replicaId: candidate.replicaId,
    sequenceScope: candidate.sequenceScope,
    sequence: candidate.sequence,
  });
}

function immutableAudit(candidate: SyncOperationReuseAudit): SyncOperationReuseAudit {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('Sync Operation reuse audit must be an object.');
  }
  assertPlainObject(candidate, ['code', 'attempted', 'stored'], 'Sync Operation reuse audit');
  if (candidate.code !== 'sequence_reuse' && candidate.code !== 'op_id_reused') {
    throw new TypeError('Sync Operation reuse audit has an invalid code.');
  }
  return Object.freeze({
    code: candidate.code,
    attempted: immutableSyncOperationClaim(candidate.attempted),
    stored: immutableSyncOperationClaim(candidate.stored),
  });
}

function sameClaim(left: SyncOperationClaim, right: SyncOperationClaim): boolean {
  return left.operationId === right.operationId
    && left.digest === right.digest
    && left.replicaId === right.replicaId
    && left.sequenceScope === right.sequenceScope
    && left.sequence === right.sequence;
}

export async function loadSyncOperationClaim(
  store: SyncOperationClaimStore,
  operationId: string,
): Promise<SyncOperationClaim | undefined> {
  assertNonEmpty(operationId, 'Sync Operation ID');
  const raw = await requirePromise(store.load(operationId), 'Sync Operation claim load');
  if (raw === undefined) return undefined;
  const claim = immutableSyncOperationClaim(raw);
  if (claim.operationId !== operationId) {
    throw new TypeError('Sync Operation claim store returned a claim for another Operation ID.');
  }
  return claim;
}

export async function claimSyncOperation(
  transaction: SyncOperationReuseTransaction,
  candidate: SyncOperationClaim,
): Promise<SyncOperationClaimResult> {
  const claim = immutableSyncOperationClaim(candidate);
  const result = await claimSyncOperations(transaction, [claim]);
  return result.kind === 'claimed'
    ? Object.freeze({ kind: 'claimed', claim: result.claims[0]! })
    : Object.freeze({ kind: 'existing', claim: result.claim });
}

export async function claimSyncOperations(
  transaction: SyncOperationReuseTransaction,
  candidates: readonly SyncOperationClaim[],
): Promise<SyncOperationClaimsResult> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('Sync Operation claims must be a non-empty array.');
  }
  const claims = Object.freeze(candidates.map(immutableSyncOperationClaim));
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.operationId)) {
      throw new TypeError('Sync Operation claim batch contains a duplicate Operation ID.');
    }
    seen.add(claim.operationId);
    const loaded = await loadSyncOperationClaim(transaction.operationClaims, claim.operationId);
    if (loaded !== undefined) {
      return Object.freeze({ kind: 'existing', attempted: claim, claim: loaded });
    }
  }

  try {
    await reserveServerIds(
      transaction,
      claims.map((claim) => ({ id: claim.operationId, resourceType: 'operation' as const })),
    );
  } catch (error) {
    if (
      !(error instanceof ServerIdAlreadyReservedError)
      || error.conflict.existing.resourceType !== 'operation'
    ) {
      throw error;
    }
    const attempted = claims.find((claim) => claim.operationId === error.conflict.requested.id);
    if (attempted === undefined) throw error;
    const concurrent = await loadSyncOperationClaim(transaction.operationClaims, attempted.operationId);
    if (concurrent === undefined) throw error;
    return Object.freeze({ kind: 'existing', attempted, claim: concurrent });
  }

  const reloadedClaims: SyncOperationClaim[] = [];
  for (const claim of claims) {
    await requirePromise(
      transaction.operationClaims.save(structuredClone(claim)),
      'Sync Operation claim save',
    );
    const reloaded = await loadSyncOperationClaim(transaction.operationClaims, claim.operationId);
    if (reloaded === undefined || !sameClaim(reloaded, claim)) {
      throw new TypeError('Sync Operation claim failed transaction-local read-back verification.');
    }
    reloadedClaims.push(reloaded);
  }
  return Object.freeze({ kind: 'claimed', claims: Object.freeze(reloadedClaims) });
}

export async function appendSyncOperationReuseAudit(
  store: SyncOperationReuseAuditStore,
  code: SyncOperationReuseCode,
  attemptedCandidate: SyncOperationClaim,
  storedCandidate: SyncOperationClaim,
): Promise<{ readonly key: string; readonly audit: SyncOperationReuseAudit }> {
  const audit = immutableAudit({
    code,
    attempted: attemptedCandidate,
    stored: storedCandidate,
  });
  const key = await requirePromise(
    store.append(structuredClone(audit)),
    'Sync Operation reuse audit append',
  );
  assertNonEmpty(key, 'Sync Operation reuse audit key');
  const reloadedRaw = await requirePromise(store.load(key), 'Sync Operation reuse audit read-back');
  if (reloadedRaw === undefined) {
    throw new TypeError('Sync Operation reuse audit was not available for transaction-local read-back.');
  }
  const reloaded = immutableAudit(reloadedRaw);
  if (
    reloaded.code !== audit.code
    || !sameClaim(reloaded.attempted, audit.attempted)
    || !sameClaim(reloaded.stored, audit.stored)
  ) {
    throw new TypeError('Sync Operation reuse audit failed transaction-local read-back verification.');
  }
  return Object.freeze({ key, audit: reloaded });
}

export function syncOperationClaimsMatch(
  leftCandidate: SyncOperationClaim,
  rightCandidate: SyncOperationClaim,
): boolean {
  return sameClaim(
    immutableSyncOperationClaim(leftCandidate),
    immutableSyncOperationClaim(rightCandidate),
  );
}
