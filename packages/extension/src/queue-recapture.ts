import { canonicalOperationDigest } from '@know-n/colp/sync/canonical';
import { lookupBookmark, type BookmarkNode } from './bookmark-api-error.js';
import { bookmarkKind, bookmarkRepresentability, nodeCreate, nodeContent, validateOperation,
  type BookmarkEventNode } from './bookmark-event-codec.js';
import { resolveIngressBoundary, isManagedBookmarkNode } from './bookmark-event-ingress.js';
import { nativeIsLocallyExcluded } from './remote-delete-exclusion.js';
import type { JsonObject, QueueOperation, BookmarkEventRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

export interface QueueRecapture {
  readonly operations: readonly JsonObject[];
  readonly nativeId?: string;
  readonly parentNativeId?: string;
}
export type RecaptureQueueRow = (row: QueueOperation) => Promise<QueueRecapture>;

/** Re-read native identity, content, location and privacy before authoring new bytes. */
export function createQueueRecapture(input: { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope;
  api: { get(id: string): Promise<readonly BookmarkNode[]>; getChildren(id: string): Promise<readonly BookmarkNode[]> };
  permission: () => Promise<boolean>; now?: () => number }): RecaptureQueueRow {
  const { store, scope, api } = input;
  return async row => {
    if (!await input.permission()) throw new Error('permission_required');
    const recorded = await store.getScope(scope);
    if (recorded?.lifecycle !== 'active' || recorded.rootStatus !== 'ready') throw new Error('scope_not_writable');
    let event: BookmarkEventRecord | undefined;
    let after = 0;
    for (;;) {
      const events = await store.listBookmarkEvents(scope, after, 100);
      event = events.find(candidate => candidate.opId === row.opId);
      if (event || events.length < 100) break;
      after = events.at(-1)!.ordinal;
    }
    // The original placement reservation failed identity proof. Matching the
    // mapping this very capture created cannot independently prove that identity.
    // v1 repairs this through archived replica Rebuild; Retry must keep the hold.
    const originalHold = event?.details.hold as JsonObject | undefined;
    if (originalHold?.code === 'recovery_identity_unproven') throw new Error('recovery_identity_unproven');
    const target = typeof row.payload.targetId === 'string' ? row.payload.targetId : `pending-${row.opId}`;
    const mapping = await store.getMappingByColpId(scope, target);
    // Retry never removes an identity hold merely because a mapping happens to exist.
    if (!mapping || !event || event.nativeId !== mapping.nativeId
        || (await store.getMappingByNativeId(scope, event.nativeId))?.colpId !== target
        || /^(?:recovery:|sidecar:|unmounted:)/u.test(mapping.nativeId)) throw new Error('recovery_identity_unproven');
    const looked = await lookupBookmark(id => api.get(id), mapping.nativeId);
    const deleting = row.payload.type === 'delete_node' || row.payload.type === 'delete_subtree';
    if (looked.class !== 'present' && looked.class !== 'not_found') throw new Error(looked.message);
    if (looked.class === 'not_found') {
      if (row.payload.type === 'create_node') return { operations: [] };
      // An absent existing node needs the removal journal, not replay of an old edit.
      throw new Error('deletion_identity_unproven');
    }
    if (deleting) return { operations: [] }; // deletion intent no longer matches current native state
    const observed = looked.nodes[0]!;
    if (typeof observed.title !== 'string') throw new Error('recovery_identity_unproven');
    const node = observed as BookmarkEventNode;
    if (isManagedBookmarkNode(node)) throw new Error('permission_required');
    if (bookmarkRepresentability(node) !== 'supported') throw new Error('operation_schema_invalid');
    const boundary = await resolveIngressBoundary(store, scope);
    const chain: string[] = [node.id]; let parentId = node.parentId; const seen = new Set(chain);
    while (parentId) {
      if (seen.has(parentId) || chain.length >= 256) throw new Error('recovery_identity_unproven');
      seen.add(parentId); chain.push(parentId);
      const parent = await lookupBookmark(id => api.get(id), parentId);
      if (parent.class !== 'present') throw new Error('recovery_identity_unproven');
      parentId = parent.nodes[0]?.parentId;
    }
    const selected = chain.some(id => boundary.selectedNative.has(id));
    const privateLocal = chain.some(id => boundary.privateNative.has(id))
      || await nativeIsLocallyExcluded(store, scope, node.id, chain.slice(1));
    if (!selected || privateLocal) return { operations: [] };
    if (!node.parentId) throw new Error('create_placement_unproven');
    const parent = await store.getMappingByNativeId(scope, node.parentId);
    if (!parent || parent.colpId.startsWith('local-')) throw new Error('create_placement_unproven');
    const siblings = await api.getChildren(node.parentId);
    const index = siblings.findIndex(sibling => sibling.id === node.id);
    if (index < 0) throw new Error('create_placement_unproven');
    let afterId: string | undefined;
    for (const sibling of siblings.slice(0, index).reverse()) {
      const anchor = await store.getMappingByNativeId(scope, sibling.id);
      if (anchor && !anchor.colpId.startsWith('local-')) { afterId = anchor.colpId; break; }
    }
    const placement = { ...(afterId ? { afterId } : {}) };
    const occurredAt = new Date((input.now ?? Date.now)()).toISOString();
    const fresh = (type: string, payload: JsonObject, baseRevision: string | null, targetId?: string): JsonObject => {
      const opId = crypto.randomUUID();
      return { opId, replicaId: scope.replicaId, sequence: 1, collectionId: scope.collectionId,
        type, baseRevision, ...(targetId ? { targetId } : {}), occurredAt,
        dependencies: [payload.parentId, payload.newParentId].filter((id): id is string =>
          typeof id === 'string' && id.startsWith('pending-')).map(id => id.slice('pending-'.length)), payload };
    };
    const provisional = mapping.colpId.startsWith('pending-');
    const operations: JsonObject[] = [];
    if (provisional) {
      if (mapping.colpId !== `pending-${row.opId}` || row.payload.type !== 'create_node') {
        throw new Error('recovery_identity_unproven');
      }
      operations.push(fresh('create_node', { parentId: parent.colpId, ...placement,
        node: nodeCreate(node) }, null));
    } else {
      const observation = await store.getRemoteObservation(scope, mapping.colpId);
      const remoteContent = observation?.kind === 'content' && observation.payload.deleted !== true ? observation : undefined;
      const revision = remoteContent?.remoteRevision ?? mapping.projection.resourceRevision ?? mapping.projection.revision;
      if (revision.startsWith('local-')) throw new Error('recovery_identity_unproven');
      if (row.payload.type === 'move_node') {
        const inner = row.payload.payload as JsonObject;
        const source = mapping.parentColpId ? await store.getMappingByColpId(scope, mapping.parentColpId) : null;
        const sourceRevision = source?.projection.childrenRevision ?? inner.baseSourceParentRevision;
        if (typeof sourceRevision !== 'string' || !parent.projection.childrenRevision) throw new Error('create_placement_unproven');
        operations.push(fresh('move_node', { newParentId: parent.colpId, ...placement,
          baseSourceParentRevision: sourceRevision, baseTargetParentRevision: parent.projection.childrenRevision },
        revision, mapping.colpId));
      }
      if (bookmarkKind(node) !== 'separator') {
        const old = row.payload.payload as JsonObject;
        const base = remoteContent?.payload ?? (row.baseRevision === revision && old.base && typeof old.base === 'object' ? old.base : mapping.projection.content);
        operations.push(fresh('update_node_content', { base: base ?? {}, value: nodeContent(node) }, revision, mapping.colpId));
      }
    }
    for (const operation of operations) if (!validateOperation(operation)) throw new Error('operation_schema_invalid');
    return { operations, nativeId: mapping.nativeId, parentNativeId: node.parentId };
  };
}

export const recapturedOperationDigest = (operation: JsonObject) => canonicalOperationDigest(operation as never);
