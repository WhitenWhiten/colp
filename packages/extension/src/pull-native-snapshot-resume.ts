import { applyRemoteMappingContentUpdate } from './pull-native-content-barrier.js';
import { applySnapshotPlacement } from './recovery-placement.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { pendingLocalContentForEvent } from './pull-queue-facts.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { PullApplierOptions, PullBookmarkApi } from './pull-applier-types.js';
import type { MappingInput } from './sync-state-store.js';

/** Confirmation resumes the original create, but a later Snapshot owns the
 * current baseline. Its native updates use the ordinary local-edit barriers;
 * an interruption resumes by verifying post-state, never recreating the node. */
export async function resumeSnapshotDeferredCreate(options: PullApplierOptions, api: PullBookmarkApi,
  eventId: string, event: Extract<SyncPullEventV02, { kind: 'operation' }>, original: MappingInput) {
  const record = await options.store.getPullEvent(options.scope, eventId);
  const page = (await options.store.listPullPages(options.scope, ['page_complete'])).find(page => page.pageId === record?.pageId);
  const current = page?.snapshotAccountedBy ? await options.store.getMappingByColpId(options.scope, original.colpId) : undefined;
  if (!current || current.nativeId !== original.nativeId) return { mapping: original };
  const { scopeKey: _scopeKey, ...latest } = current;
  const parent = latest.parentColpId ? await options.store.getMappingByColpId(options.scope, latest.parentColpId) : undefined;
  const incoming = { ...latest, ...(parent ? { parentNativeId: parent.nativeId, rootNativeId: parent.rootNativeId } : {}) };
  if (incoming.parentNativeId !== original.parentNativeId && incoming.parentColpId) {
    await options.assertCurrent?.();
    await applySnapshotPlacement({ store: options.store, scope: options.scope, api, incoming,
      intent: { intentId: `confirmed-snapshot:${eventId}`, colpId: incoming.colpId, kind: 'move', order: 0,
        suppression: eventId, parentColpId: incoming.parentColpId, parentNativeId: incoming.parentNativeId } });
  }
  await options.assertCurrent?.();
  return applyRemoteMappingContentUpdate({ store: options.store, scope: options.scope, api,
    mapping: { ...original, parentNativeId: incoming.parentNativeId, parentColpId: incoming.parentColpId },
    incomingMapping: incoming, effectDigest: event.effect.effectDigest, eventId,
    mounts: await options.store.listMountBindings(options.scope), now: options.now ?? Date.now,
    lookup: id => lookupBookmark(key => api.get(key), id),
    targetMissingError: async () => new SyncFailureError('snapshot_content_target_missing'),
    queuedLocal: await pendingLocalContentForEvent(options.store, options.scope, original, event),
    observationCursor: (await options.store.getCursor(options.scope))?.cursor });
}
