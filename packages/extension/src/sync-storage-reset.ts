import type { StorageArea } from './credential-store.js';
import { storageErrorCode } from './storage-error-code.js';
import { DATABASE_NAME, STORES } from './sync-state/schema.js';
import type { SyncStorageHealth, SyncStorageState } from './sync-state/storage-state.js';

/**
 * W2A-01: the one controlled place that deletes the sync database.
 *
 * Every other exit (Reset, sign-out) reads or writes that database first, so a database written by a newer
 * extension, one missing a store, or a failing backing store left no way out short of reinstalling, which
 * loses the unsent changes and orphans the replica on the server. This module is the way out: after the
 * person confirms, it saves a copy of the unsent changes it can still read, moves this browser to a new
 * replica identity and deletes the database. The bookmarks in the browser are never touched; the next
 * sync starts again from the first-sync merge.
 *
 * It lives outside `sync-state/` on purpose: the store contract forbids deleting the database anywhere
 * else, and `tests/sync-storage-reset.test.ts` pins that this is the only caller of `deleteDatabase`.
 */
export const LOCAL_DATA_RESET_ARCHIVE = 'known.sync.local-data-reset.v1';
/** Archives kept (newest last): a second attempt after a crash must not push the first out, yet storage stays bounded. */
const MAX_ARCHIVES = 3;
const MAX_ARCHIVED_CHANGES = 20_000;
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024;
const DELETE_WAIT_MS = 15_000;
const FENCE_WAIT_MS = 8_000;
const ENSURE_WAIT_MS = 10_000;

export type SyncStorageResetRequest = { readonly kind: 'known.sync.storage.reset.preview' }
  | { readonly kind: 'known.sync.storage.reset.confirm'; readonly userGesture: true };
export interface SyncStorageResetPreview {
  readonly state: Exclude<SyncStorageState, 'ok'>;
  readonly code: string;
  /** Unsent changes found in the unusable database; they are saved to the archive first. */
  readonly unsentChanges: number;
  /** False when the database could not be read at all, so there is nothing to save. */
  readonly readable: boolean;
}
export type SyncStorageResetResponse = { readonly ok: true; readonly preview: SyncStorageResetPreview }
  | { readonly ok: true; readonly result: 'reset'; readonly archivedChanges: number; readonly omittedChanges: number }
  | { readonly ok: false; readonly code: string };

export function validSyncStorageResetRequest(value: unknown): value is SyncStorageResetRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>; const keys = Object.keys(row);
  if (row.kind === 'known.sync.storage.reset.preview') return keys.length === 1;
  return row.kind === 'known.sync.storage.reset.confirm' && row.userGesture === true && keys.length === 2;
}

export interface UnsentChanges { readonly rows: readonly unknown[]; readonly readable: boolean }

/**
 * Reads the unsent upload rows without the store: any version, no validation, no upgrade. The store that
 * cannot open is the reason this is needed. A database that does not exist is not created.
 */
export async function readUnsentChanges(factory: IDBFactory, name = DATABASE_NAME): Promise<UnsentChanges> {
  // Opening a database that is not there would create it; ask first where the browser can tell.
  if (await factory.databases?.().then(list => !list.some(info => info.name === name), () => false)) return { rows: [], readable: true };
  let db: IDBDatabase | undefined;
  try { db = await openExisting(factory, name); } catch { return { rows: [], readable: false }; }
  if (!db) return { rows: [], readable: true };
  try {
    if (!db.objectStoreNames.contains(STORES.queue)) return { rows: [], readable: true };
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(STORES.queue, 'readonly');
      const request = tx.objectStore(STORES.queue).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
    return { rows: rows.filter(unsent), readable: true };
  } catch { return { rows: [], readable: false }; }
  finally { db.close(); }
}

const unsent = (row: unknown) => !(row && typeof row === 'object' && (row as { status?: unknown }).status === 'terminal');

function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name); // no version: whatever is there, never an upgrade
    let absent = false;
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort(); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { if (absent) resolve(undefined); else reject(request.error ?? new Error('storage_unavailable')); };
  });
}

/** Deletes the database. A connection that stays open holds it back; that is reported, not waited for forever. */
export function deleteSyncDatabase(factory: IDBFactory, waitMilliseconds = DELETE_WAIT_MS, name = DATABASE_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => { if (timer) clearTimeout(timer); settle(); };
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => finish(resolve);
    request.onerror = () => finish(() => reject(new Error(storageErrorCode(request.error?.name) ?? 'storage_reset_failed')));
    request.onblocked = () => { timer ??= setTimeout(() => reject(new Error('storage_reset_blocked')), waitMilliseconds); };
  });
}

