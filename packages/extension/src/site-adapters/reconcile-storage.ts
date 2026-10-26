import type { ReconcilePreview } from './reconcile-model.js';
import { get, put, sourceKey, type SourceDatabase } from './source-db.js';

export const RECONCILE_PAGE_SIZE = 100;
export type ReconcileData = Pick<ReconcilePreview, 'differences' | 'snapshots'>;
type Paged<T extends ReconcileData> = T & { storage: 'paged-v1'; differenceCount: number; snapshotSizes: number[] };
const partKey = (key: string, kind: string, page: number) => sourceKey('reconcilePart', key, kind, page);

/** Header and bounded pages commit atomically. Legacy inline records remain readable. */
export async function writeReconcileData<T extends ReconcileData>(db: SourceDatabase, key: string, data: T) {
  await db.transaction(['meta'], 'readwrite', async tx => {
    const write = (kind: string, values: readonly unknown[]) => {
      for (let start = 0; start < values.length; start += RECONCILE_PAGE_SIZE)
        put(tx, 'meta', partKey(key, kind, start / RECONCILE_PAGE_SIZE), values.slice(start, start + RECONCILE_PAGE_SIZE));
    };
    write('differences', data.differences);
    data.snapshots.forEach((snapshot, index) => write(`snapshot:${index}`, snapshot.items));
    put(tx, 'meta', key, { ...data, storage: 'paged-v1', differenceCount: data.differences.length,
      snapshotSizes: data.snapshots.map(s => s.items.length), differences: [], snapshots: data.snapshots.map(s => ({ ...s, items: [] })) } satisfies Paged<T>);
  });
}

export async function readReconcileData<T extends ReconcileData>(db: SourceDatabase, key: string): Promise<T | undefined> {
  return db.transaction(['meta'], 'readonly', async tx => {
    const header = await get<T | Paged<T>>(tx, 'meta', key); if (!header) return undefined;
    if (!('storage' in header)) return header;
    if (header.storage !== 'paged-v1') throw new Error('schemaIncompatible');
    const read = async <V>(kind: string, count: number): Promise<V[]> => {
      const rows: V[] = [];
      for (let page = 0; rows.length < count; page++) {
        const part = await get<V[]>(tx, 'meta', partKey(key, kind, page));
        if (!part || part.length !== Math.min(RECONCILE_PAGE_SIZE, count - rows.length)) throw new Error('reconcilePreviewIncomplete');
        rows.push(...part);
      }
      return rows;
    };
    const { storage: _storage, differenceCount, snapshotSizes, ...data } = header;
    data.differences = await read('differences', differenceCount);
    data.snapshots = await Promise.all(data.snapshots.map(async (snapshot, index) => ({ ...snapshot,
      items: await read<ReconcilePreview['snapshots'][number]['items'][number]>(`snapshot:${index}`, snapshotSizes[index]!) })));
    return data as unknown as T;
  });
}
