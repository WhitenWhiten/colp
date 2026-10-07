import { createHash } from 'node:crypto';
import type { ProblemCode } from '@know-n/colp/server';
import { createValidatorRegistry } from '@know-n/colp/schema';
import type { ConflictResolutionRequest, ConflictResolutionResult } from '@know-n/colp/types';
import type { VerifiedExtensionCredential } from '../identity/index.js';

export interface SyncConflictResolutionInput {
  readonly credential: VerifiedExtensionCredential;
  readonly sessionId: string;
  readonly replicaId: string;
  readonly collectionId: string;
  readonly conflictId: string;
  readonly idempotencyKey: string;
  readonly ifMatch: readonly string[];
  readonly request: ConflictResolutionRequest;
}

export interface ValidatedSyncConflictResolutionCommand {
  readonly conflictId: string;
  readonly idempotencyKey: string;
  readonly conflictRevision: string;
  readonly resolution: 'server' | 'incoming' | 'custom' | 'both';
  readonly value?: unknown;
  readonly request: ConflictResolutionRequest;
}

export interface SyncConflictResolutionApplication {
  resolve(input: SyncConflictResolutionInput): Promise<ConflictResolutionResult>;
}

export class SyncConflictResolutionError extends Error {
  constructor(
    public readonly code: ProblemCode,
    public readonly currentRevision?: string,
  ) {
    super(`Sync Conflict resolution denied: ${code}`);
    this.name = 'SyncConflictResolutionError';
  }
}

const validators = createValidatorRegistry();
const STRONG_ETAG = /^"([A-Za-z0-9._~-]{1,128})"$/u;

function deny(code: ProblemCode, currentRevision?: string): never {
  throw new SyncConflictResolutionError(code, currentRevision);
}

export function validateSyncConflictResolutionCommand(
  input: Pick<SyncConflictResolutionInput, 'conflictId' | 'idempotencyKey' | 'ifMatch' | 'request'>,
): Readonly<ValidatedSyncConflictResolutionCommand> {
  if (!input || typeof input !== 'object') deny('invalid_document');
  if (!Array.isArray(input.ifMatch) || input.ifMatch.length === 0) deny('precondition_required');
  if (input.ifMatch.length !== 1) deny('invalid_document');
  const match = STRONG_ETAG.exec(input.ifMatch[0] ?? '');
  if (!match || input.ifMatch[0]!.includes(',') || input.ifMatch[0] === '*') deny('invalid_document');
  if (typeof input.conflictId !== 'string' || !validators.validate('opaqueId', input.conflictId).valid
      || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1
      || input.idempotencyKey.length > 256
      || !validators.validate('conflictResolutionRequest', input.request).valid) {
    deny('invalid_document');
  }
  const conflictRevision = match[1]!;
  if (input.request.baseConflictRevision !== conflictRevision) deny('precondition_failed');
  return Object.freeze({
    conflictId: input.conflictId,
    idempotencyKey: input.idempotencyKey,
    conflictRevision,
    resolution: input.request.resolution,
    ...(input.request.resolution === 'custom' ? { value: input.request.value } : {}),
    request: Object.freeze({ ...input.request }),
  });
}

export function canonicalSyncConflictResolutionDigest(
  command: ValidatedSyncConflictResolutionCommand,
): string {
  return createHash('sha256').update(stableJson({
    conflictId: command.conflictId,
    conflictRevision: command.conflictRevision,
    request: command.request,
  }), 'utf8').digest('hex');
}

/**
 * SYNC-R01: server-authored claim for the next Sequence slot in the resolver's own
 * lane. The claim never carries a client Sequence input; the lane position is always
 * allocated by the server inside the resolution transaction. The source operation
 * stays referenced only through the Conflict/dependency identity.
 */
export interface SyncResolutionLaneClaim {
  readonly replicaId: string;
  readonly collectionId: string;
  readonly sessionId: string;
  readonly operationId: string;
  /** 64-hex digest binding the resolution command (never the source Sequence). */
  readonly canonicalDigest: string;
  /** Plain JSON result persisted on the terminal Sequence receipt. */
  readonly result: Readonly<Record<string, unknown>>;
}

/** Immutable receipt binding identity for server-authored resolution lane claims. */
export const SYNC_RESOLUTION_LANE_RECEIPT_BINDING = Object.freeze({
  serverBatchSuffix: 'conflict-resolution' as const,
  mediaType: 'application/colp+json' as const,
  endpointIdentity: 'known.sync.conflict-resolution' as const,
  status: 'applied' as const,
});

const RESOLUTION_LANE_CLAIM_KEYS = new Set([
  'replicaId', 'collectionId', 'sessionId', 'operationId', 'canonicalDigest', 'result',
]);

function protocolBounded(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

export function validateSyncResolutionLaneClaim(
  value: unknown,
): Readonly<SyncResolutionLaneClaim> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Sync resolution lane claim must be a plain object');
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !RESOLUTION_LANE_CLAIM_KEYS.has(key)
        || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('Sync resolution lane claim contains an invalid field');
    }
  }
  for (const key of ['replicaId', 'collectionId', 'sessionId', 'operationId',
    'canonicalDigest', 'result'] as const) {
    if (!Object.hasOwn(value, key)) throw new TypeError('Sync resolution lane claim is incomplete');
  }
  const record = value as Record<string, unknown>;
  const replicaId = protocolBounded(record.replicaId, 'Replica ID');
  const collectionId = protocolBounded(record.collectionId, 'Collection ID');
  const sessionId = protocolBounded(record.sessionId, 'Session ID');
  const operationId = protocolBounded(record.operationId, 'Operation ID', 512);
  const canonicalDigest = protocolBounded(record.canonicalDigest, 'Canonical digest', 64);
  if (!/^[0-9a-f]{64}$/.test(canonicalDigest)) {
    throw new TypeError('Canonical digest must be a 64-character hex string');
  }
  const result = record.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)
      || Object.getPrototypeOf(result) !== Object.prototype) {
    throw new TypeError('Sync resolution lane claim result must be a plain object');
  }
  return Object.freeze({
    replicaId,
    collectionId,
    sessionId,
    operationId,
    canonicalDigest,
    result: Object.freeze({ ...result }),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) deny('invalid_document');
  return encoded;
}
