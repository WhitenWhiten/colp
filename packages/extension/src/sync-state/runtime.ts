import {
  DEFAULT_MAX_RECORD_BYTES,
} from './codec.js';
import { requestValue, transactionDone } from './idb.js';
import { stableError } from './errors.js';
import {
  DATABASE_NAME, DATABASE_VERSION, upgrade, structuralProblems,
} from './schema.js';
import { SyncStateError, type StoreOptions } from './types.js';
import { pageV15Backfill } from './v15-backfill.js';

export interface SyncStoreRuntime {
  readonly maxRecordBytes: number;
  readonly factory: IDBFactory;
  readonly durableCache: Map<string, unknown>;
  open(): Promise<IDBDatabase>;
  close(): void;
  writableDatabase(): Promise<IDBDatabase>;
  assertWritable(): void;
  readOne(storeName: string, key: IDBValidKey): Promise<unknown>;
  setDiagnosticReadOnly(): void;
  isDiagnosticReadOnly(): boolean;
  setUpgradeFailed(): void;
  isUpgradeFailed(): boolean;
  /** Closes the connection and forgets every sticky flag: the next call opens the database from scratch. */
  reset(): void;
}

export function createSyncStoreRuntime(options: StoreOptions = {}): SyncStoreRuntime {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new SyncStateError('indexeddb_unavailable');
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  let connection: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let diagnosticReadOnly = false;
  let upgradeFailed = false;
  const durableCache = new Map<string, unknown>();

  async function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    // Concurrent first callers share one open request; otherwise the losers
    // would each hold an extra connection that is never closed.
    if (opening) return opening;
    opening = openConnection().finally(() => { opening = undefined; });
    return opening;
  }

  async function openConnection(): Promise<IDBDatabase> {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    let injectedUpgradeFailure = false; let upgrading = false;
    request.onblocked = (event) => options.onBlocked?.(event);
    request.onupgradeneeded = (event) => {
      upgrading = true;
      if (options.injectUpgradeFailure) { injectedUpgradeFailure = true; request.transaction?.abort(); return; }
      upgrade(request.result, request.transaction!, event.oldVersion, maxRecordBytes);
    };
    try { connection = await requestValue(request); }
    catch (error) {
      // W2A-01: an open that fails while the version change was running is an upgrade that did not finish
      // (a full disk, a browser error), not a transaction that merely aborted.
      if (injectedUpgradeFailure || upgrading) { upgradeFailed = true; throw new SyncStateError('upgrade_failed'); }
      if (error instanceof Error && error.name === 'VersionError') throw new SyncStateError('future_schema');
      throw stableError(error);
    }
    connection.onversionchange = () => { connection?.close(); connection = undefined; };
    // W2A-05: the browser may close the connection under us (site data cleared, profile storage lost);
    // forget it so the next call reopens instead of failing on a dead handle until the worker restarts.
    const opened = connection;
    connection.onclose = () => { if (connection === opened) { connection = undefined; durableCache.clear(); } };
    if (structuralProblems(connection).length) diagnosticReadOnly = true;
    else await pageV15Backfill({ open: async () => connection! });
    return connection;
  }

  function close() { connection?.close(); connection = undefined; durableCache.clear(); }
  /** W2A-01: after the database was deleted, nothing of the old one (connection, read-only flag, cache) may survive. */
  function reset() { close(); diagnosticReadOnly = false; upgradeFailed = false; }
  function assertWritable() { if (diagnosticReadOnly) throw new SyncStateError('diagnostic_read_only'); }
  async function writableDatabase() { const db = await open(); assertWritable(); return db; }
  async function readOne(storeName: string, key: IDBValidKey) { const db = await open(); const tx = db.transaction(storeName, 'readonly');
    const completion = transactionDone(tx); const value = await requestValue(tx.objectStore(storeName).get(key)); await completion; return value; }

  return {
    maxRecordBytes, factory, durableCache, open, close, reset, writableDatabase, assertWritable, readOne,
    setDiagnosticReadOnly() { diagnosticReadOnly = true; },
    isDiagnosticReadOnly() { return diagnosticReadOnly; },
    setUpgradeFailed() { upgradeFailed = true; },
    isUpgradeFailed() { return upgradeFailed; },
  };
}
