import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { readSyncDiagnosticSnapshot } from '../e2e/sync-failure-diagnostics.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('missing diagnostic database remains missing and does not create or upgrade storage', async () => {
  const indexedDB = new IDBFactory(); vi.stubGlobal('indexedDB', indexedDB);
  expect(await readSyncDiagnosticSnapshot()).toEqual({ unavailable: 'database_missing' });
  expect(await indexedDB.databases()).toEqual([]);
});

test('failure observation reads real IDB states without exposing bookmark, native or credential content', async () => {
  const indexedDB = new IDBFactory(); vi.stubGlobal('indexedDB', indexedDB);
  const request = indexedDB.open('known-phase3-indexeddb-entry', 21);
  const scopeKey = 'PRIVATE-SCOPE-ID';
  const tables = {
    sync_scopes: [{ scopeKey, lifecycle: 'active', firstRun: 'running', rootStatus: 'ready', generation: 1,
      selectedRoots: ['PRIVATE-NATIVE-ID'], metadata: { recoveryCode: 'create_ambiguous' } }],
    sync_engine: [{ scopeKey, phase: 'recovery', lastError: 'recovery_required', recoveryFrozen: true,
      lastPublishedCursor: 'private-cursor', lastAckedCursor: 'private-cursor' }],
    outbound_queue: [{ scopeKey, sequence: 7, status: 'unknown', recovery: { code: 'network_unavailable' },
      payload: { type: 'create_node', dependencies: [], title: 'PRIVATE-TITLE', url: 'https://sentinel.invalid/private' },
      attempt: { body: 'PRIVATE-BODY', sessionId: 'PRIVATE-CREDENTIAL' }, retry: { attempt: 2, notBefore: 10 } },
    { scopeKey: 'retired-scope', sequence: 1, status: 'pending' }],
    apply_intents: [{ scopeKey, state: 'browser_call_started', liveWorkKind: 'create', nativeResult: 'result_unknown',
      nativeParentId: 'PRIVATE-NATIVE-ID', expectedPostState: { title: 'PRIVATE-TITLE' } }],
    bootstrap_advanced_steps: [{ scopeKey, state: 'attention', order: 2, definition: { side: 'local', action: 'create',
      operation: 'create', payload: { title: 'PRIVATE-TITLE' } }, error: 'native_create_unproven' }],
  };
  request.onupgradeneeded = () => { for (const name of Object.keys(tables)) request.result.createObjectStore(name, { autoIncrement: true }); };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = db.transaction(Object.keys(tables), 'readwrite');
  for (const [name, rows] of Object.entries(tables)) for (const row of rows) tx.objectStore(name).put(row);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  const transaction = vi.spyOn(Object.getPrototypeOf(db), 'transaction');
  const snapshot = await readSyncDiagnosticSnapshot();
  expect(transaction.mock.calls.map(args => args[1])).toEqual(['readonly']);
  expect(snapshot).toMatchObject({ scopes: [{ firstRun: 'running', recoveryCode: 'create_ambiguous',
    engine: { phase: 'recovery', frozen: true, cursorsEqual: true }, queue: { unknown: 1 },
    unsettledQueue: [{ sequence: 7, type: 'create_node', status: 'unknown', attempts: 2, hasTransportAttempt: true }],
    intents: [{ state: 'browser_call_started', kind: 'create', nativeResult: 'result_unknown' }],
    advancedSteps: [{ state: 'attention', order: 2, side: 'local', action: 'create', error: 'native_create_unproven' }] }] });
  expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|sentinel|private-cursor/u);
  transaction.mockRestore(); db.close();
});
