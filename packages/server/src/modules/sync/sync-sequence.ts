import { createHash } from 'node:crypto';
import {
  collectionSequenceScopeKey,
  isVerifiedSyncSession,
  type VerifiedSyncSession,
} from '@know-n/colp/sync';
import {
  isVerifiedExtensionCredential,
  type VerifiedExtensionCredential,
} from '../identity/index.js';

/**
 * Session-bound `serverBatchId` contract violation inside Sequence admission.
 * Extends TypeError so existing `instanceof TypeError` guards keep working,
 * but lets the HTTP entry layer answer a 4xx document problem instead of
 * folding a recognized contract rejection into `internal_error` (F021).
 */
export class SyncSequenceBatchBindingError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SyncSequenceBatchBindingError';
  }
}

export interface SyncSequenceAdmissionInput {
  readonly session: VerifiedSyncSession;
  readonly replicaId: string;
  readonly leaseGeneration: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly operationId: string;
  readonly serverBatchId: string;
  readonly mediaType: string;
  readonly endpointIdentity: string;
  readonly payload: unknown;
  readonly transactionalAuthority?: {
    readonly credential: VerifiedExtensionCredential;
    readonly origin: string;
  };
  readonly reevaluateDeferred?: boolean;
  /** Transport-only observability values are accepted but never persisted or digested. */
  readonly requestId?: string;
  readonly date?: string;
  readonly traceId?: string;
}

export const SYNC_SEQUENCE_RECEIPT_RETENTION = Object.freeze({
  policy: 'replica_lifetime' as const,
  retainOperationClaimForever: true as const,
  retainReceiptThroughRetirement: true as const,
  purgeSupported: false as const,
});

/** HTTP attempt digest (Session/batch/endpoint). Stored on pre-T-07 receipts. */
export const SYNC_SEQUENCE_DIGEST_ATTEMPT_V1 = 'known.sync-sequence.v1';
/** Logical Operation digest: Replica lifetime, scope, sequence, opId, payload. */
export const SYNC_SEQUENCE_DIGEST_LOGICAL_V2 = 'known.sync-sequence.logical.v2';

