import { requestValue, transactionDone, iterateCursor } from '../sync-state/idb.js';
import type { SnapshotStateArea } from './bundle-store.js';
import type { ObservedPlacement } from './observed-create.js';
import { AUTOMATION_BUNDLE_KEY, AUTOMATION_CHANGED_KEY, AUTOMATION_RECEIPTS_KEY } from './messages.js';
import { ACTIVITY_STATUS_KEY } from './activity-status.js';
import { SERVER_STATUS_KEY } from './server-status.js';

/**
 * The automation store: this browser's installed rule bundle, its placement
 * receipts and the write-ahead intents of observed placements, in one
 * IndexedDB database that outlives worker restarts and browser restarts.
 *
 * Bundle and receipts keep the value shapes bundle-store.ts and
 * receipt-sync.ts already read and write; every write lands in one
 * transaction. Values that earlier builds kept in chrome.storage.local move
 * here once, the first time the store is opened, and are then removed there.
 * Pages are told about changes through a small marker in chrome.storage.local,
 * because IndexedDB has no change events.
 */
export const AUTOMATION_DB = 'known-automation';
const VERSION = 1;
const STATE = 'state', INTENTS = 'intents';
const MIGRATED_KEYS = [AUTOMATION_BUNDLE_KEY, AUTOMATION_RECEIPTS_KEY] as const;
/** One account's records, each naming its owner, and the receipt list, whose entries each name theirs. */
const ACCOUNT_RECORDS = [AUTOMATION_BUNDLE_KEY, SERVER_STATUS_KEY, ACTIVITY_STATUS_KEY] as const;
const owns = (value: unknown, ownerKey: string) =>
  Boolean(value) && typeof value === 'object' && (value as { ownerKey?: unknown }).ownerKey === ownerKey;

/** An observed move about to happen: written before the move, removed once its receipt exists. */
export interface PlacementIntent extends ObservedPlacement {
  readonly intentId: string;
  readonly ownerKey: string;
  readonly fromParentId: string;
  readonly dateAdded: number | null;
  readonly createdAt: number;
}

export interface LegacyArea {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string | string[]): Promise<void>;
}

