import { createBookmarkEventQueue } from './bookmark-event-queue.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import type { RejoinChrome, RejoinNative } from './scope-rejoin-mutation.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Input = RejoinChrome & {
  store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; mount: MountBindingRecord;
};

/** Capture missing destination ancestors before comparing the paused members. */
export async function captureRejoinParents(input: Input, mappings: readonly MappingInput[]): Promise<void> {
  if (!input.getChildren) return;
  const mapped = new Set(mappings.map(row => row.nativeId));
  const captured = new Set<string>();
  for (let after = 0;;) {
    const events = await input.store.listBookmarkEventsByStatus(input.scope, 'pending', after, 1_000);
    for (const event of events) if (event.kind === 'create') captured.add(event.nativeId);
    if (events.length < 1_000) break;
    after = events.at(-1)!.ordinal;
  }
  const queue = createBookmarkEventQueue({ store: input.store, scope: input.scope, autoFlush: false,
    api: {
      get: async id => {
        const native = await input.getNative(id);
        if (!native) throw new Error(`Can't find bookmark for id. ${id}`);
        return [{ ...native, id, title: native.title ?? '' }];
      },
      getChildren: async id => (await input.getChildren!(id)).map(node => ({ ...node, title: node.title ?? '' })),
    } });
  for (const mapping of mappings) {
    if (isNonChromeNativeId(mapping.nativeId) || mapping.nativeId === input.mount.nativeRootId) continue;
    const live = await input.getNative(mapping.nativeId);
    if (!live?.parentId || live.parentId === mapping.parentNativeId) continue;
    let parentId: string | undefined = live.parentId;
    const chain: Array<{ id: string; native: RejoinNative }> = [];
    const seen = new Set<string>();
    while (parentId && !mapped.has(parentId) && !captured.has(parentId)) {
      if (seen.has(parentId) || seen.size >= 256) { parentId = undefined; break; }
      seen.add(parentId);
      const native = await input.getNative(parentId);
      if (!native || native.url !== undefined || native.type === 'separator') { parentId = undefined; break; }
      chain.push({ id: parentId, native });
      parentId = native.parentId;
    }
    if (!parentId) continue;
    for (const { id, native } of chain.reverse()) {
      if (captured.has(id)) continue;
      const result = await queue.created(id, { ...native, id, title: native.title ?? '', type: 'folder' });
      if (result.outcome !== 'staged' && result.outcome !== 'duplicate') break;
      captured.add(id);
    }
  }
  await queue.flush();
}
