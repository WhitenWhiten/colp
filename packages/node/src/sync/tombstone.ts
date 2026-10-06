import { isRfc3339DateTime } from '../shared/date-time.js';
import type { DeletionReceipt, SyncTombstone } from '../types/generated.js';

const receiptKeys = new Set([
  'resourceType',
  'targetId',
  'collectionId',
  'scope',
  'deletedAt',
  'deletedBy',
  'deleteRevision',
  'operationId',
  'affectedCount',
  'purgeAfter',
]);
const requiredReceiptKeys = [
  'resourceType',
  'targetId',
  'collectionId',
  'scope',
  'deletedAt',
  'deleteRevision',
  'operationId',
  'affectedCount',
  'purgeAfter',
] as const;
const resourceTypes = new Set<unknown>([
  'collection',
  'node',
  'annotation',
  'attachment',
  'relation',
]);
const opaqueIdPattern = /^[A-Za-z0-9._~-]{1,128}$/u;
const principalIdPattern = /^[\x21-\x7E]{1,512}$/u;

function exactReceipt(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Deletion Receipt must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Deletion Receipt must have a plain or null prototype.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !receiptKeys.has(key)) {
      throw new TypeError('Deletion Receipt contains an unknown member.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Deletion Receipt members must be enumerable data properties.');
    }
  }
  for (const key of requiredReceiptKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`Deletion Receipt is missing required member ${key}.`);
    }
  }
  return value as Record<string, unknown>;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !opaqueIdPattern.test(value)) {
    throw new TypeError(`${label} must be a canonical opaque ID.`);
  }
  return value;
}

function dateTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isRfc3339DateTime(value)) {
    throw new TypeError(`${label} must be a valid RFC 3339 date-time.`);
  }
  return value;
}

/** Adds a caller-supplied Sync Cursor to a canonical Publisher deletion receipt. */
export function createSyncTombstone(
  receipt: DeletionReceipt,
  deleteCursor: string,
): SyncTombstone {
  const candidate = exactReceipt(receipt);
  if (!resourceTypes.has(candidate.resourceType)) {
    throw new TypeError('Deletion Receipt resourceType is invalid.');
  }
  if (candidate.scope !== 'single' && candidate.scope !== 'subtree') {
    throw new TypeError('Deletion Receipt scope is invalid.');
  }

  const targetId = opaqueId(candidate.targetId, 'Deletion Receipt targetId');
  const collectionId = opaqueId(candidate.collectionId, 'Deletion Receipt collectionId');
  if (!Number.isSafeInteger(candidate.affectedCount) || (candidate.affectedCount as number) < 1) {
    throw new TypeError('Deletion Receipt affectedCount must be a positive safe integer.');
  }

  let deletedBy: string | undefined;
  if (Object.hasOwn(candidate, 'deletedBy')) {
    if (typeof candidate.deletedBy !== 'string' || !principalIdPattern.test(candidate.deletedBy)) {
      throw new TypeError('Deletion Receipt deletedBy must be a canonical principal ID.');
    }
    deletedBy = candidate.deletedBy;
  }

  const tombstone = {
    resourceType: candidate.resourceType,
    targetId,
    collectionId,
    scope: candidate.scope,
    deletedAt: dateTime(candidate.deletedAt, 'Deletion Receipt deletedAt'),
    ...(deletedBy === undefined ? {} : { deletedBy }),
    deleteRevision: opaqueId(candidate.deleteRevision, 'Deletion Receipt deleteRevision'),
    operationId: opaqueId(candidate.operationId, 'Deletion Receipt operationId'),
    deleteCursor: opaqueId(deleteCursor, 'Sync Tombstone deleteCursor'),
    affectedCount: candidate.affectedCount,
    purgeAfter: dateTime(candidate.purgeAfter, 'Deletion Receipt purgeAfter'),
  } as SyncTombstone;

  return Object.freeze(tombstone);
}
