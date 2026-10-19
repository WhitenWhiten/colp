import type { SyncPullEventV02 } from '@know-n/colp/types';
import { digest } from './pull-codec.js';
import { currentPullMapping } from './pull-mapping-view.js';
import type { PullApplierOptions } from './pull-applier-types.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;
type Store = Pick<ReturnType<typeof createSyncStateStore>, 'listBookmarkEvents' | 'getQueueByOpId' | 'getMappingByColpId'>;

/** Member IDs a subtree removal records; a larger folder keeps only its root, so deeper members fall back to repair. */
export const LOCAL_DELETE_MEMBER_ID_BOUND = 2_000;

/**
 * A change from another device to a node this browser deleted. The user's
 * deletion dominates (03 §10.2): the node is gone here and the deletion is on
 * its way to the server, so nothing is applied and nothing is set aside.
 *
 * Holds only while every node the event needs (its target, or the folder it
 * places into) is unmapped and named by a removal this browser still stands
 * behind: a pending removal, or a delete in the lane, held, or applied.
 * A delete the server refused for good is not authority; that node then
 * stays a set-aside item, as before. A move out of a deleted folder keeps
 * its item too, so the rescued bookmark is not silently lost here.
 */
export async function supersededByLocalDelete(store: Store, scope: SyncScope, event: OpEvent): Promise<boolean> {
  const needs = neededSubjects(event);
  if (needs.length === 0) return false;
  let deleted: LocallyDeleted | undefined;
  for (const id of needs) {
    // A flushed removal already dropped the mapping; a pending one still names the browser node.
    const mapping = await store.getMappingByColpId(scope, id);
    deleted ??= await locallyDeleted(store, scope);
    if (mapping ? !deleted.nativeIds.has(mapping.nativeId) : !deleted.colpIds.has(id)) return false;
  }
  return true;
}

export interface LocallyDeleted { readonly colpIds: ReadonlySet<string>; readonly nativeIds: ReadonlySet<string> }

function neededSubjects(event: OpEvent): string[] {
  const effect = event.effect;
  if (effect.kind === 'node_content_updated') return [effect.node.id];
  if (effect.kind === 'node_created') return [effect.placement.parentId];
  if (effect.kind === 'node_moved') return [effect.node.id, effect.placement.parentId];
  if (effect.kind === 'node_deleted') return [effect.tombstone.targetId];
  if (effect.kind === 'subtree_deleted') return [effect.rootTombstone.targetId];
  return [];
}

/** Nodes this browser removed and still means to see deleted: delete roots, recorded subtree members and their browser ids. */
export async function locallyDeleted(store: Store, scope: SyncScope): Promise<LocallyDeleted> {
  const colpIds = new Set<string>(); const nativeIds = new Set<string>();
  let after = 0;
  for (;;) {
    const page = await store.listBookmarkEvents(scope, after, 1_000);
    for (const event of page) {
      if (event.kind !== 'remove' || !await removalStandsLocally(store, scope, event)) continue;
      const details = event.details;
      const draft = details.draft ?? details.operation;
      const targetId = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft.targetId : undefined;
      if (typeof targetId === 'string') colpIds.add(targetId);
      if (Array.isArray(details.subtreeMemberIds)) {
        for (const id of details.subtreeMemberIds) if (typeof id === 'string') colpIds.add(id);
      }
      // Only the browser nodes the delete claims; the removed root alone proves nothing about a mapping.
      if (Array.isArray(details.deleteNativeIds)) {
        for (const id of details.deleteNativeIds) if (typeof id === 'string') nativeIds.add(id);
      }
    }
    if (page.length < 1_000) return { colpIds, nativeIds };
    after = page[page.length - 1]!.ordinal;
  }
}

export async function locallyDeletedColpIds(store: Store, scope: SyncScope): Promise<Set<string>> {
  return new Set((await locallyDeleted(store, scope)).colpIds);
}

async function removalStandsLocally(store: Store, scope: SyncScope,
  event: { readonly status: string; readonly opId?: string | null }): Promise<boolean> {
  if (event.status === 'pending') return true;
  if (event.status !== 'processed' || !event.opId) return false;
  const row = await store.getQueueByOpId(scope, event.opId);
  if (!row) return false;
  if (row.status === 'rejected') return row.recovery?.code === 'recaptured';
  return !(row.status === 'terminal' && row.recovery?.resultStatus === 'rejected');
}

/** Settles the event as taken in without a browser change; parent children revisions still advance. */
export async function commitSupersededByLocalDelete(options: PullApplierOptions, eventId: string, event: OpEvent,
  now: number): Promise<boolean> {
  if (!await supersededByLocalDelete(options.store, options.scope, event)) return false;
  const current = await options.store.getPullEvent(options.scope, eventId);
  if (!current || !['staged', 'intent_prepared'].includes(String(current.state))) return false;
  if (current.state === 'staged') {
    options.crash?.('before_intent');
    await options.store.preparePullIntent(options.scope, eventId, {
      intentId: `intent:${eventId}`, correlationId: digest({ eventId, recovery: 'local_removal' }),
      operationId: event.operation.opId, eventId, effectId: event.effect.effectId,
      expected: { kind: 'sidecar', nativeId: `removed:${event.operation.opId}` },
      expiresAt: now + 300_000, generation: options.scope.generation,
    });
  }
  options.crash?.('after_intent');
  await options.store.markPullBrowserCallStarted(options.scope, eventId);
  await options.store.recordPullApiEvidence(options.scope, eventId, { operationId: event.operation.opId, recovery: 'local_removal' });
  await options.store.commitPullEvent(options.scope, eventId, { mappings: await parentRevisionMappings(options, event),
    apiResultEvidence: { operationId: event.operation.opId, recovery: 'local_removal' } });
  return true;
}

async function parentRevisionMappings(options: PullApplierOptions, event: OpEvent): Promise<MappingInput[]> {
  const effect = event.effect;
  const revisions = effect.kind === 'node_moved' ? effect.parentRevisions
    : effect.kind === 'node_content_updated' ? [] : [effect.parentRevision];
  const mappings: MappingInput[] = [];
  for (const revision of revisions) {
    const parent = await currentPullMapping(options.store, options.scope, revision.parentId);
    if (!parent) continue;
    const { scopeKey: _scopeKey, ...mapping } = parent as MappingInput & { readonly scopeKey?: string };
    mappings.push({ ...mapping, projection: { ...parent.projection, childrenRevision: revision.childrenRevision } });
  }
  return mappings;
}
