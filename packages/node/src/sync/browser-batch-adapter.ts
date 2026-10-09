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
  const validatedChanges: Change[] = [];
  for (const change of changes) {
    if (change === null || typeof change !== 'object') throw new TypeError('Browser batch change must be an object.');
    const folderDescriptor = Object.getOwnPropertyDescriptor(change, 'folderId');
    if (folderDescriptor === undefined || !('value' in folderDescriptor) || !folderDescriptor.enumerable
      || !hasFolderId(folderDescriptor.value)) {
      throw new TypeError('Browser batch change must include a folderId.');
    }
    const sourceDescriptor = Object.getOwnPropertyDescriptor(change, 'sourceFolderId');
    if (sourceDescriptor !== undefined && (!('value' in sourceDescriptor) || !sourceDescriptor.enumerable)) {
      throw new TypeError('Browser batch sourceFolderId must be a data property.');
    }
    const additionalDescriptor = Object.getOwnPropertyDescriptor(change, 'affectedFolderIds');
    if (additionalDescriptor !== undefined && (!('value' in additionalDescriptor) || !additionalDescriptor.enumerable)) {
      throw new TypeError('Browser batch affectedFolderIds must be a data property.');
    }
    const additional = additionalDescriptor?.value as readonly FolderId[] | undefined;
    if (additional !== undefined && !Array.isArray(additional)) {
      throw new TypeError('Browser batch affectedFolderIds must contain valid folder IDs.');
    }
    if ((additional?.length ?? 0) > MAX_BROWSER_BATCH_AFFECTED_FOLDERS_PER_CHANGE) {
      throw new RangeError(`A browser batch change must not affect more than ${MAX_BROWSER_BATCH_AFFECTED_FOLDERS_PER_CHANGE} folders.`);
    }
    for (const folderId of additional ?? []) {
      if (!hasFolderId(folderId)) throw new TypeError('Browser batch affectedFolderIds must contain valid folder IDs.');
    }
    const sourceFolderId = sourceDescriptor?.value as FolderId | undefined;
    if (sourceFolderId !== undefined && !hasFolderId(sourceFolderId)) {
      throw new TypeError('Browser batch sourceFolderId must be a valid folder ID.');
    }
    affectedFolders.add(folderDescriptor.value as FolderId);
    if (sourceFolderId !== undefined) affectedFolders.add(sourceFolderId);
    for (const folderId of additional ?? []) affectedFolders.add(folderId);
    if (affectedFolders.size > MAX_BROWSER_BATCH_FOLDERS) {
      throw new RangeError(`Browser batch must not affect more than ${MAX_BROWSER_BATCH_FOLDERS} folders.`);
    }

    // Snapshot the validated change before yielding to asynchronous writes.
    // Passing the caller-owned object lets a mutation after validation change
    // the folder scope or payload that the driver actually persists.
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(change)) {
      if (typeof key !== 'string') throw new TypeError('Browser batch change must not contain symbol properties.');
      const descriptor = Object.getOwnPropertyDescriptor(change, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Browser batch change members must be enumerable data properties.');
      }
      const snapshotValue = key === 'affectedFolderIds' && Array.isArray(descriptor.value)
        ? Object.freeze([...descriptor.value])
        : descriptor.value;
      Object.defineProperty(snapshot, key, {
        value: snapshotValue,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    validatedChanges.push(Object.freeze(snapshot) as Change);
  }
  for (const change of validatedChanges) {
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
