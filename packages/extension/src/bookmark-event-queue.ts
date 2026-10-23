import { isAutomaticIngressWaitCode } from './sync-state/open-issue-facts.js';
import { classifySyncFailure, syncFailureCode } from './sync-failure-class.js';
import { createBookmarkPlacement } from './bookmark-event-placement.js';
import { hasRunningBootstrap } from './bootstrap/run-identity.js';
import { folderSyncCoverage } from './bookmark-sync-range.js';
import { placementDomainKeys } from './bookmark-event-placement-domain.js';
import { createBookmarkContentCapture } from './bookmark-content-capture.js';
import { captureNativeMutation } from './bookmark-native-mutation.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { kns09Paused, recordKns09PausedDrop } from './kns-09-release.js';
import { decideIngressPrivacy, isManagedBookmarkNode, recordIngressDiagnostic,
  resolveIngressBoundary } from './bookmark-event-ingress.js';
import { eligibleSyncNativeIds, subtreeSelector } from './bookmark-event-eligibility.js';
import { createReorderUplink, reorderFlushTimer } from './bookmark-reorder-uplink.js';
import { nativeIsLocallyExcluded } from './remote-delete-exclusion.js';
import { asObject, assertOperationCandidate, bookmarkKind, captureStep,
  digestJson, durableEventDetails, flattenNativeIds, INBOX_PARENT_WIRE_PLACEHOLDER,
  nodeContent, nodeCreate, validateOperation, bookmarkRepresentability,
  type BookmarkEventNode } from './bookmark-event-codec.js';
import { identityFromCreateReceipt } from './bookmark-create-receipt-identity.js';
import { classifyRemovalScope, deletionNodeKind, deletionOperationType, removalNodePresent,
  type DeletionNodeKind } from './bookmark-deletion-scope.js';
import { reconcileBookmarkTree } from './bookmark-event-reconcile.js';
import { captureMissingNativeRemovals } from './bookmark-removal-reconcile.js';
import { journalSubtreeNativeIds, persistRemovalJournal } from './deletion-journal.js';
import { capturePendingSubtreeDeletion } from './subtree-observation.js';
import { LOCAL_DELETE_MEMBER_ID_BOUND } from './pull-local-delete-supersede.js';
import { resolveEventIdentityTokens } from './bookmark-event-resolve.js';
import { createProjectionSuppression, projectionSuppresses, type ProjectionChangeFields } from './recovery-overlay.js';
import { nativeEventCorrelation } from './native-event-correlation.js';
import { recordMoveOutOfBoundaryShift } from './scope-range-shift.js';
import { completeCreatePlacement, resolveCreatePlacement } from './bookmark-event-create-placement.js'; import type { CreatePlacementConsumeResult } from './bookmark-create-placement.js';
import { createBookmarkEventHealer, type EventDependency, type EventIdentity as LocalIdentity,
  type PrepareOutcome } from './bookmark-event-heal.js';
import { blockerParkState, createBookmarkEventQuarantine, markerDependency,
  bookmarkEventErrorCode } from './bookmark-event-quarantine.js';
import type { BookmarkEventParkMarker } from './sync-state/types.js';
import type { BookmarkEventRecord, JsonObject, JsonValue, SyncScope,
  createSyncStateStore } from './sync-state-store.js';

export type { BookmarkEventNode };
const MAX_ANCESTORS = 256;
const CHILD_LOOKUP_RETRY_DELAYS_MS = [0, 100, 300] as const;
/** Durable failure codes that can never become a valid operation. */
const POISON_CODES = new Set(['operation_schema_invalid', 'operation_byte_budget_exceeded', 'object_invalid',
  'unknown_or_missing_field', 'i_json_invalid', 'bounded_string_invalid', 'unsafe_integer']);
/** Parked reasons that can still commit when dependency evidence changes. Rejected and poison do not pin. */
const PINNED_PARK_CODES = new Set(['children_fence_missing', 'dependency_pending', 'dependency_missing',
  'content_unavailable']);
