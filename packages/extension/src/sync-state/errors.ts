import { storageErrorCode } from '../storage-error-code.js';
import { SyncStateError, type FaultOptions } from './types.js';

export function inject(actual: FaultOptions['fault'], expected: FaultOptions['fault'], tx: IDBTransaction) { if (actual === expected) { tx.abort(); throw new SyncStateError('fault_injected'); } }
export function stableError(error: unknown) { return error instanceof SyncStateError ? error : new SyncStateError(stableCode(error)); }
/**
 * A browser exception becomes the registered code for what it means (W2A-05), never its raw name: a full
 * disk is `quota_exceeded`, a failing backing store `storage_unavailable`, anything else `indexeddb_failure`.
 */
export function stableCode(error: unknown) {
  if (error instanceof SyncStateError) return error.code;
  return error instanceof Error ? storageErrorCode(error.name) ?? 'indexeddb_failure' : 'indexeddb_failure';
}
export function constraintError(error: unknown) { if (error instanceof Error && error.name === 'ConstraintError') return new SyncStateError('constraint'); return stableError(error); }
