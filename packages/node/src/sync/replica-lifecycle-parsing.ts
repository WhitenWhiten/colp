import { isRfc3339DateTime } from '../shared/date-time.js';
import type { ReplicaLifecycleSystemCommand } from './replica-lifecycle.js';

const ordinalPattern = /^(?:0|[1-9][0-9]*)$/u;

export function exactLifecycleObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.has(key)) {
      throw new TypeError(`${label} contains an unknown member.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

export function lifecycleNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

export function lifecycleInstant(
  value: unknown,
  label: string,
): { readonly wire: string; readonly order: number } {
  const wire = lifecycleNonEmpty(value, label);
  if (!isRfc3339DateTime(wire) || /-00:00$/iu.test(wire)) {
    throw new TypeError(`${label} must be an RFC 3339 date-time with a known offset.`);
  }
  const order = Date.parse(wire);
  if (!Number.isFinite(order)) throw new TypeError(`${label} must be a representable instant.`);
  return Object.freeze({ wire, order });
}

export function lifecycleOrdinal(
  value: unknown,
  label: string,
): { readonly wire: string; readonly order: bigint } {
  if (typeof value !== 'string' || !ordinalPattern.test(value)) {
    throw new TypeError(`${label} must be a canonical non-negative decimal string.`);
  }
  return Object.freeze({ wire: value, order: BigInt(value) });
}

const AUTHORIZATION_KEYS = ['authenticated', 'succeeded'] as const;
const FRESH_LEASE_KEYS = ['leaseId', 'generation', 'leaseExpiresAt'] as const;

/** Members each host command carries besides `type`. */
const HOST_COMMAND_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  register: ['collectionId', ...FRESH_LEASE_KEYS, ...AUTHORIZATION_KEYS],
  require_recovery: [...AUTHORIZATION_KEYS],
  resume: [...FRESH_LEASE_KEYS, ...AUTHORIZATION_KEYS],
  complete_recovery: ['snapshotId', ...FRESH_LEASE_KEYS, ...AUTHORIZATION_KEYS],
  renew: ['leaseExpiresAt', ...AUTHORIZATION_KEYS],
  acknowledge: ['cursor', 'commitOrdinal', ...AUTHORIZATION_KEYS],
  retire: [...AUTHORIZATION_KEYS],
});

/**
 * Snapshots a lifecycle command into its exact frozen shape. The `host`
 * surface accepts only authenticated request commands; `system` additionally
 * accepts the payload-free `expire`.
 */
export function parseReplicaLifecycleCommand(
  value: ReplicaLifecycleSystemCommand,
  surface: 'host' | 'system',
): ReplicaLifecycleSystemCommand {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Replica lifecycle command must be an object.');
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (typeDescriptor === undefined || !typeDescriptor.enumerable || !('value' in typeDescriptor)) {
    throw new TypeError('Replica lifecycle command type must be an enumerable data property.');
  }
  const type = typeDescriptor.value as unknown;
  const isHostCommand = typeof type === 'string' && Object.hasOwn(HOST_COMMAND_KEYS, type);
  if (!isHostCommand && type !== 'expire') {
    throw new TypeError('Replica lifecycle command type is invalid.');
  }
  if (!isHostCommand) {
    if (surface === 'host') throw new TypeError('Replica lifecycle command type is not a host command.');
    exactLifecycleObject(value, new Set(['type']), 'Replica lifecycle command');
    return Object.freeze({ type: 'expire' });
  }

  const candidate = exactLifecycleObject(
    value,
    new Set(['type', ...HOST_COMMAND_KEYS[type]!]),
    'Replica lifecycle command',
  );
  if (typeof candidate.authenticated !== 'boolean' || typeof candidate.succeeded !== 'boolean') {
    throw new TypeError('Request authentication and success flags must be boolean.');
  }
  const authorization = { authenticated: candidate.authenticated, succeeded: candidate.succeeded };
  const freshLease = () => ({
    leaseId: lifecycleNonEmpty(candidate.leaseId, 'Lease ID'),
    generation: lifecycleNonEmpty(candidate.generation, 'Lease generation'),
    leaseExpiresAt: lifecycleInstant(candidate.leaseExpiresAt, 'Lease expiry').wire,
  });
  switch (type) {
    case 'register':
      return Object.freeze({
        type,
        collectionId: lifecycleNonEmpty(candidate.collectionId, 'Collection ID'),
        ...freshLease(),
        ...authorization,
      });
    case 'resume':
      return Object.freeze({ type, ...freshLease(), ...authorization });
    case 'complete_recovery':
      return Object.freeze({
        type,
        snapshotId: lifecycleNonEmpty(candidate.snapshotId, 'Snapshot ID'),
        ...freshLease(),
        ...authorization,
      });
    case 'renew':
      return Object.freeze({
        type,
        ...authorization,
        leaseExpiresAt: lifecycleInstant(candidate.leaseExpiresAt, 'Lease expiry').wire,
      });
    case 'acknowledge':
      return Object.freeze({
        type,
        cursor: lifecycleNonEmpty(candidate.cursor, 'Acknowledged Cursor'),
        commitOrdinal: lifecycleOrdinal(candidate.commitOrdinal, 'Acknowledged commit ordinal').wire,
        ...authorization,
      });
    case 'require_recovery':
    case 'retire':
      return Object.freeze({ type, ...authorization });
    default:
      throw new TypeError('Replica lifecycle command type is invalid.');
  }
}
