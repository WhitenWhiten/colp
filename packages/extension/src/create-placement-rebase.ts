import { BookmarkApiError, classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { BOOKMARK_EVENT_MAX_PAGES, findProcessedBookmarkEvent } from './bookmark-event-pages.js';
import type {
  BookmarkEventRecord, JsonObject, MappingInput, QueueOperation, SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'listBookmarkEvents' | 'listMappings' | 'getMappingByNativeId' | 'rebaseClaimedPush' | 'putScopeDiagnostic'
  | 'getScope' | 'registerScope' | 'getEngineState' | 'transitionEngine' | 'setAsideClaimedPush'>;

type PlacementReadStore = Store & Pick<ReturnType<typeof createSyncStateStore>,
  'settleClaimedPush' | 'setBrowserRootStatus'>;

export interface PlacementIntent {
  readonly version: 1; readonly mode: 'top' | 'bottom'; readonly targetParentNativeId: string;
  readonly collectionId: string; readonly batchId: string; readonly batchOrder: number; readonly batchSize: number;
}

type Plan = { readonly kind: 'ready'; readonly parentId: string; readonly beforeId?: string; readonly afterId?: string }
  | { readonly kind: 'pending'; readonly code: 'create_batch_predecessor_pending' }
  | { readonly kind: 'unproven'; readonly code: 'create_placement_unproven' };

const MAX_PREDECESSOR_WAIT_ATTEMPTS = 3;

export async function savedCreatePlacement(store: Pick<Store, 'listBookmarkEvents'>,
  scope: SyncScope, opId: string): Promise<PlacementIntent | undefined> {
  return placementOf(await findProcessedBookmarkEvent(
    (after, limit) => store.listBookmarkEvents(scope, after, limit), opId, 'create'));
}

/**
 * A save's original folder is part of its intent; a recovery folder cannot
 * satisfy it. The save is set aside as one item and later saves keep uploading.
 */
export async function setAsideDeletedSaveParent(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly ownerId: string; readonly fence: number;
}): Promise<boolean> {
  const intent = await savedCreatePlacement(input.store, input.scope, input.queue.opId);
  if (!intent) return false;
  await setAsideCreatePlacement(input, intent, 'create_placement_parent_deleted');
  return true;
}

export async function rebaseStaleCreatePlacement(input: {
  readonly store: PlacementReadStore; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly ownerId: string; readonly fence: number;
  readonly digestJson: (value: unknown) => string;
  readonly readChildrenOrder?: ((parentNativeId: string) => Promise<readonly string[]>) | undefined;
  readonly defer: (code: string) => Promise<'unknown'>;
}): Promise<QueueOperation | 'unknown' | 'terminal'> {
  if (input.queue.payload.type !== 'create_node' || input.queue.retry.attempt === 0) return input.queue;
  const event = await findProcessedBookmarkEvent(
    (after, limit) => input.store.listBookmarkEvents(input.scope, after, limit), input.queue.opId, 'create');
  const intent = placementOf(event);
  if (!event || !intent) return input.queue;
  const read = await readPlacementOrder(input.readChildrenOrder, intent.targetParentNativeId);
  // Permission loss is a pause. It does not prove the saved folder is gone, and it must not
  // retire the attempt or upload the create again as if the native read never happened.
  if (read.kind === 'permission_required') return pauseStaleCreateForPermission(input);
  if (read.kind === 'absent') return setAsideCreatePlacement(input, intent, 'create_placement_parent_deleted');
  if (read.kind === 'unknown') return setAsideCreatePlacement(input, intent, 'create_placement_unproven');
  const plan = await planCreatePlacement(input.store, input.scope, event, intent,
    read.kind === 'order' ? read.ids : undefined);
  if (plan.kind === 'pending' && input.queue.retry.attempt < MAX_PREDECESSOR_WAIT_ATTEMPTS) return input.defer(plan.code);
  if (plan.kind !== 'ready') return setAsideCreatePlacement(input, intent, 'create_placement_unproven');
  const inner = asRecord(input.queue.payload.payload);
  if (!inner) return input.queue;
  const nextInner: Record<string, unknown> = { ...inner, parentId: plan.parentId };
  delete nextInner.beforeId; delete nextInner.afterId;
  if (plan.beforeId) nextInner.beforeId = plan.beforeId;
  if (plan.afterId) nextInner.afterId = plan.afterId;
  const payload = { ...input.queue.payload, payload: nextInner as JsonObject };
  return input.store.rebaseClaimedPush(input.scope, input.queue.sequence, input.ownerId, input.fence, {
    payload, digest: `sha256:${input.digestJson(payload)}`,
    idempotencyKey: `${input.queue.opId}.placement.${input.queue.retry.attempt}`,
    baseRevision: input.queue.baseRevision,
  });
}

export async function planCreatePlacement(store: Store, scope: SyncScope, event: BookmarkEventRecord,
  intent: PlacementIntent, nativeOrder?: readonly string[]): Promise<Plan> {
  if (intent.collectionId !== scope.collectionId) return { kind: 'unproven', code: 'create_placement_unproven' };
  const [parent, mappings, events] = await Promise.all([
    store.getMappingByNativeId(scope, intent.targetParentNativeId), store.listMappings(scope), listEvents(store, scope),
  ]);
  if (!authoritative(parent) || !parent.projection.childrenRevision || !events) {
    return { kind: 'unproven', code: 'create_placement_unproven' };
  }
  if (intent.batchOrder > 0) {
    const predecessor = events.filter((candidate) => {
      const placement = placementOf(candidate);
      return candidate.status === 'processed' && placement?.batchId === intent.batchId
        && placement.batchOrder < intent.batchOrder;
    }).sort((left, right) => placementOf(right)!.batchOrder - placementOf(left)!.batchOrder)[0];
    if (!predecessor) return { kind: 'unproven', code: 'create_placement_unproven' };
    const mapping = mappings.find((candidate) => candidate.nativeId === predecessor.nativeId);
    if (!mapping || !sameParent(mapping, parent, intent.targetParentNativeId)) {
      return { kind: 'unproven', code: 'create_placement_unproven' };
    }
    return authoritative(mapping)
      ? { kind: 'ready', parentId: parent.colpId, afterId: mapping.colpId }
      : { kind: 'pending', code: 'create_batch_predecessor_pending' };
  }
  const siblings = mappings.filter((mapping) => mapping.nativeId !== event.nativeId && authoritative(mapping)
    && sameParent(mapping, parent, intent.targetParentNativeId));
  if (siblings.length === 0) return { kind: 'ready', parentId: parent.colpId };
  const order = nativeOrder ?? parent.projection.childrenOrder;
  if (!order) return { kind: 'unproven', code: 'create_placement_unproven' };
  const byNative = new Map(siblings.map((mapping) => [mapping.nativeId, mapping] as const));
  const ordered = order.flatMap((nativeId) => byNative.get(nativeId) ? [byNative.get(nativeId)!] : []);
  if (ordered.length !== siblings.length) return { kind: 'unproven', code: 'create_placement_unproven' };
  // Top can sit after folders and pinned bookmarks; read the created bookmark's real neighbour when Chrome shows it.
  const own = intent.mode === 'top' ? order.indexOf(event.nativeId) : -1;
  if (own >= 0) {
    const next = order.slice(own + 1).flatMap((nativeId) => byNative.get(nativeId) ?? [])[0];
    const previous = order.slice(0, own).flatMap((nativeId) => byNative.get(nativeId) ?? []).at(-1);
    return next ? { kind: 'ready', parentId: parent.colpId, beforeId: next.colpId }
      : previous ? { kind: 'ready', parentId: parent.colpId, afterId: previous.colpId } : { kind: 'ready', parentId: parent.colpId };
  }
  const anchor = intent.mode === 'top' ? ordered[0] : ordered.at(-1);
  return !anchor ? { kind: 'ready', parentId: parent.colpId }
    : intent.mode === 'top' ? { kind: 'ready', parentId: parent.colpId, beforeId: anchor.colpId }
      : { kind: 'ready', parentId: parent.colpId, afterId: anchor.colpId };
}

type PlacementOrderRead = { readonly kind: 'skipped' }
  | { readonly kind: 'order'; readonly ids: readonly string[] }
  | { readonly kind: 'permission_required' } | { readonly kind: 'absent' } | { readonly kind: 'unknown' };

async function readPlacementOrder(
  readChildrenOrder: ((parentNativeId: string) => Promise<readonly string[]>) | undefined,
  parentNativeId: string,
): Promise<PlacementOrderRead> {
  if (!readChildrenOrder) return { kind: 'skipped' };
  try {
    const ids = await readChildrenOrder(parentNativeId);
    // A failed or non-array result is not an observed empty folder, and must not be uploaded again.
    if (!Array.isArray(ids)) return { kind: 'unknown' };
    return { kind: 'order', ids };
  } catch (error) {
    return { kind: classifyPlacementReadFailure(error) };
  }
}

function classifyPlacementReadFailure(error: unknown): 'permission_required' | 'absent' | 'unknown' {
  const failure = error instanceof BookmarkApiError ? error.failureClass : classifyBookmarkApiFailure(error);
  if (failure === 'permission_denied') return 'permission_required';
  if (failure === 'not_found') return 'absent';
  return 'unknown';
}

async function pauseStaleCreateForPermission(input: {
  readonly store: PlacementReadStore; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly ownerId: string; readonly fence: number;
}): Promise<'unknown'> {
  await input.store.setBrowserRootStatus(input.scope, 'permission_required').catch(() => undefined);
  await input.store.putScopeDiagnostic(input.scope, { kind: 'placement_refresh', code: 'permission_required',
    details: { opId: input.queue.opId } }).catch(() => undefined);
  await input.store.settleClaimedPush(input.scope, input.queue.sequence, input.ownerId, input.fence, {
    outcome: 'unknown',
    retry: { attempt: input.queue.retry.attempt, notBefore: input.queue.retry.notBefore },
    recovery: { code: 'permission_required' },
  });
  return 'unknown';
}

/**
 * One save whose place cannot be proven is one item: it is set aside (it was
 * never accepted, so it owns no server sequence), the changes that depend on
 * it wait with it, and every other save keeps uploading.
 */
async function setAsideCreatePlacement(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly ownerId: string; readonly fence: number;
}, intent: PlacementIntent, code: 'create_placement_unproven' | 'create_placement_parent_deleted'): Promise<'terminal'> {
  await input.store.putScopeDiagnostic(input.scope, { kind: 'placement_refresh', code,
    details: { opId: input.queue.opId, parentNativeId: intent.targetParentNativeId,
      ...(code === 'create_placement_parent_deleted' ? { position: intent.mode } : {}) } }).catch(() => undefined);
  await input.store.setAsideClaimedPush(input.scope, input.queue.sequence, input.ownerId, input.fence, code);
  return 'terminal';
}

