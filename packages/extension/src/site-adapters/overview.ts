import type { Representation, SourceFolderReservation, SiteCollection } from './contracts.js';
import type { SourceMount } from './layout.js';
import { get, rows, sourceKey, sourcePrefixRange, type SourceDatabase } from './source-db.js';

export interface CollectionOverview {
  id: string; title: string; destinationId: string | null; destinationTitle: string;
  destinationParentId?: string; destinationParentTitle?: string;
  preservedLocation?: { folders: number; firstId?: string; firstTitle?: string };
  folder: 'pending' | 'ready' | 'missing' | 'review'; saved: number; changed: number; keptDeleted: number;
}
export interface SourceOverview { checkedAt: number; saved: number; collections: CollectionOverview[]; checkpoint?: { id: string; saved: number }; pendingWrites?: boolean }
export interface OverviewConfig { connectionId: string; ruleId: string; root: { nativeId: string }; collectionIds: readonly string[] }

/** Counts committed associations in the current mapping, never drafts, discovered items or unrelated bookmarks. */
export function createSourceOverview(db: SourceDatabase, lookup: (id: string) => Promise<{ title: string; dateAdded?: number; url?: string; parentId?: string } | null>, now = Date.now) {
  let cached: { key: string; expiresAt: number; result: SourceOverview } | undefined;
  return async (config: OverviewConfig, checkpoint?: { id: string; saved: number; finished: boolean }): Promise<SourceOverview> => {
    const cacheKey = JSON.stringify([config, checkpoint?.finished ? checkpoint.id : null]);
    if (cached?.key === cacheKey && cached.expiresAt > now()) return { ...cached.result,
      pendingWrites: !!checkpoint && checkpoint.saved > (cached.result.checkpoint?.id === checkpoint.id ? cached.result.checkpoint.saved : 0) };
    const result = await db.transaction(['mounts', 'collections', 'representations', 'folderReservations'], 'readonly', async tx => {
      const mount = await get<SourceMount>(tx, 'mounts', sourceKey(config.connectionId, config.ruleId));
      const folders = mount ? await rows<SourceFolderReservation>(tx, 'folderReservations', mount.id) : [];
      const collections: CollectionOverview[] = [];
      for (const id of config.collectionIds) {
        const fact = await get<{ entity: SiteCollection }>(tx, 'collections', sourceKey(config.connectionId, id)), folder = folders.find(f => f.collectionId === id);
        collections.push({ id, title: fact?.entity.title ?? folder?.title ?? '', destinationId: folder?.native?.nativeId ?? null,
          destinationTitle: folder?.nativeTitle ?? folder?.title ?? fact?.entity.title ?? '', folder: !folder ? 'pending'
            : folder.state === 'confirmed' && folder.native ? 'ready' : ['unknown', 'blocked'].includes(folder.state) ? 'review' : 'pending',
          saved: 0, changed: 0, keptDeleted: 0 });
      }
      const byId = new Map(collections.map(c => [c.id, c])), saved = new Set<string>();
      const seen = new Map(collections.map(c => [c.id, new Set<string>()]));
      const active = new Map(collections.map(c => [c.id, new Set<string>()]));
      const parents = new Map(collections.map(c => [c.id, new Map<string, Set<string>>() ]));
      await new Promise<void>((resolve, reject) => {
        const request = tx.objectStore('representations').openCursor(sourcePrefixRange(config.connectionId)); let count = 0;
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) { resolve(); return; }
          if (++count > 100000) { reject(new Error('capacity')); return; }
          const rep = cursor.value as Representation, row = rep.sourceCollectionId && byId.get(rep.sourceCollectionId);
          if (row && rep.purpose === 'sourceArchive' && rep.mountId === mount?.id && !seen.get(row.id)!.has(rep.native.nativeId)) {
            seen.get(row.id)!.add(rep.native.nativeId);
            if (rep.state === 'active') {
              row.saved++; saved.add(rep.native.nativeId); active.get(row.id)!.add(rep.native.nativeId);
              const parent = rep.lastWritten?.parentId ?? folders.find(f => f.collectionId === row.id)?.native?.nativeId ?? '';
              const group = parents.get(row.id)!.get(parent) ?? new Set<string>(); group.add(rep.native.nativeId); parents.get(row.id)!.set(parent, group);
            }
            else if (rep.state === 'suppressed') row.keptDeleted++; else row.changed++;
          }
          cursor.continue();
        };
      });
      return { collections, saved: saved.size, folders, active, parents };
    });
    for (const row of result.collections) if (row.destinationId && row.folder === 'ready') {
      const folder = result.folders.find(f => f.collectionId === row.id)!;
      const actual = await lookup(row.destinationId);
      if (!actual || actual.url !== undefined || actual.dateAdded !== folder.native?.dateAdded) {
        const missingId = row.destinationId, removed = result.parents.get(row.id)!.get(missingId) ?? new Set<string>();
        row.folder = 'missing'; row.destinationId = null; row.changed += removed.size; row.saved -= removed.size;
        for (const id of removed) result.active.get(row.id)!.delete(id);
        result.parents.get(row.id)!.delete(missingId);
      } else {
        row.destinationTitle = actual.title; row.destinationParentId = actual.parentId;
        const expectedParent = folder.locationOverride?.nativeId ?? (folder.parent?.kind === 'native' ? folder.parent.binding.nativeId : config.root.nativeId);
        if (actual.parentId && actual.parentId !== expectedParent) row.folder = 'review';
        if (actual.parentId && actual.parentId !== config.root.nativeId) row.destinationParentTitle = (await lookup(actual.parentId))?.title;
      }
    }
    for (const row of result.collections) {
      const parents = [...result.parents.get(row.id)!.keys()].filter(Boolean);
      if (row.saved && (!row.destinationId || parents.some(id => id !== row.destinationId))) {
        const firstId = parents.length === 1 ? parents[0] : undefined;
        row.preservedLocation = { folders: parents.length, firstId, firstTitle: firstId ? (await lookup(firstId))?.title : undefined };
      }
    }
    // Missing folders cannot count as confirmed destinations; associations remain available for review.
    const confirmed = new Set(result.collections.flatMap(c => [...result.active.get(c.id)!]));
    const view: SourceOverview = { checkedAt: now(), saved: confirmed.size, collections: result.collections,
      ...(checkpoint ? { checkpoint: { id: checkpoint.id, saved: checkpoint.saved } } : {}) };
    cached = { key: cacheKey, expiresAt: now() + 2500, result: view }; return view;
  };
}
