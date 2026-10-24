import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { stableError as engineError } from '../src/durable-sync-engine-errors.js';
import { storageErrorCode } from '../src/storage-error-code.js';
import { SYNC_FAILURE_TABLE, classifySyncFailure } from '../src/sync-failure-class.js';
import { createSyncStateStore } from '../src/sync-state-store.js';
import { constraintError, stableCode, stableError as storeError } from '../src/sync-state/errors.js';
import { SyncStateError } from '../src/sync-state/types.js';

/**
 * W2A-05 / W2C-16: a full disk, a failing backing store and a closed connection reached the engine as
 * `sync_state_error` (a code registered nowhere), so a full disk looked like corruption and a transaction
 * abort looked like a network outage. Every browser storage exception now names what it means, and the
 * engine's own normaliser no longer mistakes prose for a transport failure.
 */
describe('browser storage failures are named by what they mean', () => {
  test('a full disk is quota_exceeded all the way from the store to the engine', () => {
    const raw = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    assert.equal(stableCode(raw), 'quota_exceeded');
    const wrapped = storeError(raw);
    assert.equal(wrapped.code, 'quota_exceeded');
    assert.equal(engineError(wrapped), 'quota_exceeded');
    assert.equal(engineError(raw), 'quota_exceeded');
    assert.equal(classifySyncFailure('quota_exceeded')?.class, 'transient');
  });

  test('a repository that wrapped the exception under its raw name is read the same way', () => {
    assert.equal(engineError(new SyncStateError('QuotaExceededError')), 'quota_exceeded');
    assert.equal(engineError(new SyncStateError('UnknownError')), 'storage_unavailable');
    assert.equal(engineError(new SyncStateError('AbortError')), 'transaction_aborted');
  });

  test('a failing backing store and a closed connection are one retryable storage_unavailable', () => {
    for (const name of ['UnknownError', 'InvalidStateError', 'NotFoundError', 'SecurityError', 'NotAllowedError']) {
      const raw = new DOMException('Internal error opening backing store for indexedDB.open.', name);
      assert.equal(storeError(raw).code, 'storage_unavailable', name);
      assert.equal(engineError(raw), 'storage_unavailable', name);
    }
    assert.equal(classifySyncFailure('storage_unavailable')?.class, 'transient');
  });

  test('a transaction that ended early is retryable and is not reported as a network outage', () => {
    const aborted = new DOMException('The transaction was aborted.', 'AbortError');
    assert.equal(storeError(aborted).code, 'transaction_aborted');
    assert.equal(engineError(new SyncStateError('transaction_aborted')), 'transaction_aborted');
    assert.equal(engineError(new DOMException('Transaction was aborted', 'AbortError')), 'transaction_aborted');
    assert.equal(storageErrorCode('TransactionInactiveError'), 'transaction_aborted');
  });

  test('a record the store refuses stops the replica, a constraint keeps its own code, anything else is retried', () => {
    assert.equal(storeError(new DOMException('not cloneable', 'DataCloneError')).code, 'storage_record_rejected');
    assert.equal(classifySyncFailure('storage_record_rejected')?.class, 'replica');
    // A caller that expects a duplicate key asks for it by name; elsewhere it is a lost race and is retried.
    assert.equal(constraintError(new DOMException('duplicate key', 'ConstraintError')).code, 'constraint');
    assert.equal(storeError(new DOMException('duplicate key', 'ConstraintError')).code, 'indexeddb_failure');
    assert.equal(storeError(new DOMException('something new', 'SomeFutureError')).code, 'indexeddb_failure');
    assert.equal(storeError(new RangeError('nope')).code, 'indexeddb_failure');
    assert.equal(classifySyncFailure('indexeddb_failure')?.class, 'transient');
  });

  test('a database written by a newer extension reads as future_schema', () => {
    assert.equal(storeError(new DOMException('db is newer', 'VersionError')).code, 'future_schema');
    assert.equal(engineError(new SyncStateError('future_schema')), 'future_schema');
  });

  test('every code the mapping can produce is registered in the failure table', () => {
    for (const name of ['QuotaExceededError', 'UnknownError', 'InvalidStateError', 'NotFoundError', 'SecurityError',
      'NotAllowedError', 'AbortError', 'TransactionInactiveError', 'DataCloneError', 'DataError', 'VersionError']) {
      const code = storageErrorCode(name);
      assert.ok(code && Object.hasOwn(SYNC_FAILURE_TABLE, code), `${name} -> ${String(code)}`);
    }
    assert.equal(storageErrorCode('TypeError'), undefined);
    assert.equal(storageErrorCode('toString'), undefined);
    assert.equal(storageErrorCode(undefined), undefined);
  });
});

describe('the engine normaliser keeps real codes and stops masking local defects as connectivity', () => {
  test('a registered code that carries a colon is the code, not the prefix of one', () => {
    assert.equal(engineError(new SyncStateError('mapping_missing:subtree_root')), 'mapping_missing:subtree_root');
    assert.equal(engineError(new Error('mapping_missing:subtree_root')), 'mapping_missing:subtree_root');
    assert.equal(classifySyncFailure('mapping_missing:subtree_root', { nodeId: 'node-1' })?.class, 'item');
    // An unregistered colon form keeps its prefix, as before.
    assert.equal(engineError(new Error('apply_failed:bookmark_gone')), 'apply_failed');
  });

  test('a transport failure is connectivity', () => {
    for (const message of ['Failed to fetch', 'fetch failed', 'NetworkError when attempting to fetch resource.',
      'Load failed', 'net::ERR_INTERNET_DISCONNECTED', 'The network connection was lost.', 'network_unavailable', 'offline']) {
      assert.equal(engineError(new TypeError(message)), 'network_unavailable', message);
    }
    assert.equal(engineError(new DOMException('The operation was aborted.', 'AbortError')), 'network_unavailable');
    assert.equal(engineError(new DOMException('The operation timed out.', 'TimeoutError')), 'network_unavailable');
  });

  test('prose that merely mentions fetch, network, abort or offline is a local defect, not an outage', () => {
    for (const message of ['cannot fetch the parent of undefined', 'unexpected network field in mapping',
      'abort controller is missing', 'offline queue is empty', 'could not load failed rows']) {
      assert.equal(engineError(new TypeError(message)), 'type_error', message);
    }
    assert.equal(engineError(new RangeError('Invalid array length')), 'range_error');
    assert.equal(engineError('not an error'), 'sync_failed');
    assert.equal(engineError(Object.assign(new Error('Something odd happened'), { code: 'Not A Code' })), 'sync_failed');
  });
});

describe('a browser that closes the connection under the extension does not leave the store dead', () => {
  test('the next call after a close event opens a fresh connection', async () => {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    const first = await store.open();
    assert.equal(await store.open(), first);
    first.onclose?.(new Event('close'));
    const second = await store.open();
    assert.notEqual(second, first);
    assert.equal(second.version, first.version);
    store.close();
  });
});
