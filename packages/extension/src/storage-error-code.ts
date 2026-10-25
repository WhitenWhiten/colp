/**
 * W2A-05: the stable code a browser storage failure stands for.
 *
 * IndexedDB reports a full disk, a failing backing store and a closed connection as DOM exceptions whose
 * names are not codes. Wrapped by the repositories they used to reach the engine as `sync_state_error` or
 * `quota_exceeded_error`, which are registered nowhere, so a full disk looked like corruption. Every name
 * that means "the browser's storage cannot be used right now" maps to a registered code instead.
 */
const BY_NAME: Readonly<Record<string, string>> = Object.freeze({
  // The disk or the origin's quota is full. Frees up on its own once the person makes room.
  QuotaExceededError: 'quota_exceeded',
  // The backing store failed (Chromium: "Internal error opening backing store"), the connection is
  // closing or closed, or the database vanished under the connection. A later open usually works.
  UnknownError: 'storage_unavailable',
  InvalidStateError: 'storage_unavailable',
  NotFoundError: 'storage_unavailable',
  // The browser blocks site data for this extension (privacy settings, a managed policy).
  SecurityError: 'storage_unavailable',
  NotAllowedError: 'storage_unavailable',
  // A transaction ended before it finished (explicit abort, the browser killed it, it sat idle too long).
  // The fetch AbortError is told apart by the engine before it asks here.
  AbortError: 'transaction_aborted',
  TransactionInactiveError: 'transaction_aborted',
  // The store refused a record (not cloneable, bad key): retrying gives the same answer.
  DataCloneError: 'storage_record_rejected',
  DataError: 'storage_record_rejected',
  // A database written by a newer version of the extension.
  VersionError: 'future_schema',
});

export function storageErrorCode(name: unknown): string | undefined {
  return typeof name === 'string' && Object.hasOwn(BY_NAME, name) ? BY_NAME[name] : undefined;
}
