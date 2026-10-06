/** Protocol object kinds that share one server-wide, lifetime identity namespace. */
export type ServerIdResourceType =
  | 'collection'
  | 'node'
  | 'annotation'
  | 'attachment'
  | 'relation'
  | 'operation'
  | 'event';

export interface ServerIdReservation {
  readonly id: string;
  readonly resourceType: ServerIdResourceType;
}

export interface ServerIdReservationConflict {
  readonly requested: ServerIdReservation;
  readonly existing: ServerIdReservation;
}

export type ServerIdReservationResult =
  | { readonly state: 'reserved' }
  | { readonly state: 'conflict'; readonly conflict: ServerIdReservationConflict };

export interface ServerIdReservationStore {
  /**
   * Attempts one atomic insertion of every reservation into the server-lifetime ledger.
   *
   * The backing table MUST have a database-level unique constraint whose sole key is
   * the case-sensitive, decoded `id` value. It MUST NOT include resourceType,
   * collection, tenant, deletion state, or a retention partition in that key. Under
   * concurrent calls for the same ID, transaction isolation plus that constraint MUST
   * permit exactly one transaction to report `reserved`.
   *
   * A `reserved` result means all rows were inserted into the caller's transaction. A
   * `conflict` result means none were inserted. Constraint violations are translated
   * to `conflict`, including same-type reuse. The rows share the resource transaction:
   * rollback removes uncommitted rows, while committed rows are permanent and MUST
   * survive deletion, tombstone purge, retention cleanup, and service restart.
   * There is intentionally no release or delete operation.
   */
  reserveAll(reservations: readonly ServerIdReservation[]): Promise<ServerIdReservationResult>;
}

/** A transaction capable of creating any protocol object. */
export interface ServerIdReservationTransaction {
  readonly idReservations: ServerIdReservationStore;
}

export class ServerIdAlreadyReservedError extends Error {
  readonly code = 'server_id_already_reserved' as const;
  readonly conflict: ServerIdReservationConflict;

  constructor(conflict: ServerIdReservationConflict) {
    const immutableConflict = Object.freeze({
      requested: Object.freeze({ ...conflict.requested }),
      existing: Object.freeze({ ...conflict.existing }),
    });
    super(
      `Server ID ${JSON.stringify(immutableConflict.requested.id)} requested for ${immutableConflict.requested.resourceType} ` +
        `was already reserved for ${immutableConflict.existing.resourceType}.`,
    );
    this.name = 'ServerIdAlreadyReservedError';
    this.conflict = immutableConflict;
  }
}

const wireIdPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const serverIdResourceTypes = new Set<ServerIdResourceType>([
  'collection',
  'node',
  'annotation',
  'attachment',
  'relation',
  'operation',
  'event',
]);

