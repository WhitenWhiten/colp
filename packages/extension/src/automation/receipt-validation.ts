import type { PlacementReceipt } from './receipt-sync.js';

export interface QuarantinedReceipt { id: string; raw: unknown; reason: string; quarantinedAt: number }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const folder = (value: unknown) => record(value) && ['serverUuid', 'collectionId', 'nodeId'].every(key => text(value[key]));
/** Validate every field consumed by delivery or the recovery UI before exposing a persisted record. */
export function validPlacementReceipt(value: unknown): value is PlacementReceipt {
  if (!record(value)) return false;
  const r = value;
  return r.version === 1 && ['localReceiptId', 'ownerKey', 'collectionId', 'replicaId'].every(key => text(r[key]))
    && ['generation', 'createdAt', 'updatedAt', 'attempts', 'nextAttemptAt'].every(key => number(r[key]))
    && Number.isInteger(r.generation) && Number.isInteger(r.attempts)
    && typeof r.path === 'string' && ['preSave', 'observed'].includes(r.path)
    && typeof r.state === 'string' && ['local', 'waitingForSync', 'accepted', 'review', 'rejected', 'attention'].includes(r.state)
    && (r.attention === undefined || typeof r.attention === 'string' && ['staleGeneration', 'identityUnknown', 'invalid', 'conflict', 'expired'].includes(r.attention))
    && record(r.rule) && ['id', 'name', 'revision', 'bindingRevision', 'bundleRevision'].every(key => typeof (r.rule as Record<string, unknown>)[key] === 'string')
    && folder(r.destination) && (r.beforeFolder === undefined || folder(r.beforeFolder)) && typeof r.destinationTitle === 'string'
    && Array.isArray(r.satisfies) && r.satisfies.every(item => item === 'classify.root')
    && record(r.page) && typeof r.page.title === 'string' && typeof r.page.url === 'string'
    && record(r.native) && text(r.native.nativeId) && text(r.native.destinationNativeId)
    && (r.native.movedAt === undefined || number(r.native.movedAt))
    && (r.canonical === undefined || (record(r.canonical) && text(r.canonical.nodeId) && text(r.canonical.operationId)
      && (r.canonical.placementOperationId === undefined || text(r.canonical.placementOperationId))));
}

export function invalidReceiptReason(value: unknown): string {
  if (!record(value)) return 'Receipt is not an object.';
  if (value.version !== 1) return 'Unsupported receipt version.';
  if (!text(value.localReceiptId)) return 'Receipt identity is missing or invalid.';
  if (!record(value.native) || !text(value.native.nativeId) || !text(value.native.destinationNativeId)) return 'Native bookmark identity is missing or invalid.';
  if (!record(value.rule)) return 'Pinned rule revisions are missing or invalid.';
  if (!folder(value.destination)) return 'Canonical destination is missing or invalid.';
  if (!record(value.page)) return 'Local page metadata is missing or invalid.';
  return 'Receipt state, timestamps, revisions or canonical evidence failed validation.';
}
