import type { ReplicaLifecycleProblemCode } from '@know-n/colp/sync';
import { validateProtocolSafeReplicaId } from './replica-facts.js';

export interface ReplicaLifecycleScope {
  readonly accountId: string;
  readonly collectionId: string;
  readonly replicaId: string;
  readonly expectedLeaseGeneration: string;
  readonly expectedLifecycleRevision: string;
}

export type ReplicaRenewalOutcome = 'authorized_success' | 'unauthorized' | 'schema_rejected'
  | 'request_failed' | 'sequence_gap' | 'stale' | 'policy_rejected';
export type ReplicaRenewalDenialCode = Extract<
ReplicaLifecycleProblemCode,
'unauthorized' | 'request_failed' | 'stale_replica'
>;

export class ReplicaLifecycleValidationError extends TypeError {
  readonly code = 'invalid_replica_lifecycle_command' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ReplicaLifecycleValidationError';
  }
}

const SCOPE_KEYS = new Set([
  'accountId', 'collectionId', 'replicaId', 'expectedLeaseGeneration', 'expectedLifecycleRevision',
]);
const OUTCOMES = new Set<ReplicaRenewalOutcome>([
  'authorized_success', 'unauthorized', 'schema_rejected', 'request_failed', 'sequence_gap',
  'stale', 'policy_rejected',
]);
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ReplicaLifecycleValidationError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new ReplicaLifecycleValidationError(`${label} contains an unknown field`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new ReplicaLifecycleValidationError(`${label} is incomplete`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new ReplicaLifecycleValidationError(`${label} is invalid`);
  }
  return value;
}

function canonicalSafeInteger(value: unknown, label: string, minimum: bigint): string {
  if (typeof value !== 'string' || !CANONICAL_INTEGER.test(value)) {
    throw new ReplicaLifecycleValidationError(`${label} must be a canonical integer`);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReplicaLifecycleValidationError(`${label} is outside the supported range`);
  }
  return value;
}

export function validateReplicaLifecycleScope(value: unknown): ReplicaLifecycleScope {
  const candidate = plainRecord(value, 'Replica lifecycle scope');
  exactKeys(candidate, SCOPE_KEYS, 'Replica lifecycle scope');
  return Object.freeze({
    accountId: nonEmpty(candidate.accountId, 'Account ID'),
    collectionId: nonEmpty(candidate.collectionId, 'Collection ID'),
    replicaId: validateProtocolSafeReplicaId(candidate.replicaId, 'Replica ID'),
    expectedLeaseGeneration: canonicalSafeInteger(
      candidate.expectedLeaseGeneration,
      'Expected lease generation',
      1n,
    ),
    expectedLifecycleRevision: canonicalSafeInteger(
      candidate.expectedLifecycleRevision,
      'Expected lifecycle revision',
      0n,
    ),
  });
}

export function validateReplicaLeaseDuration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_592_000) {
    throw new ReplicaLifecycleValidationError('Replica lease duration is invalid');
  }
  return value as number;
}

export function classifyReplicaRenewalOutcome(
  value: ReplicaRenewalOutcome,
): Readonly<{ code: ReplicaRenewalDenialCode }> | null {
  if (!OUTCOMES.has(value)) throw new ReplicaLifecycleValidationError('Replica renewal outcome is invalid');
  if (value === 'authorized_success') return null;
  if (value === 'unauthorized') return Object.freeze({ code: 'unauthorized' });
  if (value === 'stale') return Object.freeze({ code: 'stale_replica' });
  return Object.freeze({ code: 'request_failed' });
}