function snapshotReservation(candidate: unknown, label: string): ServerIdReservation {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`Server ID reservation ${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  const keys = Reflect.ownKeys(candidate);
  const id = Object.getOwnPropertyDescriptor(candidate, 'id');
  const resourceType = Object.getOwnPropertyDescriptor(candidate, 'resourceType');
  if (
    (prototype !== Object.prototype && prototype !== null)
    || keys.length !== 2
    || !keys.includes('id')
    || !keys.includes('resourceType')
    || keys.some((key) => typeof key !== 'string')
    || id === undefined
    || resourceType === undefined
    || !id.enumerable
    || !resourceType.enumerable
    || !('value' in id)
    || !('value' in resourceType)
    || typeof id.value !== 'string'
    || !serverIdResourceTypes.has(resourceType.value as ServerIdResourceType)
  ) {
    throw new TypeError(
      `Server ID reservation ${label} must contain only a valid id and resourceType.`,
    );
  }
  if (!wireIdPattern.test(id.value)) {
    throw new TypeError(
      `Server ID ${JSON.stringify(id.value)} must be 1-128 URI-unreserved ASCII characters.`,
    );
  }
  return Object.freeze({ id: id.value, resourceType: resourceType.value as ServerIdResourceType });
}

function validateReservationResult(
  candidate: unknown,
  requestedById: ReadonlyMap<string, ServerIdReservation>,
): ServerIdReservationResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError('Server ID reservation store must return a result object.');
  }
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  const keys = Reflect.ownKeys(candidate);
  const state = Object.getOwnPropertyDescriptor(candidate, 'state');
  if (
    (prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== 'string')
    || state === undefined
    || !state.enumerable
    || !('value' in state)
  ) {
    throw new TypeError('Server ID reservation store returned an invalid result.');
  }
  if (state.value === 'reserved' && keys.length === 1) {
    return Object.freeze({ state: 'reserved' });
  }
  if (state.value !== 'conflict' || keys.length !== 2 || !keys.includes('conflict')) {
    throw new TypeError('Server ID reservation store returned an unknown or malformed result.');
  }
  const conflictDescriptor = Object.getOwnPropertyDescriptor(candidate, 'conflict');
  const conflict = conflictDescriptor !== undefined && conflictDescriptor.enumerable
    && 'value' in conflictDescriptor ? conflictDescriptor.value : undefined;
  if (typeof conflict !== 'object' || conflict === null || Array.isArray(conflict)) {
    throw new TypeError('Server ID reservation store returned a malformed conflict.');
  }
  const conflictKeys = Reflect.ownKeys(conflict);
  const requested = Object.getOwnPropertyDescriptor(conflict, 'requested');
  const existing = Object.getOwnPropertyDescriptor(conflict, 'existing');
  if (
    (Object.getPrototypeOf(conflict) !== Object.prototype && Object.getPrototypeOf(conflict) !== null)
    || conflictKeys.length !== 2
    || !conflictKeys.includes('requested')
    || !conflictKeys.includes('existing')
    || conflictKeys.some((key) => typeof key !== 'string')
    || requested === undefined
    || existing === undefined
    || !requested.enumerable
    || !existing.enumerable
    || !('value' in requested)
    || !('value' in existing)
  ) {
    throw new TypeError('Server ID reservation store returned a malformed conflict.');
  }
  const checkedRequested = snapshotReservation(requested.value, 'in conflict.requested');
  const checkedExisting = snapshotReservation(existing.value, 'in conflict.existing');
  const submitted = requestedById.get(checkedRequested.id);
  if (
    submitted === undefined
    || submitted.resourceType !== checkedRequested.resourceType
    || checkedExisting.id !== checkedRequested.id
  ) {
    throw new TypeError('Server ID reservation conflict does not match the submitted batch.');
  }
  return Object.freeze({
    state: 'conflict',
    conflict: Object.freeze({ requested: checkedRequested, existing: checkedExisting }),
  });
}

/**
 * Reserves IDs through the transaction-bound durable ledger or rejects with a typed
 * conflict. This helper does not implement Operation replay or HTTP idempotency.
 */
export async function reserveServerIds(
  transaction: ServerIdReservationTransaction,
  reservations: readonly ServerIdReservation[],
): Promise<void> {
  if (!Array.isArray(reservations)) {
    throw new TypeError('Server ID reservations must be an array.');
  }
  const checkedReservations: ServerIdReservation[] = [];
  for (let index = 0; index < reservations.length; index += 1) {
    if (!Object.hasOwn(reservations, index)) {
      throw new TypeError(`Server ID reservations must not contain a hole at index ${index}.`);
    }
    checkedReservations.push(snapshotReservation(reservations[index], `at index ${index}`));
  }
  const reservationSnapshot = Object.freeze(checkedReservations);
  const firstById = new Map<string, ServerIdReservation>();
  for (const reservation of reservationSnapshot) {
    const existing = firstById.get(reservation.id);
    if (existing !== undefined) {
      throw new ServerIdAlreadyReservedError({ requested: reservation, existing });
    }
    firstById.set(reservation.id, reservation);
  }

  if (reservationSnapshot.length === 0) return;
  const pending = transaction.idReservations.reserveAll(reservationSnapshot);
  if (!(pending instanceof Promise)) {
    throw new TypeError('Server ID reservation store must return a native Promise.');
  }
  const result = validateReservationResult(await pending, firstById);
  if (result.state === 'conflict') {
    throw new ServerIdAlreadyReservedError(result.conflict);
  }
}
