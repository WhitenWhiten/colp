export type SyncSequencePersistenceErrorCode =
  | 'not_found'
  | 'authorization_denied'
  | 'idempotency_key_reused'
  | 'session_expired'
  | 'stale_replica'
  | 'replica_retired'
  | 'receipt_missing'
  | 'integrity_failure';

export class SyncSequencePersistenceError extends Error {
  readonly code: SyncSequencePersistenceErrorCode;

  constructor(code: SyncSequencePersistenceErrorCode) {
    super(`Sync Sequence persistence denied: ${code}`);
    this.name = 'SyncSequencePersistenceError';
    this.code = code;
  }
}

export function persistenceError(code: SyncSequencePersistenceErrorCode): never {
  throw new SyncSequencePersistenceError(code);
}