async function listEvents(store: Store, scope: SyncScope): Promise<BookmarkEventRecord[] | null> {
  const rows: BookmarkEventRecord[] = []; let after = 0;
  for (let pageNumber = 0; pageNumber < BOOKMARK_EVENT_MAX_PAGES; pageNumber += 1) {
    const page = await store.listBookmarkEvents(scope, after, 100); rows.push(...page);
    if (page.length < 100) return rows;
    after = page.at(-1)!.ordinal;
  }
  return null;
}

function placementOf(event: BookmarkEventRecord | null | undefined): PlacementIntent | undefined {
  const context = asRecord(event?.details.context); const value = asRecord(context?.placement);
  if (!value || value.version !== 1 || (value.mode !== 'top' && value.mode !== 'bottom')
      || typeof value.targetParentNativeId !== 'string' || typeof value.collectionId !== 'string'
      || typeof value.batchId !== 'string' || !Number.isSafeInteger(value.batchOrder)
      || !Number.isSafeInteger(value.batchSize) || Number(value.batchOrder) < 0
      || Number(value.batchSize) < 1 || Number(value.batchOrder) >= Number(value.batchSize)) return undefined;
  return value as unknown as PlacementIntent;
}

function authoritative(mapping: MappingInput | null | undefined): mapping is MappingInput {
  return Boolean(mapping && !mapping.colpId.startsWith('pending-') && !mapping.colpId.startsWith('local-')
    && !mapping.projection.revision.startsWith('local-'));
}

function sameParent(mapping: MappingInput, parent: MappingInput, parentNativeId: string): boolean {
  if (mapping.parentNativeId !== undefined && mapping.parentNativeId !== parentNativeId) return false;
  if (mapping.parentColpId !== undefined && mapping.parentColpId !== parent.colpId) return false;
  return mapping.parentNativeId === parentNativeId || mapping.parentColpId === parent.colpId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
