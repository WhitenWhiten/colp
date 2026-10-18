import { lookupBookmark, type BookmarkNode } from './bookmark-api-error.js';
import { BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX, parseBookmarkCreatePlacementRecord } from './bookmark-create-placement.js';
import type { StorageArea } from './credential-store.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Repair the old local-only-save false freeze, without resetting the replica. */
export async function recoverLocalSaveFreeze(input: {
  readonly scope: SyncScope;
  readonly store: Pick<ReturnType<typeof createSyncStateStore>,
    'getEngineState' | 'getLocalPlacementRecovery' | 'resumeLocalPlacementRecovery'>;
  readonly storage: StorageArea;
  readonly api: { get(id: string): Promise<readonly BookmarkNode[]> };
  readonly assertCurrent: () => Promise<void>;
  readonly now?: () => number;
}): Promise<boolean> {
  const engine = await input.store.getEngineState(input.scope);
  if (!engine?.recoveryFrozen || engine.lastError !== 'recovery_identity_unproven') return false;
  await input.assertCurrent();
  const proof = await input.store.getLocalPlacementRecovery(input.scope);
  if (!proof) return false;
  const values = await input.storage.get(null);
  const matches = Object.entries(values).flatMap(([key, value]) => {
    const record = key.startsWith(BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX) ? parseBookmarkCreatePlacementRecord(value) : undefined;
    return record?.nativeId === proof.nativeId ? [{ key, record }] : [];
  });
  if (matches.length !== 1) return false;
  const { key, record } = matches[0]!;
  if (record.collectionId !== undefined || !['bound', 'attention'].includes(record.state)) return false;
  const target = await lookupBookmark(id => input.api.get(id), proof.nativeId);
  if (target.class !== 'present' || !target.nodes.some(node => node.id === proof.nativeId
      && node.title === record.title && node.url === record.url)) return false;
  // Re-run the same existence proof that a genuine identity freeze requires.
  // Failed reads and virtual placeholders never count as proven native nodes.
  const ids = [...new Set(proof.mappings.map(row => row.nativeId).filter(id => !virtualNativeId(id)))];
  let next = 0; let verified = true;
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
    while (verified && next < ids.length) {
      const id = ids[next++]!;
      const result = await lookupBookmark(value => input.api.get(value), id);
      if (result.class !== 'present' || !result.nodes.some(node => node.id === id)) verified = false;
    }
  }));
  if (!verified) return false;
  await input.assertCurrent();
  // Restore only the exact local receipt wrongly marked attention. Do this
  // first: a crash leaves the replica frozen and the same recovery reentrant.
  const latest = (await input.storage.get(key))[key];
  if (JSON.stringify(latest) !== JSON.stringify(values[key])) return false;
  if (record.state === 'attention') await input.storage.set({ [key]: { ...record, state: 'bound' } });
  await input.assertCurrent();
  return input.store.resumeLocalPlacementRecovery(input.scope, { engineRevision: proof.engine.revision,
    nativeId: proof.nativeId, mappingDigest: proof.mappingDigest, now: (input.now ?? Date.now)() });
}
