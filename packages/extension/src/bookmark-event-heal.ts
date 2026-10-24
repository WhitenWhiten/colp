import { asObject, asStringArray, digestJson } from './bookmark-event-codec.js';
import { resolveObservedBase } from './bookmark-observed-base.js';
import { identityFromPendingCreate } from './bookmark-create-receipt-identity.js';
import { resolveSubtreePredecessors } from './bookmark-subtree-predecessors.js';
import { materializeNativeMutation } from './bookmark-native-mutation.js';
import { projectPendingBookmarkEvent } from './bookmark-event-projection.js';
import type { BookmarkEventParkMarker } from './sync-state/types.js';
import type { BookmarkEventRecord, JsonObject, MappingInput, MountBindingRecord, QueueOperation,
  SyncScope } from './sync-state-store.js';

/**
 * F003: `flush()` needs to know *why* a pending inbox event cannot be staged,
 * not just that it cannot. This module owns the trusted-identity resolution and
 * the operation preparation extracted from the bookmark event queue, and
 * reports the blocking dependency so the queue can hold, quarantine and later
 * revive the event on real convergence evidence.
 */
export interface HealStore {
  listQueue: ReturnType<typeof import('./sync-state-store.js').createSyncStateStore>['listQueue'];
  getRemoteObservation: ReturnType<typeof import('./sync-state-store.js').createSyncStateStore>['getRemoteObservation'];
  getMappingByNativeId(scope: SyncScope, nativeId: string): Promise<MappingInput | null>;
  getMappingByColpId(scope: SyncScope, colpId: string): Promise<MappingInput | null>;
  listMountBindings(scope: SyncScope): Promise<readonly MountBindingRecord[]>;
  getQueueByOpId(scope: SyncScope, opId: string): Promise<QueueOperation | null>;
  getBookmarkEvent(scope: SyncScope, eventId: string): Promise<BookmarkEventRecord | null>;
  getQueueReceipt: ReturnType<typeof import('./sync-state-store.js').createSyncStateStore>['getQueueReceipt'];
}
export type BlockReason = 'dependency_missing' | 'dependency_pending' | 'children_fence_missing'
  | 'content_unavailable';
export interface EventDependency {
  readonly nativeId: string; readonly opId?: string; readonly eventId?: string }
export type PrepareOutcome =
  | { readonly kind: 'ready'; readonly operation: JsonObject; readonly mapping?: MappingInput;
    readonly deleteNativeIds: readonly string[] }
  | { readonly kind: 'blocked'; readonly reason: BlockReason; readonly dependency: EventDependency };
export interface EventIdentity { readonly nativeId: string; readonly colpId: string; readonly rootNativeId: string;
  readonly revision: string; readonly childrenRevision?: string; readonly childrenOrder?: readonly string[]; readonly content: JsonObject | null;
  readonly nodeKind?: MappingInput['nodeKind'];
  readonly parentNativeId?: string }
type LocalIdentity = EventIdentity;
type Resolution = { readonly identity: LocalIdentity } | { readonly blocked: EventDependency };
type ParkMarkers = ReadonlyMap<string, BookmarkEventParkMarker>;