function placementPinsDomain(state: string | undefined, code: string | undefined): boolean {
  return state !== 'parked' || (code !== undefined && PINNED_PARK_CODES.has(code));
}
export interface BookmarkEventApi {
  get(id: string): Promise<readonly BookmarkEventNode[]>;
  getChildren(id: string): Promise<readonly BookmarkEventNode[]>;
  getSubTree?(id: string): Promise<readonly BookmarkEventNode[]>;
}
interface QueueOptions {
  readonly scope: SyncScope; readonly store: ReturnType<typeof createSyncStateStore>; readonly api: BookmarkEventApi;
  readonly now?: () => string; readonly uuid?: () => string; readonly autoFlush?: boolean;
  readonly childLookupRetryDelaysMs?: readonly number[]; readonly fault?: 'after_sequence' | 'after_queue' | 'after_event';
  readonly reorderDebounceMs?: number; readonly scheduleReorderFlush?: (flush: () => void, delayMs: number) => void;
  readonly onReorderQueued?: () => void; readonly onReorderFlushFailed?: () => void;
  readonly resolveCreatePlacement?: (nativeId: string, node: BookmarkEventNode) => Promise<CreatePlacementConsumeResult | undefined>;
  readonly completeCreatePlacement?: (intentId: string, nativeId?: string) => Promise<void>; readonly markCreatePlacementAttention?: (intentId: string) => Promise<void>;
}
type CaptureResult = { readonly outcome: 'staged' | 'duplicate' | 'filtered' | 'apply_intent_reserved' | 'identity_unproven' | 'set_aside'; readonly eventId?: string };

