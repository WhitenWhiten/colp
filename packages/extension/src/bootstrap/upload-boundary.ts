import { plannedCreateNativeId } from '../bookmark-event-codec.js';
import { classifyBookmarkApiFailure } from '../bookmark-api-error.js';
import { localRemovalCoversNative } from '../local-create-successor.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from '../sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'getMappingByColpId' | 'listMountBindings'
  | 'listBootstrapRuns' | 'getScopePreview' | 'getLocalSyncExclusion' | 'getMappingByNativeId'
  | 'listBookmarkEventsByStatus' | 'listDeletionJournal'>;

export class BootstrapUploadExcludedError extends Error {
  readonly code = 'bootstrap_upload_excluded';
  constructor(readonly reason: 'private_local' | 'unselected_range') { super('bootstrap_upload_excluded'); }
}

/** Old queued bootstrap work must obey today's privacy and selected range. */
export async function assertBootstrapUploadAllowed(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly parentOf: (nativeId: string) => Promise<string | undefined>;
}): Promise<void> {
  const nativeId = input.queue.opId.startsWith('b3.') ? plannedCreateNativeId(input.queue.opId)
    ?? (typeof input.queue.payload.targetId === 'string' ? (await input.store.getMappingByColpId(input.scope, input.queue.payload.targetId))?.nativeId : undefined) : undefined;
  if (!nativeId) {
    if (input.queue.opId.startsWith('b3.') && input.queue.payload.type !== 'create_node') throw new Error('bootstrap_boundary_unavailable');
    return;
  }
  const { store, scope } = input;
  const [recorded, mounts, runs] = await Promise.all([
    store.getScope(scope), store.listMountBindings(scope), store.listBootstrapRuns(scope),
  ]);
  const privateMappings = await Promise.all((recorded?.privateRoots ?? []).map(id => store.getMappingByColpId(scope, id)));
  if (privateMappings.some(row => !row)) throw new Error('bootstrap_boundary_unavailable');
  const privateIds = new Set(privateMappings.flatMap(row => row ? [row.nativeId] : []));
  const latest = [...runs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const preview = latest?.previewId ? await store.getScopePreview(scope, latest.previewId) : null;
  const excluded = new Set(preview?.boundary.excludedNativeIds ?? []);
  const selected = new Set(mounts.filter(mount => mount.status !== 'detached').map(mount => mount.nativeRootId));
  let id: string | undefined = nativeId; const seen = new Set<string>(); let inRange = false;
  while (id && !seen.has(id)) {
    seen.add(id);
    if (privateIds.has(id) || await store.getLocalSyncExclusion(scope, id)) throw new BootstrapUploadExcludedError('private_local');
    if (excluded.has(id)) throw new BootstrapUploadExcludedError('unselected_range');
    if (selected.has(id)) inRange = true;
    const currentId = id;
    try { id = await input.parentOf(currentId); }
    catch (error) {
      if (classifyBookmarkApiFailure(error) !== 'not_found') throw error;
      const parent = await removedNativeParent(store, scope, currentId, input.queue.opId);
      if (!parent) throw error;
      id = parent;
    }
  }
  if (!inRange && input.queue.payload.type === 'create_node') {
    const inner = input.queue.payload.payload as { node?: { kind?: unknown } };
    // Coverage never expands to an ancestor's siblings. Only its folder container may upload.
    if (inner?.node?.kind === 'folder') for (const covered of selected) {
      let ancestor: string | undefined = covered; const visited = new Set<string>();
      for (let depth = 0; ancestor && depth < 256 && !visited.has(ancestor); depth++) {
        if (ancestor === nativeId) { inRange = true; break; }
        visited.add(ancestor); ancestor = await input.parentOf(ancestor);
      }
    }
  }
  if (!inRange) throw new BootstrapUploadExcludedError('unselected_range');
}

async function removedNativeParent(store: Store, scope: SyncScope, nativeId: string, createOpId: string) {
  const mapping = await store.getMappingByNativeId(scope, nativeId);
  let after = 0;
  for (;;) {
    const events = await store.listBookmarkEventsByStatus(scope, 'pending', after, 1000);
    const removal = events.find(event => localRemovalCoversNative(event, nativeId, mapping?.colpId ?? `pending-${createOpId}`, createOpId));
    if (removal) {
      return [...await store.listDeletionJournal(scope, nativeId)].sort((a, b) => b.ordinal - a.ordinal)[0]?.parentNativeId
        ?? (removal.nativeId !== nativeId ? mapping?.parentNativeId : undefined);
    }
    if (events.length < 1000) return undefined;
    after = events.at(-1)!.ordinal;
  }
}
