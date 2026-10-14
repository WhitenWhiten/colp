import type { Page } from '@playwright/test';

/**
 * The extension's automation IndexedDB store, read and written from one of its
 * pages (the same origin as the worker). The schema mirrors
 * src/automation/indexeddb-store.ts, in case a page opens it first.
 */
type Access = { readonly op: 'get' | 'put' | 'intents' | 'putIntent'; readonly key?: string; readonly value?: unknown };

function access<T>(page: Page, request: Access): Promise<T> {
  return page.evaluate(({ op, key, value }) => new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open('known-automation', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('state'); open.result.createObjectStore('intents', { keyPath: 'intentId' }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, store = op === 'get' || op === 'put' ? 'state' : 'intents';
      const tx = db.transaction(store, op === 'put' || op === 'putIntent' ? 'readwrite' : 'readonly'), objects = tx.objectStore(store);
      const request = op === 'get' ? objects.get(key!) : op === 'put' ? objects.put(value, key!) : op === 'putIntent' ? objects.put(value) : objects.getAll();
      tx.oncomplete = () => { db.close(); resolve(op === 'get' || op === 'intents' ? request.result : null); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), request) as Promise<T>;
}

export const automationState = <T>(page: Page, key: string) => access<T | undefined>(page, { op: 'get', key });
export const putAutomationState = (page: Page, key: string, value: unknown) => access<null>(page, { op: 'put', key, value });
export const automationIntents = <T>(page: Page) => access<T[]>(page, { op: 'intents' });
export const putAutomationIntent = (page: Page, intent: unknown) => access<null>(page, { op: 'putIntent', value: intent });
