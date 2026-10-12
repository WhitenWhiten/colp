import type { CaptureScope, CaptureTask } from '../capture/contracts.js';
import { captureOwnerKey } from '../capture/contracts.js';
import type { LocalHistoryItem } from '../capture/local-history.js';
import { transactionDone } from '../sync-state/idb.js';
import type { BackupHistory } from './codec.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

function historyId(commandId: string, index: number): string {
  const hash = bytesToHex(sha256(new TextEncoder().encode(`${commandId}:${index}`)));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Read-only restored records live outside the command ledger: they cannot be resumed or reported. */
export function createBackupHistoryStore(factory: IDBFactory = indexedDB) {
  let connection: Promise<IDBDatabase> | undefined;
  function open() {
    return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('known-backup-history', 1);
      request.onupgradeneeded = () => {
        const table = request.result.createObjectStore('history', { keyPath: ['ownerKey', 'captureId'] });
        table.createIndex('ownerHistory', ['ownerKey', 'createdAt', 'captureId']);
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = undefined; }; resolve(request.result);
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
    });
  }
  return {
    async restore(scope: CaptureScope, commandId: string, records: readonly BackupHistory[], nativeIds: ReadonlyMap<string, string>) {
      const tx = (await open()).transaction('history', 'readwrite'), done = transactionDone(tx);
      records.forEach((record, index) => {
        const nativeId = record.nativeSourceId ? nativeIds.get(record.nativeSourceId) ?? null : null;
        const targetNativeId = record.targetSourceId ? nativeIds.get(record.targetSourceId) ?? '' : '';
        const task: CaptureTask = {
          version: 1, captureId: historyId(commandId, index), commandId, batchId: null, scope,
          title: record.title, url: record.url, source: record.source, tabId: null, targetNativeId, insertPosition: 'bottom',
          saveAnother: false, allowUnverifiedCloud: false, createdAt: record.createdAt, updatedAt: record.updatedAt,
          revision: 0, policyVersion: 'backup-v1', automaticIntent: record.automaticIntent, disposition: record.disposition,
          save: record.save, classification: record.classification, sync: record.sync, existence: null,
          nativeIntentId: null, nativeId, nodeId: null, executionId: null, decisionId: null,
          localLocation: nativeId ? { nativeId, path: record.path, url: record.url, writable: false,
            collectionId: null, collectionTitle: null, nodeId: null } : null,
          cloudLocation: null, appliedRevision: null, manualFence: 0, controlGeneration: 0, reason: record.reason,
          savedAt: record.savedAt, classificationAppliedAt: record.classificationAppliedAt, syncConfirmedAt: record.syncConfirmedAt, feedbackKind: record.feedbackKind,
        };
        tx.objectStore('history').put({ ...task, ownerKey: captureOwnerKey(scope), historyReadOnly: true, historyOrigin: 'backup', historyAutomaticApplied: record.originalApplied });
      });
      await done;
    },
    async listForOwner(scope: CaptureScope, before?: readonly [number, string]): Promise<readonly LocalHistoryItem[]> {
      const tx = (await open()).transaction('history', 'readonly'), done = transactionDone(tx), key = captureOwnerKey(scope);
      const items: LocalHistoryItem[] = [];
      const range = IDBKeyRange.bound([key], before ? [key, ...before] : [key, []], false, Boolean(before));
      await new Promise<void>((resolve, reject) => {
        const cursor = tx.objectStore('history').index('ownerHistory').openCursor(range, 'prev');
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          if (!cursor.result || items.length >= 50) { resolve(); return; }
          const { ownerKey: _owner, ...task } = cursor.result.value as LocalHistoryItem & { ownerKey: string };
          items.push(task); cursor.result.continue();
        };
      });
      await done; return items;
    },
    async close() { (await connection)?.close(); connection = undefined; },
  };
}