export interface SyncStorageResetDeps {
  readonly probe: () => Promise<SyncStorageHealth>;
  readonly indexedDB: IDBFactory;
  /** `chrome.storage.local`: where the copy of the unsent changes goes. */
  readonly archive: Pick<StorageArea, 'get' | 'set'>;
  readonly now: () => number;
  /** Takes the old replica off the server while its Session is still valid. Best effort, bounded. */
  readonly fence?: () => Promise<unknown>;
  /** The replica this browser is bound to, named in the archive so a copy can be traced to its replica. */
  readonly currentReplicaId?: () => Promise<string | undefined>;
  /** Moves this browser to a new replica identity (and drops the old Session). A no-op when signed out. */
  readonly rotateBinding: () => Promise<unknown>;
  /** Closes the connection and forgets the flags of the deleted database. */
  readonly forget: () => void;
  /** Drops the worker's caches of the old identity. */
  readonly resetRuntime: () => void;
  /** Registers the new scope in the fresh database. Best effort: the next Session renewal does it otherwise. */
  readonly ensureScope?: () => Promise<unknown>;
  readonly deleteWaitMilliseconds?: number;
  readonly fenceWaitMilliseconds?: number;
  readonly ensureWaitMilliseconds?: number;
}

interface LocalDataArchive {
  readonly at: number; readonly state: string; readonly code: string; readonly readable: boolean;
  readonly replicaId?: string; readonly changes: readonly unknown[]; readonly omitted: number;
}

/** Keeps the oldest changes first (they are the ones the server has waited longest for) within the caps. */
function boundedChanges(rows: readonly unknown[]): { readonly kept: unknown[]; readonly omitted: number } {
  const kept: unknown[] = []; let bytes = 0;
  for (const row of rows) {
    let size: number;
    try { size = JSON.stringify(row)?.length ?? 0; } catch { size = Number.POSITIVE_INFINITY; }
    if (kept.length >= MAX_ARCHIVED_CHANGES || bytes + size > MAX_ARCHIVE_BYTES) continue;
    kept.push(row); bytes += size;
  }
  return { kept, omitted: rows.length - kept.length };
}

export function createSyncStorageReset(deps: SyncStorageResetDeps) {
  async function needed(): Promise<{ readonly health: SyncStorageHealth & { readonly state: Exclude<SyncStorageState, 'ok'> } }> {
    const health = await deps.probe();
    if (health.state === 'ok') throw new Error('storage_reset_not_needed');
    return { health: health as SyncStorageHealth & { readonly state: Exclude<SyncStorageState, 'ok'> } };
  }
  async function preview(): Promise<SyncStorageResetResponse> {
    const { health } = await needed();
    const found = await readUnsentChanges(deps.indexedDB);
    return { ok: true, preview: { state: health.state, code: health.code ?? 'storage_unavailable',
      unsentChanges: found.rows.length, readable: found.readable } };
  }
  /** The copy is written before anything is deleted; if it cannot be written, nothing is. */
  async function saveCopy(health: SyncStorageHealth, found: UnsentChanges, replicaId: string | undefined) {
    const { kept, omitted } = boundedChanges(found.rows);
    if (kept.length === 0 && omitted === 0) return { archived: 0, omitted: 0 };
    const prior = (await deps.archive.get(LOCAL_DATA_RESET_ARCHIVE))[LOCAL_DATA_RESET_ARCHIVE] as
      { readonly archives?: readonly LocalDataArchive[] } | undefined;
    const next: LocalDataArchive = { at: deps.now(), state: health.state, code: health.code ?? 'storage_unavailable',
      readable: found.readable, ...(replicaId ? { replicaId } : {}), changes: kept, omitted };
    try {
      await deps.archive.set({ [LOCAL_DATA_RESET_ARCHIVE]: { archives: [...(prior?.archives ?? []), next].slice(-MAX_ARCHIVES) } });
    } catch { throw new Error('archive_failed'); }
    return { archived: kept.length, omitted };
  }
  async function bounded(work: (() => Promise<unknown>) | undefined, waitMilliseconds: number) {
    if (!work) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), waitMilliseconds); })]);
    } catch { /* best effort */ } finally { if (timer) clearTimeout(timer); }
  }
  async function confirm(): Promise<SyncStorageResetResponse> {
    const { health } = await needed();
    const found = await readUnsentChanges(deps.indexedDB);
    const saved = await saveCopy(health, found, await deps.currentReplicaId?.().catch(() => undefined));
    // The old replica leaves the server while its Session still exists; rotating the identity drops that Session.
    await bounded(deps.fence, deps.fenceWaitMilliseconds ?? FENCE_WAIT_MS);
    await deps.rotateBinding();
    deps.forget();
    await deleteSyncDatabase(deps.indexedDB, deps.deleteWaitMilliseconds ?? DELETE_WAIT_MS);
    deps.forget();
    deps.resetRuntime();
    await bounded(deps.ensureScope, deps.ensureWaitMilliseconds ?? ENSURE_WAIT_MS);
    return { ok: true, result: 'reset', archivedChanges: saved.archived, omittedChanges: saved.omitted };
  }
  return {
    async handle(message: SyncStorageResetRequest): Promise<SyncStorageResetResponse> {
      try { return message.kind === 'known.sync.storage.reset.preview' ? await preview() : await confirm(); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        return { ok: false, code: /^[a-z][a-z0-9_:-]{0,63}$/u.test(code) ? code : 'storage_reset_failed' };
      }
    },
  };
}
