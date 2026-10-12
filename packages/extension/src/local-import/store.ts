import { parseStoredImportConversion, type ImportConversionResult } from '../import-preview.js';
import { requestValue, transactionDone } from '../sync-state/idb.js';
import { backupImportItems, localImportItems, type LocalImportItem, type LocalImportPlan } from './contracts.js';
import { parseLocalBackup, type LocalBackup } from '../local-backup/codec.js';
import type { CaptureScope } from '../capture/contracts.js';

/** Browser-owned journal: it contains no account, collection, credentials or sync operations. */
export function createLocalImportStore(factory: IDBFactory = indexedDB) {
  let connection: Promise<IDBDatabase> | undefined;
  function open() {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('known-local-import', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('previews', { keyPath: 'digest' });
        request.result.createObjectStore('plans', { keyPath: 'commandId' });
        request.result.createObjectStore('items', { keyPath: ['commandId', 'index'] });
        request.result.createObjectStore('meta');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = undefined; };
        resolve(request.result);
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
    });
    return connection;
  }
  async function transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = (await open()).transaction(['previews', 'plans', 'items', 'meta'], mode);
    const done = transactionDone(tx);
    try { const result = await work(tx); await done; return result; }
    catch (error) { try { tx.abort(); } catch { /* Already settled. */ } await done.catch(() => undefined); throw error; }
  }
  async function current(tx: IDBTransaction, commandId?: string): Promise<LocalImportPlan | undefined> {
    const id = commandId ?? await requestValue(tx.objectStore('meta').get('latest')) as string | undefined;
    return id ? requestValue(tx.objectStore('plans').get(id)) : undefined;
  }
  return {
    async preview(conversion: ImportConversionResult) {
      await transaction('readwrite', async tx => {
        tx.objectStore('previews').clear();
        tx.objectStore('previews').put({ digest: conversion.digest, conversion, expiresAt: Date.now() + 86400000 });
      });
    },
    async previewBackup(backup: LocalBackup, digest: string) {
      await transaction('readwrite', async tx => {
        tx.objectStore('previews').clear();
        tx.objectStore('previews').put({ digest, backup, expiresAt: Date.now() + 86400000 });
      });
    },
    plan(commandId?: string) { return transaction('readonly', tx => current(tx, commandId)); },
    item(commandId: string, index: number): Promise<LocalImportItem | undefined> {
      return transaction('readonly', tx => requestValue(tx.objectStore('items').get([commandId, index])));
    },
    items(commandId: string): Promise<readonly LocalImportItem[]> {
      return transaction('readonly', tx => requestValue(tx.objectStore('items').getAll(IDBKeyRange.bound([commandId], [commandId, []]))));
    },
    async start(input: { commandId: string; digest: string; targetNativeId: string; folderTitle: string;
      restoreSettings?: boolean; restoreOwner?: CaptureScope }): Promise<LocalImportPlan> {
      return transaction('readwrite', async tx => {
        const previous = await current(tx, input.commandId);
        if (previous) {
          if (previous.digest !== input.digest || previous.targetNativeId !== input.targetNativeId || previous.folderTitle !== input.folderTitle
            || Boolean(previous.restoreSettings) !== Boolean(input.restoreSettings)) throw new Error('command_id_reused');
          return previous;
        }
        const active = await current(tx);
        if (active && !['completed', 'cancelled'].includes(active.state)) throw new Error('import_in_progress');
        const cached = await requestValue(tx.objectStore('previews').get(input.digest)) as { conversion?: unknown; backup?: unknown; expiresAt: number } | undefined;
        const conversion = cached && cached.expiresAt > Date.now() ? parseStoredImportConversion(cached.conversion) : undefined;
        const backup = cached && cached.expiresAt > Date.now() && cached.backup ? parseLocalBackup(cached.backup) : undefined;
        if (!backup && (!conversion || conversion.digest !== input.digest || conversion.source.profile !== 'netscape-bookmarks-v1')) throw new Error('preview_expired');
        if (backup && !input.restoreOwner) throw new Error('backup_restore_unavailable');
        if (!backup && input.restoreSettings !== undefined) throw new Error('request_invalid');
        const items = backup ? backupImportItems(backup, input.commandId, input.folderTitle) : localImportItems(conversion!, input.commandId, input.folderTitle);
        const plan: LocalImportPlan = { ...input, total: items.length, next: 0, state: 'running', reason: null,
          ...(!backup && items.some(item => item.annotation || item.description !== undefined) ? { annotated: true } : {}),
          ...(backup ? { source: 'backup', historyCount: backup.history.length, backup: {
            history: backup.history, preferences: backup.preferences, language: backup.language,
            defaultFolderSourceId: backup.defaultFolderSourceId, aiConfig: backup.aiConfig,
          } } : {}) };
        tx.objectStore('plans').add(plan);
        for (const item of items) tx.objectStore('items').add(item);
        tx.objectStore('meta').put(plan.commandId, 'latest');
        tx.objectStore('previews').delete(input.digest);
        return plan;
      });
    },
    async state(plan: LocalImportPlan, state: LocalImportPlan['state'], reason: string | null): Promise<LocalImportPlan> {
      return transaction('readwrite', async tx => {
        const live = await current(tx, plan.commandId);
        if (!live || live.next !== plan.next) throw new Error('local_import_changed');
        let next = { ...live, state, reason };
        if (state === 'cancelled') {
          const { backup: _backup, restoreOwner: _owner, ...retained } = next;
          next = retained;
          tx.objectStore('items').delete(IDBKeyRange.bound([plan.commandId], [plan.commandId, []]));
        }
        tx.objectStore('plans').put(next);
        return next;
      });
    },
    async started(plan: LocalImportPlan, item: LocalImportItem) {
      await transaction('readwrite', async tx => {
        const live = await current(tx, plan.commandId);
        const pending = await requestValue(tx.objectStore('items').get([plan.commandId, item.index])) as LocalImportItem | undefined;
        if (!live || live.next !== item.index || pending?.state !== 'waiting') throw new Error('local_import_changed');
        tx.objectStore('items').put({ ...pending, state: 'submitted' });
      });
    },
    async confirm(plan: LocalImportPlan, item: LocalImportItem, nativeId: string): Promise<LocalImportPlan> {
      return transaction('readwrite', async tx => {
        const live = await current(tx, plan.commandId);
        const pending = await requestValue(tx.objectStore('items').get([plan.commandId, item.index])) as LocalImportItem | undefined;
        if (!live || live.next !== item.index || pending?.state !== 'submitted') throw new Error('local_import_changed');
        const next: LocalImportPlan = { ...live, next: live.next + 1, state: live.next + 1 === live.total && !live.backup && !live.annotated ? 'completed' : 'running', reason: null,
          ...(item.index === 0 ? { rootNativeId: nativeId } : {}) };
        tx.objectStore('items').put({ ...pending, state: 'completed', nativeId });
        tx.objectStore('plans').put(next);
        if (next.state === 'completed') tx.objectStore('items').delete(IDBKeyRange.bound([plan.commandId], [plan.commandId, []]));
        return next;
      });
    },
    async complete(plan: LocalImportPlan): Promise<LocalImportPlan> {
      return transaction('readwrite', async tx => {
        const live = await current(tx, plan.commandId);
        if (!live || live.next !== live.total || live.state !== 'running') throw new Error('local_import_changed');
        const { backup: _backup, restoreOwner: _owner, ...record } = live;
        const next: LocalImportPlan = { ...record, state: 'completed', reason: null };
        tx.objectStore('plans').put(next);
        tx.objectStore('items').delete(IDBKeyRange.bound([plan.commandId], [plan.commandId, []]));
        return next;
      });
    },
    async close() { (await connection)?.close(); connection = undefined; },
  };
}
export type LocalImportStore = ReturnType<typeof createLocalImportStore>;
