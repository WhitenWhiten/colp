import type { ProblemCode } from '@know-n/colp/server';
import type { Operation } from '@know-n/colp/types';

const RESTORE_PAYLOAD_KEYS = new Set(['newParentId', 'afterId', 'beforeId', 'reason']);
const MAX_RESTORE_REASON_BYTES = 4_096;

export interface CanonicalSyncNodeRestore {
  readonly collectionId: string;
  readonly targetId: string;
  readonly expectedDeleteRevision: string;
}

export class SyncNodeRestoreError extends Error {
  constructor(public readonly code: ProblemCode) {
    super(`Sync Node restore denied: ${code}`);
    this.name = 'SyncNodeRestoreError';
  }
}

function deny(code: ProblemCode): never {
  throw new SyncNodeRestoreError(code);
}

/** Maps a schema-validated restore_node Operation to a closed P0 single-target intent. */
export function evaluateSyncNodeRestore(operation: Operation): Readonly<CanonicalSyncNodeRestore> {
  if (operation.type !== 'restore_node') deny('unsupported_operation');
  if (typeof operation.collectionId !== 'string' || operation.collectionId.length < 1
      || typeof operation.targetId !== 'string' || operation.targetId.length < 1
      || typeof operation.baseRevision !== 'string' || operation.baseRevision.length < 1
      || !operation.payload || typeof operation.payload !== 'object'
      || Array.isArray(operation.payload)) {
    deny('invalid_document');
  }
  const payload = operation.payload as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !RESTORE_PAYLOAD_KEYS.has(key))) deny('invalid_document');
  if (payload.reason !== undefined) {
    if (typeof payload.reason !== 'string') deny('invalid_document');
    if (Buffer.byteLength(payload.reason, 'utf8') > MAX_RESTORE_REASON_BYTES) deny('payload_too_large');
  }
  for (const key of ['newParentId', 'afterId', 'beforeId'] as const) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.length < 1) deny('invalid_document');
  }
  return Object.freeze({
    collectionId: operation.collectionId,
    targetId: operation.targetId,
    expectedDeleteRevision: operation.baseRevision,
  });
}
