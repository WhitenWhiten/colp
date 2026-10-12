import { SyncStateError, type FaultOptions } from './types.js';

export function inject(actual: FaultOptions['fault'], expected: FaultOptions['fault'], tx: IDBTransaction) { if (actual === expected) { tx.abort(); throw new SyncStateError('fault_injected'); } }
export function stableError(error: unknown) { return error instanceof SyncStateError ? error : new SyncStateError(stableCode(error)); }
export function stableCode(error: unknown) { return error instanceof DOMException ? error.name : error instanceof SyncStateError ? error.code : 'indexeddb_failure'; }
export function constraintError(error: unknown) { if (error instanceof Error && error.name === 'ConstraintError') return new SyncStateError('constraint'); return stableError(error); }