export function createBookmarkEventQueue(options: QueueOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  let flushPromise: Promise<void> = Promise.resolve();
  let pendingSnapshot: readonly BookmarkEventRecord[] | undefined;
  const healer = createBookmarkEventHealer({ scope: options.scope, store: options.store,
    listPendingEvents: async () => pendingSnapshot ?? await listPendingEvents() });
  const quarantine = createBookmarkEventQuarantine({ scope: options.scope, store: options.store, now });
  const identityFor = healer.identityFor;
  const placement = createBookmarkPlacement({ store: options.store, scope: options.scope, listPendingEvents, identityFor, readChildren,
    canAnchor: async (node, parent, unmapped) => (await privacyFor(node.id, true, undefined, parent,
      isManagedBookmarkNode(node), unmapped)).allowOperationCandidate });
  const captureUnmapped = (kind: 'change' | 'move', nativeId: string, fields: JsonObject) => captureNativeMutation({ ...options, kind, nativeId, fields, uuid, now,
    placement: (parent, native, index) => placement(parent, native, index, 'unmapped'),
    allowed: async (parentId, node) => (await privacyFor(parentId, true, undefined, undefined, isManagedBookmarkNode(node), true)).allowOperationCandidate });
  const { changed, described, tagged, pinned } = createBookmarkContentCapture({ ...options, identityFor, uuid, stage, correlationFor, reservedByProjection,
    captureUnmapped: (nativeId, fields) => captureUnmapped('change', nativeId, fields),
    canWrite: async (nativeId, identity, observed) => (await privacyFor(nativeId, false, identity, undefined,
      observed ? isManagedBookmarkNode(observed) : false)).allowOperationCandidate });
  const reorderUplink = createReorderUplink({ store: options.store, scope: options.scope, uuid, identityFor,
    listPendingEvents, stageMove: (nativeId, details, eventId) => stage('move', nativeId, details, eventId, undefined, false),
    hasApplyIntent: async (nativeId, details) => await hasApplyIntent('move', nativeId, details)
      || await reservedByProjection('move', nativeId, `recovery:move:${(await identityFor(nativeId))?.colpId}`, undefined,
        { parentNativeId: String(details.parentId), index: Number(details.index) }),
    // Capture-only queues leave reorder draining to explicit flush/recover.
    scheduleFlush: () => options.autoFlush === false ? undefined : reorderFlushTimer(
      () => flush().catch(() => { options.onReorderFlushFailed?.(); }), options.scheduleReorderFlush, options.reorderDebounceMs) });

  async function created(nativeId: string, rawNode: BookmarkEventNode): Promise<CaptureResult> {
    const representability = bookmarkRepresentability(rawNode);
    if (representability !== 'supported') {
      await recordIngressDiagnostic(options.store, options.scope, representability);
      return { outcome: 'filtered' };
    }
    const parentNativeId = typeof rawNode.parentId === 'string' ? rawNode.parentId : '';
    const privacy = await captureStep('privacy_evaluation_failed', () =>
      privacyFor(parentNativeId, true, undefined, undefined, isManagedBookmarkNode(rawNode), true));
    if (!privacy.allowOperationCandidate
        || await nativeIsLocallyExcluded(options.store, options.scope, nativeId, [parentNativeId])) {
      return { outcome: 'filtered' };
    }
    const parent = await captureStep('parent_identity_failed', () => identityFor(parentNativeId));
    const node = nodeCreate(rawNode);
    if (await captureStep('apply_intent_failed', () => hasApplyIntent('create', nativeId, { parentId: parentNativeId, node }))
        || await reservedByProjection('create', nativeId, createProjectionSuppression(parentNativeId, rawNode.title, rawNode.url))) {
      return { outcome: 'apply_intent_reserved' };
    }
    const eventId = uuid(); const colpId = `pending-${eventId}`;
    const content = nodeContent(rawNode); const nodeKind = bookmarkKind(rawNode);
    const rootNativeId = parent?.rootNativeId ?? await rootNativeFor(parentNativeId);
    const parentId = parent && !parent.colpId.startsWith('pending-') ? parent.colpId : INBOX_PARENT_WIRE_PLACEHOLDER;
    const placementResolution = await resolveCreatePlacement({ resolve: options.resolveCreatePlacement, complete: options.completeCreatePlacement,
      markAttention: options.markCreatePlacementAttention, store: options.store, scope: options.scope, nativeId, node: rawNode, parentNativeId });
    const relative = await captureStep('relative_placement_failed', () =>
      placement(parentNativeId, nativeId, rawNode.index ?? 0, 'create-history'));
    const staged = await captureStep('bookmark_event_stage_failed', () => stage('create', nativeId,
      { operation: { type: 'create_node', baseRevision: null, dependencies: [], payload: { parentId, ...relative.wire, node } },
        context: { parentNativeId, index: rawNode.index ?? 0, ...(relative.afterNativeId ? { afterNativeId: relative.afterNativeId } : {}),
          ...(relative.beforeNativeId ? { beforeNativeId: relative.beforeNativeId } : {}), ...(placementResolution.context ? { placement: placementResolution.context } : {}) },
        ...(placementResolution.hold ? { hold: { code: placementResolution.hold } } : {}),
        mapping: { nativeId, colpId, rootNativeId, nodeKind, parentNativeId,
          projection: { revision: `local-${eventId}`, digest: digestJson(content), content } } }, eventId));
    await completeCreatePlacement({ complete: options.completeCreatePlacement,
      intent: placementResolution.intent, outcome: staged.outcome });
    return staged;
  }

  async function moved(nativeId: string, move: { readonly parentId: string; readonly index: number;
    readonly oldParentId: string; readonly oldIndex: number }): Promise<CaptureResult> {
    const identity = await identityFor(nativeId); const sourcePrivacy = await privacyFor(nativeId, false, identity);
    if (!identity) { const captured = await captureUnmapped('move', nativeId, { ...move }); if (captured) return captured; }
    const targetPrivacy = await privacyFor(move.parentId, true);
    if (!identity || !sourcePrivacy.allowOperationCandidate) {
      // Snapshot moves of not-yet-mapped natives must not become local creates.
      if ((await options.store.getEngineState(options.scope))?.recoveryFrozen) return { outcome: 'filtered' };
      if (!targetPrivacy.allowOperationCandidate) return { outcome: 'filtered' };
      const nodes = await options.api.get(nativeId); return nodes[0] ? created(nativeId, nodes[0]) : { outcome: 'filtered' };
    }
    if (!targetPrivacy.allowOperationCandidate) {
      // Missing mapping/authority is not evidence that the bookmark left the
      // synchronized range. Tree recovery can capture the move once its parent
      // becomes representable and mapped. Only a proven boundary exit deletes.
      if (targetPrivacy.reason !== 'not_selected' && targetPrivacy.reason !== 'private_local') {
        return { outcome: 'filtered' };
      }
      if (await isBoundaryRoot(nativeId)) return { outcome: 'filtered' };
      if (identity.nodeKind === 'folder') {
        const recorded = await options.store.getScope(options.scope);
        await recordMoveOutOfBoundaryShift(options.store, options.scope, {
          nativeId, colpId: identity.colpId, fromParentNativeId: move.oldParentId,
          toParentNativeId: move.parentId, boundaryVersion: recorded?.boundaryVersion ?? '0',
        });
        return { outcome: 'filtered' };
      }
      return stageDelete(nativeId, identity, false, await eligibleMappedSubtreeNativeIds(nativeId));
    }
    if (await hasApplyIntent('move', nativeId, { parentId: move.parentId, index: move.index,
      oldParentId: move.oldParentId, oldIndex: move.oldIndex })
        || await reservedByProjection('move', nativeId, `recovery:move:${identity.colpId}`, undefined,
          { parentNativeId: move.parentId, index: move.index })) return { outcome: 'apply_intent_reserved' };
    const sourceParent = await identityFor(move.oldParentId); const targetParent = await identityFor(move.parentId);
    if (!sourceParent || !targetParent) return { outcome: 'filtered' };
    // A mapped parent without a childrenRevision is a folder whose create
    // confirmation has not echoed back yet (e.g. "new folder, drag bookmark
    // in" within one round trip). The move must stage and wait — flush holds
    // it until both parent fences are confirmed — not silently drop, which
    // left the bookmark in its old place in the library forever. The staged
    // payload carries placeholder fences only to satisfy the operation
    // schema; preparePendingEvent re-derives the real ones at flush time.
    const eventId = uuid(); const relative = await placement(move.parentId, nativeId, move.index);
    return stage('move', nativeId, { operation: { type: 'move_node', targetId: identity.colpId,
      baseRevision: identity.revision, dependencies: [], payload: { newParentId: targetParent.colpId,
        ...relative.wire, baseSourceParentRevision: sourceParent.childrenRevision ?? `local-${eventId}`,
        baseTargetParentRevision: targetParent.childrenRevision ?? `local-${eventId}` } },
      context: { sourceParentNativeId: move.oldParentId, targetParentNativeId: move.parentId,
        ...(relative.afterNativeId ? { afterNativeId: relative.afterNativeId } : {}),
        ...(relative.beforeNativeId ? { beforeNativeId: relative.beforeNativeId } : {}) },
      mapping: { nativeId, colpId: identity.colpId, rootNativeId: targetParent.rootNativeId,
        ...(identity.nodeKind ? { nodeKind: identity.nodeKind } : {}), parentNativeId: move.parentId,
        projection: { revision: `local-${eventId}`,
          ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
          digest: identity.content ? digestJson(identity.content) : 'sha256:projection-unknown',
          ...(identity.content ? { content: identity.content } : {}) } } }, eventId);
  }

  async function unmatchedDeletion(nativeId: string, node: BookmarkEventNode | null | undefined): Promise<CaptureResult> {
    await options.store.recordLocalIssue(options.scope, { code: 'deletion_identity_unproven', nativeId, now: Date.parse(now()),
      ...(typeof node?.title === 'string' ? { title: node.title } : {}) });
    return { outcome: 'filtered' };
  }

  async function removed(nativeId: string, removal: { readonly parentId: string; readonly index: number;
    readonly node?: BookmarkEventNode | null }): Promise<CaptureResult> {
    if (await nativeIsLocallyExcluded(options.store, options.scope, nativeId,
        await ancestorChain(removal.parentId))) {
      return { outcome: 'filtered' };
    }
    if (await options.store.discardAppliedRemoteDeleteEcho(options.scope, nativeId)) {
      return { outcome: 'apply_intent_reserved' };
    }
    const mappings = await options.store.listMappings(options.scope);
    const mapping = await options.store.getMappingByNativeId(options.scope, nativeId);
    const identity = await identityFor(nativeId) ?? await identityFromCreateReceipt(options.store, options.scope, nativeId);
    if (!identity && await hasRunningBootstrap(options.store, options.scope)) {
      await persistRemovalJournal(options.store, options.scope, { nativeId, removal, mappings });
      return { outcome: 'filtered' };
    }
    const boundary = await resolveIngressBoundary(options.store, options.scope);
    const detachedNative = new Set((await options.store.listMountBindings(options.scope))
      .filter((mount) => mount.status === 'detached').map((mount) => mount.nativeRootId));
    const scopeClass = await classifyRemovalScope({
      nativeId, parentId: removal.parentId, managed: isManagedBookmarkNode(removal.node ?? {}),
      api: options.api, selectedNative: boundary.selectedNative, privateNative: boundary.privateNative,
      detachedNative, mapping,
    });
    if (scopeClass.kind === 'out_of_scope') return { outcome: 'filtered' };
    // A removed bookmark with no mapping cannot be tied to the library: nothing
    // is deleted anywhere else, and it is reported as one item, not a stop.
    if (scopeClass.kind === 'unknown') return unmatchedDeletion(nativeId, removal.node);
    await persistRemovalJournal(options.store, options.scope, { nativeId, removal, mappings });
    if (!identity) return unmatchedDeletion(nativeId, removal.node);
    const privacy = await privacyFor(nativeId, false, identity,
      removal.parentId, isManagedBookmarkNode(removal.node ?? {}));
    if (!privacy.allowOperationCandidate) return { outcome: 'filtered' };
    // A selected root is the sync boundary itself and its mapping carries the
    // collection's canonical root id: deleting the local folder must never
    // delete the collection. Root reconciliation reports root_missing instead.
    if (await isBoundaryRoot(nativeId)) return { outcome: 'filtered' };
    if (await hasApplyIntent('remove', nativeId, { parentId: removal.parentId, index: removal.index })
        || await reservedByProjection('remove', nativeId, `recovery:delete:${identity.colpId}`)) {
      return { outcome: 'apply_intent_reserved' };
    }
    const fromEvent = removalNodePresent(removal.node) ? await eligibleDeleteNativeIds(removal.node) : [];
    const fromMapping = await eligibleMappedSubtreeNativeIds(nativeId);
    const fromJournal = journalSubtreeNativeIds(nativeId, await options.store.listDeletionJournal(options.scope));
    const deleteNativeIds = [...new Set([...fromEvent, ...fromMapping, ...fromJournal])];
    // F002: the operation shape follows the removed node's own kind, never the
    // local descendant count. A folder that Chrome reported without emitting
    // child events (or that this replica never pulled children for) must still
    // be delete_subtree: the server permanently refuses a single delete of a
    // non-empty folder, and ingress has already dropped the local mapping.
    const kind = deletionNodeKind({
      eventNode: removalNodePresent(removal.node) ? removal.node : null,
      mappedKind: identity.nodeKind, mappedContent: identity.content,
    });
    return stageDeleteResolved(nativeId, identity, kind, deleteNativeIds);
  }

  async function reordered(parentNativeId: string, childIds: readonly string[]): Promise<CaptureResult> {
    const privacy = await privacyFor(parentNativeId, true);
    if (!privacy.allowOperationCandidate) {
      await reorderUplink.captureLocalOnly(parentNativeId, childIds); return { outcome: 'filtered' };
    }
    return reorderUplink.capture(parentNativeId, childIds);
  }

  async function stageDelete(nativeId: string, identity: LocalIdentity, subtree: boolean,
    deleteNativeIds: readonly string[]): Promise<CaptureResult> {
    // Root reconciliation proves a folder with `true`; every other shape goes
    // through the same kind resolver as live removal, where an unproven kind
    // still fails safe toward delete_subtree.
    return stageDeleteResolved(nativeId, identity, subtree ? 'folder'
      : deletionNodeKind({ mappedKind: identity.nodeKind, mappedContent: identity.content }), deleteNativeIds);
  }

  async function stageDeleteResolved(nativeId: string, identity: LocalIdentity, kind: DeletionNodeKind | undefined,
    deleteNativeIds: readonly string[]): Promise<CaptureResult> {
    const boundaries = await boundaryRootNativeIds();
    const type = deletionOperationType(kind);
    const subtree = type === 'delete_subtree' ? capturePendingSubtreeDeletion(identity.colpId,
      await options.store.listMappings(options.scope), await listPendingEvents()) : undefined;
    const eventId = uuid(); return stage('remove', nativeId, { operation: { type,
      targetId: identity.colpId, baseRevision: identity.revision, dependencies: [],
      ...(subtree?.source ? { source: subtree.source } : {}),
      payload: { reason: 'browser_event' } },
    // Keep boundary-root mappings out of every delete: root authority is
    // reconciled through configureBrowserRoots, not by bookmark events.
    ...(subtree?.observation ? { subtreeObservation: subtree.observation } : {}),
    // Kept so a stale upload can tell "the same nodes, newer revisions" from new members (push-delete-rebase.ts).
    ...(subtree?.memberIdsDigest ? { subtreeMemberIdsDigest: subtree.memberIdsDigest } : {}),
    // Names the members so a later remote change inside the deleted folder is taken as superseded.
    ...(subtree && subtree.memberIds.length <= LOCAL_DELETE_MEMBER_ID_BOUND ? { subtreeMemberIds: subtree.memberIds } : {}),
    deleteNativeIds: deleteNativeIds.filter((id) => !boundaries.has(id)) }, eventId);
  }

  async function boundaryRootNativeIds(): Promise<ReadonlySet<string>> {
    const boundary = await resolveIngressBoundary(options.store, options.scope);
    return new Set([...boundary.selectedNative, ...boundary.privateNative]);
  }

  async function isBoundaryRoot(nativeId: string): Promise<boolean> {
    return (await boundaryRootNativeIds()).has(nativeId);
  }

  async function stage(kind: 'create' | 'change' | 'move' | 'remove', nativeId: string, details: JsonObject,
    eventId: string, exactCorrelation?: string, flushAfter = true): Promise<CaptureResult> {
    if (await kns09Paused('ingress')) { recordKns09PausedDrop(); return { outcome: 'filtered' }; }
    const occurredAt = now(); assertOperationCandidate(asObject(details.operation, 'operation'));
    const dedupeKey = digestJson({ kind, nativeId, exactCorrelation: exactCorrelation ?? null,
      operation: details.operation as JsonValue });
    let result;
    try {
      result = await options.store.stageBookmarkEvent(options.scope, { eventId, dedupeKey, occurredAt,
        kind, nativeId, details: durableEventDetails(details) });
    } catch (error) {
      const code = syncFailureCode(error);
      if (classifySyncFailure(code, { nativeId, eventId })?.class !== 'item') throw error;
      const mapping = details.mapping as JsonObject | undefined;
      await options.store.recordLocalIssue(options.scope, { code, nativeId, now: Date.parse(occurredAt),
        quarantine: { rootNativeId: typeof mapping?.rootNativeId === 'string' ? mapping.rootNativeId : nativeId,
          evidenceDigest: dedupeKey } });
      return { outcome: 'set_aside' };
    }
    if (options.autoFlush !== false && flushAfter) await flush();
    return { outcome: result.outcome, eventId: result.event.eventId };
  }

  async function flush(): Promise<void> {
    const work = flushPromise.then(async () => {
      if (await kns09Paused('ingress')) { recordKns09PausedDrop(); return; }
      // SR-08: one merged move batch per parent, staged before the inbox is read
      // so the batch commits in this same round.
      const reorderStaged = await reorderUplink.drain();
      const events = await listPendingEvents();
      // Markers are pruned against the live inbox in the same read, so the
      // ledger cannot outgrow the ingress diagnostic scan budget.
      const markers = await quarantine.load(new Set(events.map((event) => event.eventId)));
      pendingSnapshot = events;
      const resolved = new Map<string, string>();
      // One attempt per event per round. N-3 / D-09: a placement that can still
      // commit pins only its order domain, so an unrelated parent still commits.
      const attempted = new Set<string>();
      const heldDomains = new Set<string>();
      const pin = (event: BookmarkEventRecord) => {
        for (const key of placementDomainKeys(event)) heldDomains.add(key);
      };
      const domainBusy = (event: BookmarkEventRecord) => placementDomainKeys(event)
        .some((key) => heldDomains.has(key));
      let firstFailure: unknown;
      for (const event of events) {
        if (event.details.nativeMutation === true && await options.store.discardRemovedNativeMutation(options.scope, event.eventId,
          (await lookupBookmark(id => options.api.get(id), event.nativeId)).class === 'not_found')) continue;
        if (attempted.has(event.eventId)) continue;
        attempted.add(event.eventId);
        if (event.kind === 'remove' && await options.store.discardAppliedRemoteDeleteEcho(
          options.scope, event.nativeId, event.eventId)) continue;
        if (domainBusy(event)) { pin(event); continue; }
        const marker = markers.get(event.eventId);
        if (marker?.state === 'parked') {
          const dependency = markerDependency(marker);
          const stamp = dependency && marker.dependencyStamp !== undefined
            ? await healer.dependencyStamp(dependency, blockerParkState(markers, dependency)).catch(() => undefined)
            : undefined;
          // Isolated until its recorded dependency evidence actually moves.
          if (!isAutomaticIngressWaitCode(marker.code) && (stamp === undefined || stamp === marker.dependencyStamp)) {
            if (placementPinsDomain(marker.state, marker.code)) pin(event);
            continue;
          }
          await quarantine.reopen(event, marker).catch(() => undefined);
          markers.set(event.eventId, { ...marker, state: 'open', attempts: 0 });
        }
        const details = await resolveEventIdentityTokens(options.store, options.scope, event.details, resolved);
        let prepared: PrepareOutcome;
        try { prepared = await healer.prepare(event, details); }
        catch (error) {
          const poisoned = await parkPoison(event, markers, error);
          if (!poisoned) { firstFailure ??= error; pin(event); }
          continue;
        }
        if (prepared.kind === 'blocked') {
          if (!await holdBlocked(event, prepared, markers)) firstFailure ??= new Error('bookmark_event_park_failed');
          const parked = markers.get(event.eventId);
          if (placementPinsDomain(parked?.state, parked?.code)) pin(event);
          continue;
        }
        const operation = asObject(prepared.operation, 'operation');
        const baseRevision = operation.baseRevision === null ? null : String(operation.baseRevision);
        try {
          const committed = await options.store.commitBookmarkEvent(options.scope, event.eventId, { operation,
            baseRevision, operationRevision: `local-${event.eventId}`, validateOperation: validateOperation,
            digestOperation: digestJson, allocateOperationId: uuid,
            ...(prepared.mapping ? { mapping: prepared.mapping } : {}),
            deleteNativeIds: prepared.deleteNativeIds }, options.fault ? { fault: options.fault } : {});
          resolved.set(event.eventId, committed.opId);
          // A bootstrap receipt can settle a capture without writing a new
          // optimistic mapping. Later siblings must see that confirmed identity,
          // not reapply this now-processed capture from the round's snapshot.
          pendingSnapshot = pendingSnapshot?.filter(row => row.eventId !== event.eventId);
        } catch (error) {
          const code = bookmarkEventErrorCode(error);
          // The queue itself holds live work for this event; it waits in the
          // inbox behind the exact attempt it depends on (F010 evidence is
          // recorded by the commit path) and resumes on a later flush.
          if (code === 'move_predecessor_pending' || code === 'exact_retry_pending') { pin(event); continue; }
          // Scope-level holds cannot be settled by any later event either; the
          // round stops and the scope error still surfaces to the caller.
          if (code === 'queue_recovery_frozen' || code === 'scope_retired' || code === 'scope_not_found') {
            firstFailure ??= error; break;
          }
          const poisoned = await parkPoison(event, markers, error);
          if (!poisoned) { firstFailure ??= error; pin(event); }
        }
      }
      if (firstFailure) throw firstFailure;
      if (reorderStaged) options.onReorderQueued?.();
    });
    const settled = work.finally(() => { pendingSnapshot = undefined; });
    flushPromise = settled.catch(() => undefined); return settled;
  }

  /** Live authority waits remain automatic; deterministic refusal/poison parks its dependents. */
  async function holdBlocked(event: BookmarkEventRecord, blocked: Extract<PrepareOutcome,
  { readonly kind: 'blocked' }>, markers: Map<string, BookmarkEventParkMarker>): Promise<boolean> {
    const dependency = blocked.dependency;
    const blockerState = blockerParkState(markers, dependency);
    const rejected = blockerState !== 'parked'
      && await healer.blockerIsRejected(dependency);
    const previous = markers.get(event.eventId);
    const attempts = (previous?.state === 'open' ? previous.attempts : 0) + 1;
    if (!rejected && blockerState !== 'parked') {
      try { await quarantine.track(event, { attempts, reason: blocked.reason, dependency }); return true; }
      catch { return false; }
    }
    const code = rejected ? 'dependency_rejected'
      : blockerState === 'parked' ? 'dependency_parked' : blocked.reason;
    return parkEvent(event, markers, { code, attempts, reason: blocked.reason, dependency });
  }

  /** Deterministic poison: the durable draft can never become a valid operation. */
  async function parkPoison(event: BookmarkEventRecord, markers: Map<string, BookmarkEventParkMarker>,
    error: unknown): Promise<boolean> {
    const code = bookmarkEventErrorCode(error);
    if (!POISON_CODES.has(code)) return false;
    const attempts = (markers.get(event.eventId)?.attempts ?? 0) + 1;
    return parkEvent(event, markers, { code, attempts, reason: code });
  }

  async function parkEvent(event: BookmarkEventRecord, markers: Map<string, BookmarkEventParkMarker>,
    decision: { readonly code: string; readonly attempts: number; readonly reason?: string;
      readonly dependency?: EventDependency }): Promise<boolean> {
    const stamp = decision.dependency
      ? await healer.dependencyStamp(decision.dependency,
        blockerParkState(markers, decision.dependency)).catch(() => undefined)
      : undefined;
    const parked = await quarantine.park(event, { ...decision, ...(stamp === undefined ? {} : { stamp }) });
    if (!parked) return false;
    markers.set(event.eventId, { eventId: event.eventId, state: 'parked', code: decision.code,
      attempts: decision.attempts, at: now(), ...(stamp === undefined ? {} : { dependencyStamp: stamp }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.dependency?.nativeId === undefined ? {} : { dependencyNativeId: decision.dependency.nativeId }),
      ...(decision.dependency?.opId === undefined ? {} : { dependencyOpId: decision.dependency.opId }),
      ...(decision.dependency?.eventId === undefined ? {} : { dependencyEventId: decision.dependency.eventId }) });
    return true;
  }

  async function recover(): Promise<void> { await flush(); await reconcileTree(); await flush(); }

  async function reconcileTree(): Promise<void> {
    await reconcileBookmarkTree({
      store: options.store, scope: options.scope, identityFor, created, changed, moved, stageDelete,
      readChildren, readNode: id => options.api.get(id), listPendingEvents,
    });
  }

  async function privacyFor(nativeId: string, isParent: boolean, existing?: LocalIdentity | null,
    fallbackParent?: string, managed = false, allowUnmappedSelected = false) {
    const boundary = await resolveIngressBoundary(options.store, options.scope);
    const boundaryIdentity = isParent ? await identityFor(nativeId) : existing;
    const start = isParent ? nativeId : existing?.nativeId ?? fallbackParent ?? nativeId;
    const ancestors = await ancestorChain(start, fallbackParent);
    if (boundaryIdentity?.rootNativeId && !ancestors.includes(boundaryIdentity.rootNativeId)) {
      ancestors.push(boundaryIdentity.rootNativeId);
    }
    const mapped = boundaryIdentity !== null && boundaryIdentity !== undefined;
    // Live mapped identities keep their own remote id; only unmapped copies
    // inherit an ancestor exclusion so they cannot author the tombstoned parent.
    if (await nativeIsLocallyExcluded(options.store, options.scope, nativeId, mapped ? [] : ancestors)) {
      return { allowOperationCandidate: false, reason: 'not_selected' };
    }
    const decided = decideIngressPrivacy({ rootStatus: boundary.rootStatus, mapped,
      ...folderSyncCoverage(start, ancestors, boundary.selectedNative, boundary.privateNative), managed, allowUnmappedSelected });
    if (decided.diagnostic) await recordIngressDiagnostic(options.store, options.scope, decided.diagnostic);
    return decided.privacy;
  }

  async function rootNativeFor(start: string): Promise<string> {
    const boundary = await resolveIngressBoundary(options.store, options.scope);
    const ancestors = await ancestorChain(start);
    return ancestors.find((id) => boundary.selectedNative.has(id)) ?? start;
  }

  async function ancestorChain(start: string, fallbackParent?: string) {
    const result: string[] = []; let current = start; const seen = new Set<string>();
    for (let depth = 0; current && depth < MAX_ANCESTORS; depth += 1) {
      if (seen.has(current)) return []; seen.add(current); result.push(current);
      let values: Awaited<ReturnType<BookmarkEventApi['get']>>;
      try { values = await options.api.get(current); }
      catch { if (depth === 0 && fallbackParent) { current = fallbackParent; continue; } return []; }
      const parent = values[0]?.parentId;
      current = typeof parent === 'string' ? parent : depth === 0 && fallbackParent ? fallbackParent : '';
    }
    return result;
  }

  async function readChildren(parentNativeId: string): Promise<readonly BookmarkEventNode[]> {
    let firstError: unknown;
    for (const delay of options.childLookupRetryDelaysMs ?? CHILD_LOOKUP_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      try { return await options.api.getChildren(parentNativeId); }
      catch (primaryError) {
        firstError ??= primaryError;
        if (!options.api.getSubTree) continue;
        try {
          const subtree = await options.api.getSubTree(parentNativeId); const parent = subtree[0];
          if (parent?.id === parentNativeId && Array.isArray(parent.children)) return parent.children;
        } catch { /* retry the bounded equivalent reads together */ }
      }
    }
    throw firstError ?? new Error('children_lookup_failed');
  }

  async function eligibleDeleteNativeIds(node: BookmarkEventNode) {
    const nativeIds = new Set(flattenNativeIds(node));
    return eligibleSyncNativeIds({ store: options.store, scope: options.scope, listPendingEvents,
      select: (mapping) => nativeIds.has(mapping.nativeId) });
  }
  async function eligibleMappedSubtreeNativeIds(nativeId: string) {
    return eligibleSyncNativeIds({ store: options.store, scope: options.scope, listPendingEvents,
      select: subtreeSelector(nativeId) });
  }
  function correlationFor(kind: string, nativeId: string, details: JsonObject) {
    return nativeEventCorrelation(kind, nativeId, details);
  }
  async function hasApplyIntent(kind: string, nativeId: string, details: JsonObject) {
    const correlationId = correlationFor(kind, nativeId, details);
    return options.store.observeApplyIntentEvent(options.scope, correlationId, { eventDigest: correlationId, nativeId });
  }
  async function reservedByProjection(kind: 'create' | 'change' | 'move' | 'remove', nativeId: string,
    suppression: string | undefined, changes?: ProjectionChangeFields,
    placement?: { readonly parentNativeId: string; readonly index: number }) {
    return projectionSuppresses(await options.store.listProjectionIntents(options.scope), {
      kind, nativeId, suppression, ...(changes === undefined ? {} : { changes }),
      ...(placement === undefined ? {} : placement),
    });
  }
  async function listPendingEvents() {
    const events: BookmarkEventRecord[] = []; let afterOrdinal = 0;
    while (true) {
      const page = await options.store.listBookmarkEventsByStatus(options.scope, 'pending', afterOrdinal, 1_000);
      events.push(...page);
      if (page.length < 1_000) return events;
      afterOrdinal = page[page.length - 1]!.ordinal;
    }
  }

  return Object.freeze({ created, changed, described, tagged, pinned, moved, removed, reordered, flush, recover, correlationFor,
    captureMissingRemovals: () => captureMissingNativeRemovals({ store: options.store, scope: options.scope, api: options.api, removed }) });
}