const INPUT_KEYS = new Set([
  'session', 'replicaId', 'leaseGeneration', 'sequenceScope', 'sequence', 'operationId',
  'serverBatchId', 'mediaType', 'endpointIdentity', 'payload', 'reevaluateDeferred',
  'transactionalAuthority',
  'requestId', 'date', 'traceId',
]);

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} must contain enumerable data properties only`);
    }
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function canonicalCounter(value: unknown, label: string): string {
  const text = nonEmpty(value, label, 32);
  if (!/^[1-9][0-9]*$/.test(text) || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return text;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Sequence binding contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('Sequence binding must contain JSON data only');
  if (seen.has(value)) throw new TypeError('Sequence binding must not contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    const record = plainRecord(value, 'Sequence binding JSON object');
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function attemptDigestParts(input: {
  readonly sessionId: string;
  readonly leaseGeneration: string;
  readonly serverBatchId: string;
  readonly replicaId: string;
  readonly sequenceScope: string;
  readonly sequence: number;
  readonly operationId: string;
  readonly endpointIdentity: string;
  readonly mediaType: string;
  readonly payload: unknown;
}): string {
  return digest({
    contract: SYNC_SEQUENCE_DIGEST_ATTEMPT_V1,
    sessionId: input.sessionId,
    leaseGeneration: input.leaseGeneration,
    serverBatchId: input.serverBatchId,
    replicaId: input.replicaId,
    sequenceScope: input.sequenceScope,
    sequence: input.sequence,
    operationId: input.operationId,
    endpointIdentity: input.endpointIdentity,
    mediaType: input.mediaType,
    payload: input.payload,
  });
}

/** Pre-T-07 digest: includes HTTP attempt fields. Used only to prove old receipts. */
export function canonicalSyncSequenceAttemptDigest(input: SyncSequenceAdmissionInput): string {
  return attemptDigestParts({
    sessionId: input.session.sessionId,
    leaseGeneration: input.leaseGeneration,
    serverBatchId: input.serverBatchId,
    replicaId: input.replicaId,
    sequenceScope: input.sequenceScope,
    sequence: input.sequence,
    operationId: input.operationId,
    endpointIdentity: input.endpointIdentity,
    mediaType: input.mediaType,
    payload: input.payload,
  });
}

/** Logical Operation digest. Session, Bearer, batch, and endpoint are attempt identity. */
export function canonicalSyncSequenceLogicalDigest(input: Pick<SyncSequenceAdmissionInput,
  'replicaId' | 'sequenceScope' | 'sequence' | 'operationId' | 'payload'>): string {
  return digest({
    contract: SYNC_SEQUENCE_DIGEST_LOGICAL_V2,
    replicaId: input.replicaId,
    sequenceScope: input.sequenceScope,
    sequence: input.sequence,
    operationId: input.operationId,
    payload: input.payload,
  });
}

/** Current Sequence replay identity is the logical Operation, not the HTTP attempt. */
export function canonicalSyncSequenceDigest(input: SyncSequenceAdmissionInput): string {
  return canonicalSyncSequenceLogicalDigest(input);
}

/**
 * In-memory COLP digest for a stored receipt. Never persists an overwrite.
 * A digest-algorithm change is not unconditional `sequence_reuse`.
 */
export function presentSequenceReceiptDigest(input: {
  readonly storedDigest: string;
  readonly storedAlgorithm?: string | null;
  readonly storedAttempt: {
    readonly sessionId: string;
    readonly leaseGeneration: string;
    readonly serverBatchId: string;
    readonly mediaType: string;
    readonly endpointIdentity: string;
  };
  readonly request: SyncSequenceAdmissionInput;
}): string {
  const logical = canonicalSyncSequenceLogicalDigest(input.request);
  if (input.storedDigest === logical) return logical;
  if (input.storedAlgorithm === SYNC_SEQUENCE_DIGEST_LOGICAL_V2) return input.storedDigest;
  const reconstructed = attemptDigestParts({
    sessionId: input.storedAttempt.sessionId,
    leaseGeneration: input.storedAttempt.leaseGeneration,
    serverBatchId: input.storedAttempt.serverBatchId,
    replicaId: input.request.replicaId,
    sequenceScope: input.request.sequenceScope,
    sequence: input.request.sequence,
    operationId: input.request.operationId,
    endpointIdentity: input.storedAttempt.endpointIdentity,
    mediaType: input.storedAttempt.mediaType,
    payload: input.request.payload,
  });
  if (reconstructed === input.storedDigest) return logical;
  return input.storedDigest;
}

/** Adapter rows (v1 or v2) presented as the current logical digest when Operation bytes match. */
export function presentSequenceReceiptDigestFromStored(
  row: Record<string, unknown>,
  request: SyncSequenceAdmissionInput,
): string {
  return presentSequenceReceiptDigest({
    storedDigest: String(row.canonical_digest),
    storedAlgorithm: row.digest_algorithm == null ? null : String(row.digest_algorithm),
    storedAttempt: {
      sessionId: String(row.session_id),
      leaseGeneration: String(row.lease_generation),
      serverBatchId: String(row.server_batch_id),
      mediaType: String(row.media_type),
      endpointIdentity: String(row.endpoint_identity),
    },
    request,
  });
}

export function canonicalSyncSequenceResultDigest(result: unknown): string {
  return digest({ contract: 'known.sync-sequence-result.v1', result });
}

export function validateSyncSequenceAdmissionInput(value: unknown): Readonly<SyncSequenceAdmissionInput> {
  const input = plainRecord(value, 'Sync Sequence admission');
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw new TypeError('Sync Sequence admission contains an unknown field');
  }
  for (const key of [
    'session', 'replicaId', 'leaseGeneration', 'sequenceScope', 'sequence', 'operationId',
    'serverBatchId', 'mediaType', 'endpointIdentity', 'payload',
  ]) if (!Object.hasOwn(input, key)) throw new TypeError('Sync Sequence admission is incomplete');
  if (!isVerifiedSyncSession(input.session)) throw new TypeError('Verified Sync Session is required');
  const session = input.session;
  if (session.sessionScope !== 'collection' || !session.collectionId
      || !session.authorizationScopes.includes('sync:push')) {
    throw new TypeError('Collection-bound Sync Push Session is required');
  }
  const replicaId = nonEmpty(input.replicaId, 'Replica ID', 128);
  const sequenceScope = nonEmpty(input.sequenceScope, 'Sequence scope', 640);
  if (sequenceScope !== collectionSequenceScopeKey(session.collectionId)) {
    throw new TypeError('Sequence scope must match the verified Session Collection');
  }
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1) {
    throw new TypeError('Sequence must be a positive safe integer');
  }
  const operationId = nonEmpty(input.operationId, 'Operation ID', 512);
  const serverBatchId = nonEmpty(input.serverBatchId, 'Server batch ID', 512);
  if (serverBatchId !== session.sessionId
      && !(serverBatchId.startsWith(`${session.sessionId}.`)
        && serverBatchId.length > session.sessionId.length + 1)) {
    throw new SyncSequenceBatchBindingError('Server batch ID must be bound to the verified Session');
  }
  if (input.reevaluateDeferred !== undefined && typeof input.reevaluateDeferred !== 'boolean') {
    throw new TypeError('Deferred reevaluation flag must be boolean');
  }
  let transactionalAuthority: SyncSequenceAdmissionInput['transactionalAuthority'];
  if (input.transactionalAuthority !== undefined) {
    const authority = plainRecord(input.transactionalAuthority, 'Sequence transactional authority');
    if (Object.keys(authority).sort().join('\0') !== 'credential\0origin'
        || !isVerifiedExtensionCredential(authority.credential)) {
      throw new TypeError('Sequence transactional authority requires verified credential evidence');
    }
    const origin = nonEmpty(authority.origin, 'Sequence transactional authority origin', 2048);
    if (origin !== session.origin) {
      throw new TypeError('Sequence transactional authority Origin must match the verified Session');
    }
    transactionalAuthority = Object.freeze({ credential: authority.credential, origin });
  }
  for (const name of ['requestId', 'date', 'traceId'] as const) {
    if (input[name] !== undefined) nonEmpty(input[name], name, 2048);
  }
  canonicalSyncSequenceResultDigest(input.payload);
  const validated: SyncSequenceAdmissionInput = {
    session,
    replicaId,
    leaseGeneration: canonicalCounter(input.leaseGeneration, 'Lease generation'),
    sequenceScope,
    sequence: input.sequence as number,
    operationId,
    serverBatchId,
    mediaType: nonEmpty(input.mediaType, 'Media type', 255),
    endpointIdentity: nonEmpty(input.endpointIdentity, 'Endpoint identity', 512),
    payload: input.payload,
    ...(transactionalAuthority === undefined ? {} : { transactionalAuthority }),
    ...(input.reevaluateDeferred === undefined ? {} : { reevaluateDeferred: input.reevaluateDeferred }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId as string }),
    ...(input.date === undefined ? {} : { date: input.date as string }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId as string }),
  };
  canonicalSyncSequenceDigest(validated);
  return Object.freeze(validated);
}