export function createAutomationDatabase(factory: IDBFactory, options: {
  readonly legacy?: LegacyArea; readonly changed?: () => Promise<void>;
} = {}) {
  let connection: Promise<IDBDatabase> | undefined;

  function openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(AUTOMATION_DB, VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STATE);
        request.result.createObjectStore(INTENTS, { keyPath: 'intentId' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = undefined; };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('automation_database_open_failed'));
    });
  }

  /**
   * One open attempt, including the one-time move of earlier builds' values.
   * Concurrent callers share the attempt (single-flight), so the migration and
   * its legacy removals run once. A failed migration rejects this attempt and
   * closes its connection instead of caching it: the values stay in legacy
   * storage and a later open() creates a fresh connection and retries. Callers
   * therefore never observe a connection whose migration silently failed, and
   * a successful open keeps the established behavior.
   */
  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    const attempt = (async () => {
      const db = await openDatabase();
      try { await migrate(db); return db; }
      catch (error) { db.close(); throw error; }
    })();
    connection = attempt;
    // Reset only this failed attempt; an open() that already started a newer one is untouched.
    void attempt.catch(() => { if (connection === attempt) connection = undefined; });
    return attempt;
  }
  async function run<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = (await open()).transaction(stores, mode);
    const done = transactionDone(tx);
    try { const result = await work(tx); await done; return result; }
    catch (error) { try { tx.abort(); } catch { /* Already settled. */ } await done.catch(() => undefined); throw error; }
  }
  /**
   * Earlier builds' values move here once; a value already here is never overwritten by an older copy.
   * A failed read, write or legacy removal rejects the open: nothing is removed from legacy storage
   * until the write transaction has committed, and a later open retries the whole move.
   */
  async function migrate(db: IDBDatabase): Promise<void> {
    const legacy = options.legacy;
    if (!legacy) return;
    const values = await Promise.all(MIGRATED_KEYS.map(async (key) => [key, (await legacy.get(key))[key]] as const));
    const present = values.filter(([, value]) => value !== undefined);
    if (!present.length) return;
    const tx = db.transaction(STATE, 'readwrite'), done = transactionDone(tx), store = tx.objectStore(STATE);
    for (const [key, value] of present) if (await requestValue(store.get(key)) === undefined) store.put(value, key);
    await done;
    await legacy.remove(present.map(([key]) => key));
  }
  const changed = () => options.changed?.().catch(() => undefined);

  return {
    /** Key/value access for the bundle record, the receipt list and this browser's own rules. */
    area(): SnapshotStateArea {
      return {
        get: (key) => run([STATE], 'readonly', (tx) => requestValue(tx.objectStore(STATE).get(key))),
        getMany: (keys) => run([STATE], 'readonly', async (tx) => {
          const state = tx.objectStore(STATE);
          const values = await Promise.all(keys.map((key) => requestValue(state.get(key))));
          return Object.fromEntries(keys.flatMap((key, index) => values[index] === undefined ? [] : [[key, values[index]]]));
        }),
        async set(key, value) { await run([STATE], 'readwrite', async (tx) => { tx.objectStore(STATE).put(value, key); }); await changed(); },
        async commit(writes, deletes = []) {
          await run([STATE], 'readwrite', async (tx) => {
            const state = tx.objectStore(STATE);
            for (const [key, value] of Object.entries(writes)) state.put(value, key);
            for (const key of deletes) state.delete(key);
          });
          await changed();
        },
      };
    },
    /**
     * Sign-out (AW-72): that account's bundle, server status, receipts and
     * placement intents go, in one transaction. Another account's entries and
     * this browser's own rules and their log (rule-list-store.ts, browser-rule-store.ts) stay.
     */
    async pruneDeviceRequests(now: number): Promise<void> {
      await run([STATE], 'readwrite', async tx => {
        await iterateCursor(tx.objectStore(STATE), IDBKeyRange.bound('known.automation.device-bridge.v1.request.', 'known.automation.device-bridge.v1.request.\uffff'),
          (value, cursor) => { if (typeof value === 'object' && value && 'retainUntil' in value && typeof value.retainUntil === 'number' && value.retainUntil < now) cursor.delete(); });
      });
    },
    async clearAccount(ownerKey: string): Promise<void> {
      await run([STATE, INTENTS], 'readwrite', async (tx) => {
        const state = tx.objectStore(STATE), intents = tx.objectStore(INTENTS);
        for (const key of ACCOUNT_RECORDS) if (owns(await requestValue(state.get(key)), ownerKey)) state.delete(key);
        const receipts = await requestValue(state.get(AUTOMATION_RECEIPTS_KEY));
        if (Array.isArray(receipts) && receipts.some((receipt) => owns(receipt, ownerKey))) {
          state.put(receipts.filter((receipt) => !owns(receipt, ownerKey)), AUTOMATION_RECEIPTS_KEY);
        }
        const quarantineKey = `${AUTOMATION_RECEIPTS_KEY}.quarantine`;
        const quarantined = await requestValue(state.get(quarantineKey));
        if (Array.isArray(quarantined)) state.put(quarantined.filter(item => !owns(item?.raw, ownerKey)), quarantineKey);
        await iterateCursor(state, IDBKeyRange.bound('known.automation.device-bridge.v1.request.', 'known.automation.device-bridge.v1.request.\uffff'),
          (value, cursor) => { if (owns(value, ownerKey)) cursor.delete(); });
        for (const intent of await requestValue(intents.getAll()) as PlacementIntent[]) {
          if (intent.ownerKey === ownerKey) intents.delete(intent.intentId);
        }
      });
      await changed();
    },
    intents: {
      put: (intent: PlacementIntent) => run([INTENTS], 'readwrite', async (tx) => { tx.objectStore(INTENTS).put(intent); }),
      remove: (intentId: string) => run([INTENTS], 'readwrite', async (tx) => { tx.objectStore(INTENTS).delete(intentId); }),
      list: () => run([INTENTS], 'readonly', (tx) => requestValue(tx.objectStore(INTENTS).getAll()) as Promise<PlacementIntent[]>),
    },
    close(): void { void connection?.then((db) => db.close()).catch(() => undefined); connection = undefined; },
  };
}
export type AutomationDatabase = ReturnType<typeof createAutomationDatabase>;

let shared: { readonly factory: IDBFactory; readonly database: AutomationDatabase } | undefined;
/** The worker's database over the current `indexedDB`, migrating chrome.storage.local values on first open. */
export function automationDatabase(): AutomationDatabase {
  if (shared?.factory !== indexedDB) {
    shared?.database.close();
    shared = { factory: indexedDB, database: createAutomationDatabase(indexedDB, {
      legacy: { get: (key) => chrome.storage.local.get(key), remove: (key) => chrome.storage.local.remove(key) },
      changed: () => chrome.storage.local.set({ [AUTOMATION_CHANGED_KEY]: Date.now() }),
    }) };
  }
  return shared.database;
}
