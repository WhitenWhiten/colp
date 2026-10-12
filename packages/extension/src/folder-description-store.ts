import { observeMetadata, sameMetadataField, type MetadataField } from './local-metadata-state.js';
import { METADATA_RETENTION_MS, retainedMetadataFor } from './metadata-retention.js';

export const FOLDER_DESCRIPTION_DATABASE = 'known-folder-descriptions';
export const FOLDER_DESCRIPTION_MAX_BYTES = 16_384;
const TABLE = 'folders';

export interface DescriptionFolder { readonly id: string; readonly dateAdded?: number; readonly title?: string }
export interface FolderDescriptionBinding {
  readonly scopeKey: string; readonly colpId: string; readonly revision: string;
  readonly description: string | null;
}
export interface FolderDescriptionAttempt {
  readonly scopeKey: string; readonly colpId: string; readonly description: string | null;
  readonly version: number; readonly eventId?: string;
}
export interface FolderDescriptionObservation {
  readonly folder: DescriptionFolder; readonly binding: FolderDescriptionBinding;
  /** Only a terminal conflicted queue receipt proves that this attempted version was explicitly resolved. */
  readonly resolvedAttemptVersion?: number;
}
export interface FolderDescriptionRecord {
  readonly nativeId: string; readonly dateAdded?: number; readonly description: string | null;
  readonly version: number; readonly state: 'dirty' | 'synced'; readonly updatedAt: number;
  readonly remote?: FolderDescriptionBinding;
  readonly attempt?: FolderDescriptionAttempt;
  readonly reviewVersion?: number;
  readonly title?: string; readonly removedAt?: number;
}

export function validateFolderDescription(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || value.length > 20_000
      || new TextEncoder().encode(value).length > FOLDER_DESCRIPTION_MAX_BYTES)) throw new Error('folder_description_invalid');
}

export function descriptionMatchesFolder(record: FolderDescriptionRecord, folder: DescriptionFolder): boolean {
  return record.removedAt === undefined && record.nativeId === folder.id && (record.dateAdded === undefined || folder.dateAdded === undefined
    || record.dateAdded === folder.dateAdded);
}

function descriptionField(record: FolderDescriptionRecord | undefined): MetadataField<string | null> | undefined {
  if (!record) return undefined;
  return { value: record.description, version: record.version, state: record.state,
    ...(record.reviewVersion === undefined ? {} : { reviewVersion: record.reviewVersion }),
    ...(record.remote ? { remote: { scopeKey: record.remote.scopeKey, resourceId: record.remote.colpId,
      revision: record.remote.revision, value: record.remote.description } } : {}),
    ...(record.attempt ? { attempt: { scopeKey: record.attempt.scopeKey, resourceId: record.attempt.colpId,
      revision: record.remote?.revision ?? '', value: record.attempt.description, version: record.attempt.version,
      eventId: record.attempt.eventId ?? '' } } : {}) };
}

