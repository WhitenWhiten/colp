import type { ReconcilePreview } from './reconcile-model.js';
import { get, put, sourceKey, type SourceDatabase } from './source-db.js';

export const RECONCILE_PAGE_SIZE = 100;
export type ReconcileData = Pick<ReconcilePreview, 'differences' | 'snapshots'>;
type Paged<T extends ReconcileData> = T & { storage: 'paged-v1'; differenceCount: number; snapshotSizes: number[]; visibleCount: number; counts: NonNullable<ReconcilePreview['page']>['counts'] };
const partKey = (key: string, kind: string, page: number) => sourceKey('reconcilePart', key, kind, page);

/** Header and bounded pages commit atomically. Legacy inline records remain readable. */
export async function writeReconcileData<T extends ReconcileData>(db: SourceDatabase, key: string, data: T) {
  await db.transaction(['meta'], 'readwrite', async tx => {
    const write = (kind: string, values: readonly unknown[]) => {
      for (let start = 0; start < values.length; start += RECONCILE_PAGE_SIZE)
        put(tx, 'meta', partKey(key, kind, start / RECONCILE_PAGE_SIZE), values.slice(start, start + RECONCILE_PAGE_SIZE));
    };
    write('differences', data.differences);
    const visible = data.differences.filter(d => d.kind !== 'present'), counts: NonNullable<ReconcilePreview['page']>['counts'] = {};
    for (const d of data.differences) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    write('visible', visible);
    data.snapshots.forEach((snapshot, index) => write(`snapshot:${index}`, snapshot.items));
    put(tx, 'meta', key, { ...data, storage: 'paged-v1', differenceCount: data.differences.length,
      visibleCount: visible.length, counts, snapshotSizes: data.snapshots.map(s => s.items.length), differences: [], snapshots: data.snapshots.map(s => ({ ...s, items: [] })) } satisfies Paged<T>);
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
    const { storage: _storage, differenceCount, snapshotSizes, visibleCount: _visibleCount, counts: _counts, ...data } = header;
    data.differences = await read('differences', differenceCount);
    data.snapshots = await Promise.all(data.snapshots.map(async (snapshot, index) => ({ ...snapshot,
      items: await read<ReconcilePreview['snapshots'][number]['items'][number]>(`snapshot:${index}`, snapshotSizes[index]!) })));
    return data as unknown as T;
  });
}

/** Routine status reads transfer one display page, never source snapshots or retained previews. */
export async function readReconcilePage(db: SourceDatabase, key: string, offset = 0): Promise<ReconcilePreview | undefined> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % RECONCILE_PAGE_SIZE) throw new Error('invalid');
  const header = await db.read<ReconcilePreview | Paged<ReconcilePreview>>('meta', key); if (!header) return undefined;
  if (!('storage' in header) || header.visibleCount === undefined) {
    const full = await readReconcileData<ReconcilePreview>(db, key); if (!full) return undefined;
    const rows = full.differences.filter(d => d.kind !== 'present'), counts: NonNullable<ReconcilePreview['page']>['counts'] = {};
    for (const d of full.differences) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    return { ...full, snapshots: full.snapshots.map(s => ({ ...s, items: [] })), differences: rows.slice(offset, offset + RECONCILE_PAGE_SIZE),
      page: { offset, next: offset + RECONCILE_PAGE_SIZE < rows.length ? offset + RECONCILE_PAGE_SIZE : null, total: rows.length, counts } };
  }
  const { storage: _storage, differenceCount: _differenceCount, snapshotSizes: _snapshotSizes, visibleCount, counts, ...preview } = header;
  const differences = offset < visibleCount ? await db.read<ReconcilePreview['differences']>('meta', partKey(key, 'visible', offset / RECONCILE_PAGE_SIZE)) : [];
  if (!differences) throw new Error('reconcilePreviewIncomplete');
  return { ...preview, differences, page: { offset, next: offset + RECONCILE_PAGE_SIZE < visibleCount ? offset + RECONCILE_PAGE_SIZE : null, total: visibleCount, counts } };
}
