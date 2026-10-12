import { plannedCreateNativeId } from '../bookmark-event-codec.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from '../sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getScope' | 'getMappingByColpId' | 'listMountBindings'
  | 'listBootstrapRuns' | 'getScopePreview' | 'getLocalSyncExclusion'>;

export class BootstrapUploadExcludedError extends Error {
  readonly code = 'bootstrap_upload_excluded';
  constructor(readonly reason: 'private_local' | 'unselected_range') { super('bootstrap_upload_excluded'); }
}

/** Old queued bootstrap work must obey today's privacy and selected range. */
export async function assertBootstrapUploadAllowed(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly parentOf: (nativeId: string) => Promise<string | undefined>;
}): Promise<void> {
  const nativeId = input.queue.opId.startsWith('b3.') ? plannedCreateNativeId(input.queue.opId) : undefined;
  if (!nativeId) return;
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
    id = await input.parentOf(id);
  }
  if (!inRange) throw new BootstrapUploadExcludedError('unselected_range');
}
