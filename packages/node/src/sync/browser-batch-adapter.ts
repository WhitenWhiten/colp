import { requirePromise } from './internal-guards.js';

/** Hard bounds for adapter-controlled browser batch fanout. */
export const MAX_BROWSER_BATCH_CHANGES = 256;
export const MAX_BROWSER_BATCH_AFFECTED_FOLDERS_PER_CHANGE = 32;
export const MAX_BROWSER_BATCH_FOLDERS = 512;

/** A native change with every folder whose index may have changed. */
export interface SyncBrowserBatchChange<FolderId = string> {
  /** Destination/current folder; retained for source compatibility. */
  readonly folderId: FolderId;
  /** Old folder for a cross-folder Move. */
  readonly sourceFolderId?: FolderId;
  /** Additional affected folders known by the native adapter. */
  readonly affectedFolderIds?: readonly FolderId[];
}

export interface SyncBrowserBatchDriver<Change extends SyncBrowserBatchChange<FolderId>, FolderId, Item> {
  readonly write: (change: Change) => Promise<unknown>;
  readonly readFolder: (folderId: FolderId) => Promise<readonly Item[]>;
}

export interface SyncBrowserFolderResult<FolderId, Item> {
  readonly folderId: FolderId;
  readonly items: readonly Item[];
}

function hasFolderId(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim().length === 0) return false;
  return true;
}

export function applySyncBrowserBatch<Change extends SyncBrowserBatchChange<FolderId>, FolderId, Item>(
  changes: readonly Change[], driver: SyncBrowserBatchDriver<Change, FolderId, Item>,
  options: { readonly grouped: true },
): Promise<readonly SyncBrowserFolderResult<FolderId, Item>[]>;
export function applySyncBrowserBatch<Change extends SyncBrowserBatchChange<FolderId>, FolderId, Item>(
  changes: readonly Change[], driver: SyncBrowserBatchDriver<Change, FolderId, Item>,
  options?: { readonly grouped?: false },
): Promise<readonly Item[]>;
/**
 * Writes sequentially, then rereads each affected folder exactly once.
 * Supply sourceFolderId for cross-folder Moves; folderId alone describes only
 * one folder. grouped:true preserves folder identity, including empty folders.
 * The default flat result remains compatible with existing consumers.
 * A failed write stops the batch and skips rereads; empty batches are no-ops.
 */
export async function applySyncBrowserBatch<Change extends SyncBrowserBatchChange<FolderId>, FolderId, Item>(
  changes: readonly Change[], driver: SyncBrowserBatchDriver<Change, FolderId, Item>,
  options: { readonly grouped?: boolean } = {},
): Promise<readonly Item[] | readonly SyncBrowserFolderResult<FolderId, Item>[]> {
  if (!Array.isArray(changes)) throw new TypeError('Browser batch changes must be an array.');
  if (changes.length > MAX_BROWSER_BATCH_CHANGES) {
    throw new RangeError(`Browser batch must not contain more than ${MAX_BROWSER_BATCH_CHANGES} changes.`);
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || (options.grouped !== undefined && typeof options.grouped !== 'boolean')) {
    throw new TypeError('Browser batch grouped option must be boolean.');
  }
  const grouped = options.grouped === true;
  if (changes.length === 0) return [];
  if (driver === null || typeof driver !== 'object') throw new TypeError('Browser batch driver must be an object.');
  if (typeof driver.write !== 'function' || typeof driver.readFolder !== 'function') {
    throw new TypeError('Browser batch driver must provide write and readFolder boundaries.');
  }

  // Validate and collect the entire affected scope before the first write.
  // This prevents an attacker-controlled batch from causing a large partial
  // prefix of writes or an unbounded Promise.all fanout after validation.
  const affectedFolders = new Set<FolderId>();
  for (const change of changes) {
    if (change === null || typeof change !== 'object') throw new TypeError('Browser batch change must be an object.');
    if (!('folderId' in change) || !hasFolderId(change.folderId)) {
      throw new TypeError('Browser batch change must include a folderId.');
    }
    const additional = change.affectedFolderIds;
    if (additional !== undefined && !Array.isArray(additional)) {
      throw new TypeError('Browser batch affectedFolderIds must contain valid folder IDs.');
    }
    if ((additional?.length ?? 0) > MAX_BROWSER_BATCH_AFFECTED_FOLDERS_PER_CHANGE) {
      throw new RangeError(`A browser batch change must not affect more than ${MAX_BROWSER_BATCH_AFFECTED_FOLDERS_PER_CHANGE} folders.`);
    }
    for (const folderId of additional ?? []) {
      if (!hasFolderId(folderId)) throw new TypeError('Browser batch affectedFolderIds must contain valid folder IDs.');
    }
    if (change.sourceFolderId !== undefined && !hasFolderId(change.sourceFolderId)) {
      throw new TypeError('Browser batch sourceFolderId must be a valid folder ID.');
    }
    affectedFolders.add(change.folderId);
    if (change.sourceFolderId !== undefined) affectedFolders.add(change.sourceFolderId);
    for (const folderId of additional ?? []) affectedFolders.add(folderId);
    if (affectedFolders.size > MAX_BROWSER_BATCH_FOLDERS) {
      throw new RangeError(`Browser batch must not affect more than ${MAX_BROWSER_BATCH_FOLDERS} folders.`);
    }
  }
  for (const change of changes) {
    await requirePromise(driver.write(change), 'Browser write boundary');
  }
  const folders = [...affectedFolders];
  // Keep rereads bounded in time and concurrency as well as in cardinality.
  // A sequential read avoids turning a valid 512-folder batch into a burst
  // of simultaneous browser/database work.
  const rereads: Array<readonly Item[]> = [];
  for (const folderId of folders) {
    rereads.push(await requirePromise(driver.readFolder(folderId), 'Browser folder read boundary'));
  }
  if (!grouped) return rereads.flat();
  return Object.freeze(folders.map((folderId, index) => Object.freeze({
    folderId, items: Object.freeze([...rereads[index]!]),
  })));
}
export type SyncBrowserBatchAdapter<Change extends SyncBrowserBatchChange<FolderId>, FolderId, Item> =
  SyncBrowserBatchDriver<Change, FolderId, Item>;