export function createBookmarkEventHealer(input: {
  readonly scope: SyncScope; readonly store: HealStore;
  readonly listPendingEvents: () => Promise<readonly BookmarkEventRecord[]>;
}) {
  async function prepare(event: BookmarkEventRecord, details: JsonObject,
    markers: ParkMarkers): Promise<PrepareOutcome> {
    if (details.nativeMutation === true) {
      const identity = await seedIdentity(event.nativeId);
      if (!identity) return blockedOutcome({ nativeId: event.nativeId });
      details = materializeNativeMutation(event, identity);
    }
    const template = asObject(details.draft, 'draft');
    const type = String(template.type);
    const context = details.context === undefined ? {} : asObject(details.context, 'context');
    const deleteNativeIds = details.deleteNativeIds === undefined ? []
      : asStringArray(details.deleteNativeIds, 'deleteNativeIds');
    if (type === 'create_node') {
      const parentNativeId = String(context.parentNativeId ?? '');
      const parent = await trusted(parentNativeId, event.ordinal);
      if ('blocked' in parent) return blockedOutcome(parent.blocked);
      const relative = await trustedRelative(context, event.ordinal, markers);
      if ('blocked' in relative) return blockedOutcome(relative.blocked);
      const original = details.mapping as unknown as MappingInput;
      const payload = { ...asObject(template.payload, 'payload') };
      if (typeof context.afterNativeId === 'string' || typeof context.beforeNativeId === 'string') {
        delete payload.afterId; delete payload.beforeId;
      }
      return { kind: 'ready', operation: { ...template, baseRevision: null, dependencies: [], payload: {
        ...payload, parentId: parent.identity.colpId, ...relative.wire } },
      mapping: original, deleteNativeIds };
    }
    const identity = await trusted(event.nativeId, event.ordinal);
    if ('blocked' in identity) return blockedOutcome(identity.blocked);
    const observedRevision = type === 'move_node' && template.baseRevision === undefined ? identity.identity.revision
      : type === 'update_node_content' || type === 'move_node' || type === 'delete_node' || type === 'delete_subtree'
      ? await resolveObservedBase(input.store, input.scope, template, identity.identity.colpId) : null;
    if ((type === 'update_node_content' || type === 'move_node' || type === 'delete_node' || type === 'delete_subtree')
        && observedRevision === null) return { kind: 'blocked', reason: 'content_unavailable',
      dependency: { nativeId: event.nativeId } };
    if (type === 'update_node_content') {
      if (!identity.identity.content) {
        return { kind: 'blocked', reason: 'content_unavailable',
          dependency: { nativeId: event.nativeId } };
      }
      const payload = asObject(template.payload, 'payload');
      const value = asObject(payload.value, 'value');
      const base = asObject(payload.base, 'base');
      const nextContent = { ...identity.identity.content, ...value };
      return { kind: 'ready', operation: { ...template, targetId: identity.identity.colpId,
        baseRevision: observedRevision!, dependencies: [], payload: { base, value } },
      mapping: mappingAfter(identity.identity, event, nextContent), deleteNativeIds };
    }
    if (type === 'move_node') {
      const source = await trusted(String(context.sourceParentNativeId ?? ''), event.ordinal);
      if ('blocked' in source) return blockedOutcome(source.blocked);
      const target = await trusted(String(context.targetParentNativeId ?? ''), event.ordinal);
      if ('blocked' in target) return blockedOutcome(target.blocked);
      const relative = await trustedRelative(context, event.ordinal, markers);
      if ('blocked' in relative) return blockedOutcome(relative.blocked);
      if (!source.identity.childrenRevision) {
        return { kind: 'blocked', reason: 'children_fence_missing',
          dependency: { nativeId: source.identity.nativeId } };
      }
      if (!target.identity.childrenRevision) {
        return { kind: 'blocked', reason: 'children_fence_missing',
          dependency: { nativeId: target.identity.nativeId } };
      }
      const durableParent = identity.identity.parentNativeId;
      const sourceParent = typeof context.sourceParentNativeId === 'string'
        ? context.sourceParentNativeId : undefined;
      const preserveRemotePlacement = details.snapshotPlacementBarrier === true
        || sourceParent !== undefined && durableParent !== undefined && sourceParent !== durableParent;
      return { kind: 'ready', operation: { ...template, targetId: identity.identity.colpId,
        baseRevision: observedRevision!,
        dependencies: [], payload: { newParentId: target.identity.colpId,
          ...relative.wire, baseSourceParentRevision: source.identity.childrenRevision,
          baseTargetParentRevision: target.identity.childrenRevision } },
        ...(!preserveRemotePlacement ? {
          mapping: { ...mappingAfter(identity.identity, event, identity.identity.content),
            rootNativeId: target.identity.rootNativeId, parentNativeId: target.identity.nativeId },
        } : {}), deleteNativeIds };
    }
    if (type === 'delete_node' || type === 'delete_subtree') {
      const resolved = type === 'delete_subtree' && Array.isArray(details.subtreeObservation)
        ? await resolveSubtreePredecessors(input.store, input.scope, identity.identity.colpId,
          details.subtreeObservation as JsonObject[]) : undefined;
      if (resolved && 'blocked' in resolved) return blockedOutcome(resolved.blocked);
      return { kind: 'ready', operation: { ...template,
        ...(resolved ? { source: resolved.source as unknown as JsonObject } : {}),
        targetId: identity.identity.colpId, baseRevision: observedRevision!, dependencies: [] }, deleteNativeIds };
    }
    throw new Error('operation_schema_invalid');
  }

  /**
   * Resolve a mapping identity that is safe to author operations from. A
   * `pending-*` collection id or a `local-*` revision means the identity is
   * still optimistic; the returned dependency names the queue row or inbox
   * event that must converge first.
   */
  async function trusted(nativeId: string, beforeOrdinal: number): Promise<Resolution> {
    let identity = await seedIdentity(nativeId);
    for (const prior of await input.listPendingEvents()) {
      if (prior.ordinal >= beforeOrdinal || prior.status !== 'pending' || prior.nativeId !== nativeId) continue;
      identity = projectPendingBookmarkEvent(identity, prior);
    }
    if (!identity) return { blocked: { nativeId } };
    if (identity.colpId.startsWith('pending-')) return { blocked: await pendingDependency(nativeId,
      identity.colpId.slice('pending-'.length)) };
    if (identity.revision.startsWith('local-')) return { blocked: await pendingDependency(nativeId,
      identity.revision.slice('local-'.length)) };
    return { identity };
  }

  /**
   * The latest optimistic identity for a native: durable mapping plus every
   * pending inbox event's projection, in ordinal order. Used at capture time,
   * where a locally staged edit is the working identity even before a receipt.
   */
  async function identityFor(nativeId: string,
    eventsSnapshot?: readonly BookmarkEventRecord[]): Promise<EventIdentity | null> {
    let identity = await seedIdentity(nativeId);
    const events = eventsSnapshot ?? await input.listPendingEvents();
    for (const event of events) {
      if (event.status !== 'pending') continue;
      if (event.nativeId !== nativeId) continue;
      identity = projectPendingBookmarkEvent(identity, event);
    }
    return identity;
  }

  async function pendingDependency(nativeId: string, token: string): Promise<EventDependency> {
    const queued = await input.store.getQueueByOpId(input.scope, token);
    return queued ? { nativeId, opId: queued.opId } : { nativeId, eventId: token };
  }

  async function trustedRelative(context: JsonObject, beforeOrdinal: number, markers: ParkMarkers): Promise<
    { readonly wire: JsonObject } | { readonly blocked: EventDependency }> {
    for (const key of ['afterNativeId', 'beforeNativeId'] as const) {
      if (typeof context[key] !== 'string') continue;
      const anchor = await trusted(context[key], beforeOrdinal);
      // A neighbour held as an item will not settle soon: place by the other
      // neighbour, or by the folder alone, rather than wait for it.
      if ('blocked' in anchor && await anchorHeld(anchor.blocked, markers)) continue;
      if ('blocked' in anchor) return { blocked: anchor.blocked };
      return { wire: { [key === 'afterNativeId' ? 'afterId' : 'beforeId']: anchor.identity.colpId } };
    }
    return { wire: {} };
  }

  async function anchorHeld(dependency: EventDependency, markers: ParkMarkers): Promise<boolean> {
    if (dependency.eventId && markers.get(dependency.eventId)?.state === 'parked') return true;
    if (!dependency.opId) return false;
    const row = await input.store.getQueueByOpId(input.scope, dependency.opId);
    return row?.status === 'set_aside' || row?.status === 'rejected' || row?.recovery?.resultStatus === 'rejected';
  }

  /** Old quarantines may have an unchanged stamp but only need to omit a failed neighbour. */
  async function canOmitRelativeDependency(event: BookmarkEventRecord, dependency: EventDependency,
    markers: ParkMarkers): Promise<boolean> {
    const context = event.details.context as JsonObject | undefined;
    if (!context || dependency.nativeId === event.nativeId
        || [context.parentNativeId, context.sourceParentNativeId, context.targetParentNativeId]
          .includes(dependency.nativeId)) return false;
    return [context.afterNativeId, context.beforeNativeId].includes(dependency.nativeId)
      && await anchorHeld(dependency, markers);
  }

  /**
   * A stable digest of everything that can unlock the dependency: its durable
   * mapping identity and fences, its queue row state and its inbox event state.
   * A quarantine is reopened only when this digest changes, so a parked event
   * is never replayed in a tight loop.
   */
  async function dependencyStamp(dependency: EventDependency, parkState?: string): Promise<string> {
    const parts: string[] = [];
    const mapping = await input.store.getMappingByNativeId(input.scope, dependency.nativeId);
    parts.push(`m:${mapping ? `${mapping.colpId}|${mapping.projection.revision}|${mapping.projection.childrenRevision ?? '-'}` : 'none'}`);
    if (dependency.opId) {
      const queued = await input.store.getQueueByOpId(input.scope, dependency.opId);
      parts.push(`q:${queued?.status ?? 'none'}`);
    }
    if (dependency.eventId) {
      const event = await input.store.getBookmarkEvent(input.scope, dependency.eventId);
      parts.push(`e:${event?.status ?? 'none'}`);
    }
    if (parkState !== undefined) parts.push(`p:${parkState}`);
    return digestJson(parts.join(' '));
  }

  /** True when the blocking queue row is a permanently refused operation. */
  async function blockerIsRejected(dependency: EventDependency): Promise<boolean> {
    if (dependency.opId) {
      const queued = await input.store.getQueueByOpId(input.scope, dependency.opId);
      if ((queued?.status === 'rejected' || queued?.recovery?.resultStatus === 'rejected')) return true;
    }
    const mapping = await input.store.getMappingByNativeId(input.scope, dependency.nativeId);
    const token = mapping?.colpId.startsWith('pending-') ? mapping.colpId.slice('pending-'.length) : undefined;
    if (!token) return false;
    const queued = await input.store.getQueueByOpId(input.scope, token);
    return (queued?.status === 'rejected' || queued?.recovery?.resultStatus === 'rejected');
  }

  async function seedIdentity(nativeId: string): Promise<LocalIdentity | null> {
    const durable = await input.store.getMappingByNativeId(input.scope, nativeId);
    if (durable && (await input.store.getRemoteObservation(input.scope, durable.colpId))?.kind !== 'tombstone') {
      return { nativeId: durable.nativeId, colpId: durable.colpId, rootNativeId: durable.rootNativeId,
        revision: durable.projection.revision,
        ...(durable.projection.childrenRevision ? { childrenRevision: durable.projection.childrenRevision } : {}),
        ...(durable.projection.childrenOrder ? { childrenOrder: durable.projection.childrenOrder } : {}),
        content: durable.projection.content ?? null, ...(durable.nodeKind ? { nodeKind: durable.nodeKind } : {}),
        ...(durable.parentNativeId ? { parentNativeId: durable.parentNativeId } : {}) };
    }
    return await identityFromPendingCreate(input.store, input.scope, nativeId) ?? mountRootIdentity(nativeId);
  }

  async function mountRootIdentity(nativeId: string): Promise<LocalIdentity | null> {
    const mounts = await input.store.listMountBindings(input.scope);
    const mount = mounts.find((item) => item.nativeRootId === nativeId && item.status !== 'detached'
      && item.remoteMountNodeId && !item.remoteMountNodeId.startsWith('pending-')
      && !item.remoteMountNodeId.startsWith('local-'));
    if (!mount?.remoteMountNodeId) return null;
    const bound = await input.store.getMappingByColpId(input.scope, mount.remoteMountNodeId);
    const revision = bound && !bound.projection.revision.startsWith('local-') ? bound.projection.revision : 'bound';
    const childrenRevision = bound?.projection.childrenRevision
      && !String(bound.projection.childrenRevision).startsWith('local-')
      ? bound.projection.childrenRevision : undefined;
    return { nativeId, colpId: mount.remoteMountNodeId, rootNativeId: nativeId, revision, nodeKind: 'folder',
      ...(childrenRevision ? { childrenRevision } : {}), content: bound?.projection.content ?? null };
  }

  function blockedOutcome(dependency: EventDependency): PrepareOutcome {
    return { kind: 'blocked', reason: dependency.opId || dependency.eventId ? 'dependency_pending' : 'dependency_missing',
      dependency };
  }

  function mappingAfter(identity: LocalIdentity, event: BookmarkEventRecord, content: JsonObject | null): MappingInput {
    return { nativeId: identity.nativeId, colpId: identity.colpId, rootNativeId: identity.rootNativeId,
      ...(identity.nodeKind ? { nodeKind: identity.nodeKind } : {}),
      ...(identity.parentNativeId ? { parentNativeId: identity.parentNativeId } : {}),
      projection: { revision: `local-${event.eventId}`,
        ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
        ...(identity.childrenOrder ? { childrenOrder: [...identity.childrenOrder] } : {}),
        digest: content ? digestJson(content) : identityDigest(identity),
        ...(content ? { content } : {}) } };
  }

  function identityDigest(identity: LocalIdentity) {
    return identity.content ? digestJson(identity.content) : 'sha256:projection-unknown';
  }

  return Object.freeze({ prepare, identityFor, dependencyStamp, blockerIsRejected, canOmitRelativeDependency });
}