/** Profile-local metadata survives sign-out and browser restarts. No expiry or account credential is involved. */
export function createFolderDescriptionStore(options: { readonly indexedDB?: IDBFactory; readonly now?: () => number } = {}) {
  let opening: Promise<IDBDatabase> | undefined;
  const now = options.now ?? Date.now;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) { reject(new Error('indexeddb_unavailable')); return; }
    const request = factory.open(FOLDER_DESCRIPTION_DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(TABLE, { keyPath: 'nativeId' }); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });

  async function transaction<T>(mode: IDBTransactionMode, work: (table: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE, mode); let result: T;
      tx.oncomplete = () => resolve(result!);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('folder_description_write_failed'));
      try { work(tx.objectStore(TABLE), value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  async function get(folder: DescriptionFolder): Promise<FolderDescriptionRecord | null> {
    return transaction('readonly', (table, result) => {
      const request = table.get(folder.id);
      request.onsuccess = () => { const row = request.result as FolderDescriptionRecord | undefined;
        result(row && descriptionMatchesFolder(row, folder) ? row : null); };
    });
  }

  async function list(includeRemoved = false): Promise<readonly FolderDescriptionRecord[]> {
    return transaction('readonly', (table, result) => {
      const request = table.getAll(); request.onsuccess = () => result((request.result as FolderDescriptionRecord[]).filter(row => includeRemoved || row.removedAt === undefined));
    });
  }

  async function save(folder: DescriptionFolder, description: string | null, expectedVersion?: number, expectedRemoteRevision?: string): Promise<FolderDescriptionRecord> {
    validateFolderDescription(description);
    if (description === '') description = null;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE, 'readwrite'), table = tx.objectStore(TABLE); let next: FolderDescriptionRecord;
      tx.oncomplete = () => resolve(next!);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('folder_description_write_failed'));
      const request = table.get(folder.id);
      request.onsuccess = () => {
        const candidate = request.result as FolderDescriptionRecord | undefined;
        const current = candidate && descriptionMatchesFolder(candidate, folder) ? candidate : undefined;
        if (expectedVersion !== undefined && expectedVersion !== (current?.version ?? 0)
          || expectedRemoteRevision !== undefined && expectedRemoteRevision !== current?.remote?.revision) {
          reject(new Error('folder_description_changed')); tx.abort(); return;
        }
        if (current && current.description === description && current.reviewVersion === undefined) { next = current; return; }
        next = { nativeId: folder.id, title: folder.title ?? current?.title, ...(folder.dateAdded === undefined ? {} : { dateAdded: folder.dateAdded }),
          description, version: (current?.version ?? 0) + 1, state: 'dirty', updatedAt: now(),
          ...(current?.remote ? { remote: current.remote } : {}), ...(current?.attempt ? { attempt: current.attempt } : {}) };
        table.put(next);
      };
    });
  }

  async function observeRemote(observations: readonly FolderDescriptionObservation[]): Promise<readonly string[]> {
    for (const observation of observations) validateFolderDescription(observation.binding.description);
    return transaction('readwrite', (table, result) => {
      const changed: string[] = []; result(changed);
      for (const { folder, binding, resolvedAttemptVersion } of observations) {
        const request = table.get(folder.id);
        request.onsuccess = () => {
          const candidate = request.result as FolderDescriptionRecord | undefined;
          const current = candidate && descriptionMatchesFolder(candidate, folder) ? candidate : undefined;
          const cloudDescription = binding.description === '' ? null : binding.description;
          const field = observeMetadata(descriptionField(current), { scopeKey: binding.scopeKey,
            resourceId: binding.colpId, revision: binding.revision, value: cloudDescription },
          (a, b) => a === b, resolvedAttemptVersion);
          if (current && sameMetadataField(descriptionField(current), field, (a, b) => a === b)) return;
          const description = field.value;
          if ((current?.description ?? null) !== description) changed.push(folder.id);
          const next: FolderDescriptionRecord = { nativeId: folder.id, title: folder.title ?? current?.title,
            ...(folder.dateAdded === undefined ? {} : { dateAdded: folder.dateAdded }), description,
            version: field.version, state: field.state, updatedAt: now(),
            ...(field.reviewVersion === undefined ? {} : { reviewVersion: field.reviewVersion }),
            ...(field.remote ? { remote: { scopeKey: field.remote.scopeKey, colpId: field.remote.resourceId,
              revision: field.remote.revision, description: field.remote.value } } : {}),
            ...(field.attempt ? { attempt: { scopeKey: field.attempt.scopeKey, colpId: field.attempt.resourceId,
              description: field.attempt.value, version: field.attempt.version, eventId: field.attempt.eventId } } : {}) };
          table.put(next);
        };
      }
    });
  }

  async function markAttempt(folder: DescriptionFolder, sent: FolderDescriptionRecord, binding: FolderDescriptionBinding,
    eventId?: string): Promise<FolderDescriptionAttempt | null> {
    return transaction('readwrite', (table, result) => {
      result(null);
      const request = table.get(folder.id);
      request.onsuccess = () => {
        const current = request.result as FolderDescriptionRecord | undefined;
        if (!current || !descriptionMatchesFolder(current, folder) || current.state !== 'dirty' || current.version < sent.version) return;
        const prior = current.attempt;
        const sameAttempt = prior?.scopeKey === binding.scopeKey && prior.colpId === binding.colpId
          && prior.version === sent.version && prior.description === sent.description;
        const attempt = { scopeKey: binding.scopeKey, colpId: binding.colpId, description: sent.description, version: sent.version,
          eventId: eventId ?? (sameAttempt ? prior.eventId : undefined) ?? crypto.randomUUID() };
        table.put({ ...current, attempt }); result(attempt);
      };
    });
  }

  async function remove(nativeIds: readonly string[], folders: readonly DescriptionFolder[] = []): Promise<void> {
    return transaction('readwrite', (table, result) => {
      const identities = new Map(folders.map(folder => [folder.id, folder])); result(undefined);
      for (const id of nativeIds) { const request = table.get(id); request.onsuccess = () => {
        const row = request.result as FolderDescriptionRecord | undefined;
        if (row && row.removedAt === undefined) table.put({ ...row, title: identities.get(id)?.title ?? row.title, removedAt: now() });
      }; }
    });
  }

  async function restoreRemoved(folder: DescriptionFolder) {
    return transaction('readwrite', (table, result) => {
      result(undefined); const request = table.getAll(); request.onsuccess = () => {
        const rows = request.result as FolderDescriptionRecord[];
        if (rows.some(row => descriptionMatchesFolder(row, folder))) return;
        const row = retainedMetadataFor(rows, folder, now()); if (!row) return;
        // A restored identity retains its original remote authority and review
        // state; it must never become an unbound draft for a different account.
        const { removedAt: _removedAt, ...restored } = row;
        table.put({ ...restored, title: folder.title ?? row.title, updatedAt: now() });
      };
    });
  }
  const pruneRemoved = () => transaction('readwrite', (table, result) => {
    result(undefined); const request = table.openCursor(); request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return;
      const row = cursor.value as FolderDescriptionRecord;
      if (row.removedAt !== undefined && now() - row.removedAt >= METADATA_RETENTION_MS) cursor.delete();
      cursor.continue();
    };
  });

  async function releaseBindings(folders: readonly DescriptionFolder[]) {
    return transaction('readwrite', (table, result) => {
      result(undefined);
      for (const folder of folders) {
        const request = table.get(folder.id);
        request.onsuccess = () => {
          const row = request.result as FolderDescriptionRecord | undefined;
          if (!row || !descriptionMatchesFolder(row, folder)) return;
          table.put({ nativeId: row.nativeId, dateAdded: row.dateAdded, title: row.title, description: row.description,
            version: row.version + 1, state: row.description === null ? 'synced' : 'dirty', updatedAt: now() });
        };
      }
    });
  }

  return Object.freeze({ get, list, save, observeRemote, markAttempt, remove, releaseBindings, restoreRemoved, pruneRemoved,
    close() { void opening?.then(db => db.close()).catch(() => undefined); opening = undefined; } });
}
