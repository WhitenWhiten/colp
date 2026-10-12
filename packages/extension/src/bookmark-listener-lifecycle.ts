import type { BookmarkEventNode } from './bookmark-event-queue.js';

export type BookmarkCaptureEvent =
  | { readonly kind: 'created'; readonly nativeId: string; readonly node: BookmarkEventNode }
  | { readonly kind: 'changed'; readonly nativeId: string; readonly changes: { readonly title?: string; readonly url?: string } }
  | { readonly kind: 'moved'; readonly nativeId: string; readonly move: { readonly parentId: string; readonly index: number;
    readonly oldParentId: string; readonly oldIndex: number } }
  | { readonly kind: 'removed'; readonly nativeId: string; readonly removal: { readonly parentId: string; readonly index: number;
    readonly node?: BookmarkEventNode | null } }
  | { readonly kind: 'reordered'; readonly nativeId: string; readonly childIds: readonly string[] }
  | { readonly kind: 'children_reordered'; readonly nativeId: string; readonly childIds: readonly string[] };

export type BookmarkCaptureDisposition = 'accepted' | 'filtered' | 'permission_required' | 'not_connected'
  | 'recovery_frozen' | 'queue_unavailable' | 'capture_failed';
export type BookmarkEventRejectedReason = Exclude<BookmarkCaptureDisposition, 'accepted'>;
export type BookmarkCaptureFailureCode = 'operation_schema_invalid' | 'operation_byte_budget_exceeded'
  | 'exact_retry_pending' | 'sequence_missing' | 'scope_missing' | 'queue_recovery_frozen'
  | 'bookmark_event_not_found' | 'bookmark_event_operation_missing' | 'bookmark_event_queue_missing'
  | 'constraint' | 'database_unavailable' | 'privacy_evaluation_failed' | 'parent_identity_failed'
  | 'apply_intent_failed' | 'relative_placement_failed' | 'children_lookup_failed' | 'sibling_identity_failed'
  | 'bookmark_event_stage_failed'
  | 'unknown_capture_failure';

const CAPTURE_FAILURE_CODES = new Set<BookmarkCaptureFailureCode>([
  'operation_schema_invalid', 'operation_byte_budget_exceeded', 'exact_retry_pending', 'sequence_missing',
  'scope_missing', 'queue_recovery_frozen', 'bookmark_event_not_found', 'bookmark_event_operation_missing',
  'bookmark_event_queue_missing', 'constraint', 'database_unavailable', 'privacy_evaluation_failed',
  'parent_identity_failed', 'apply_intent_failed', 'relative_placement_failed', 'children_lookup_failed',
  'sibling_identity_failed', 'bookmark_event_stage_failed',
]);

export interface BookmarkEventsApi {
  readonly onCreated: { addListener(callback: (id: string, node: BookmarkEventNode) => void): void;
    hasListener(callback: (id: string, node: BookmarkEventNode) => void): boolean };
  readonly onChanged: { addListener(callback: (id: string, changes: { readonly title?: string; readonly url?: string }) => void): void;
    hasListener(callback: (id: string, changes: { readonly title?: string; readonly url?: string }) => void): boolean };
  readonly onMoved: { addListener(callback: (id: string, move: { readonly parentId: string; readonly index: number;
    readonly oldParentId: string; readonly oldIndex: number }) => void): void;
    hasListener(callback: (id: string, move: { readonly parentId: string; readonly index: number;
      readonly oldParentId: string; readonly oldIndex: number }) => void): boolean };
  readonly onRemoved: { addListener(callback: (id: string, removal: { readonly parentId: string; readonly index: number;
    readonly node?: BookmarkEventNode | null }) => void): void;
    hasListener(callback: (id: string, removal: { readonly parentId: string; readonly index: number;
      readonly node?: BookmarkEventNode | null }) => void): boolean };
  readonly onChildrenReordered?: { addListener(callback: (id: string, reorderInfo: { readonly childIds: readonly string[] }) => void): void;
    hasListener(callback: (id: string, reorderInfo: { readonly childIds: readonly string[] }) => void): boolean };
}

interface BookmarkListenerOptions {
  readonly bookmarks: () => BookmarkEventsApi | undefined;
  readonly capture: (event: BookmarkCaptureEvent) => Promise<BookmarkCaptureDisposition>;
  /**
   * Invoked when a real browser mutation was observed but could not be staged
   * durably (capture rejection or an unavailable queue). The host schedules a
   * bounded recovery (flush + tree reconcile) so the event is repaired without
   * waiting for the next browser startup. Intentional drops (filtered,
   * permission_required, not_connected) must not schedule it. A recovery freeze
   * defers capture: reconcile only after the engine has finished projection.
   */
  readonly scheduleRecovery?: (reason: BookmarkEventRejectedReason, code?: BookmarkCaptureFailureCode) => void;
}

export function createBookmarkListenerLifecycle(options: BookmarkListenerOptions) {
  let observed = 0; let accepted = 0; let rejected = 0;
  let rejectionReason: BookmarkEventRejectedReason | undefined;
  let captureFailureCode: BookmarkCaptureFailureCode | undefined;
  const inFlight = new Set<Promise<void>>();
  const observe = (event: BookmarkCaptureEvent) => {
    observed = increment(observed);
    // The capture promise stays joinable: MV3 gives no lifetime guarantee to
    // a swallowed promise, and shutdown paths must be able to await ingress.
    const work = Promise.resolve().then(() => options.capture(event)).then((outcome) => {
      if (outcome === 'accepted') { accepted = increment(accepted); return; }
      rejected = increment(rejected); rejectionReason = outcome;
      if (outcome === 'queue_unavailable' || outcome === 'recovery_frozen') options.scheduleRecovery?.(outcome);
    }, (error) => { rejected = increment(rejected); rejectionReason = 'capture_failed';
      captureFailureCode = classifyBookmarkCaptureFailure(error);
      options.scheduleRecovery?.('capture_failed', captureFailureCode); });
    inFlight.add(work);
    void work.then(() => inFlight.delete(work));
  };
  const onCreated = (nativeId: string, node: BookmarkEventNode) => observe({ kind: 'created', nativeId, node });
  const onChanged = (nativeId: string, changes: { readonly title?: string; readonly url?: string }) =>
    observe({ kind: 'changed', nativeId, changes });
  const onMoved = (nativeId: string, move: { readonly parentId: string; readonly index: number;
    readonly oldParentId: string; readonly oldIndex: number }) => observe({ kind: 'moved', nativeId, move });
  const onRemoved = (nativeId: string, removal: { readonly parentId: string; readonly index: number;
    readonly node?: BookmarkEventNode | null }) => observe({ kind: 'removed', nativeId, removal });
  const onChildrenReordered = (nativeId: string, reorderInfo: { readonly childIds: readonly string[] }) =>
    observe({ kind: 'children_reordered', nativeId, childIds: reorderInfo.childIds });
  const installed = (api: BookmarkEventsApi | undefined) => !!api
    && api.onCreated.hasListener(onCreated) && api.onChanged.hasListener(onChanged)
    && api.onMoved.hasListener(onMoved) && api.onRemoved.hasListener(onRemoved)
    && (!api.onChildrenReordered || api.onChildrenReordered.hasListener(onChildrenReordered));
  return Object.freeze({
    install() {
      const api = options.bookmarks(); if (!api) return false;
      // Chrome de-duplicates the same callback; re-adding here repairs optional-permission transitions.
      api.onCreated.addListener(onCreated); api.onChanged.addListener(onChanged);
      api.onMoved.addListener(onMoved); api.onRemoved.addListener(onRemoved);
      api.onChildrenReordered?.addListener(onChildrenReordered);
      return installed(api);
    },
    status() { return { listenerInstalled: installed(options.bookmarks()), eventObserved: observed, eventAccepted: accepted,
      eventRejected: rejected, ...(rejectionReason ? { eventRejectedReason: rejectionReason } : {}),
      ...(captureFailureCode ? { captureFailureCode } : {}) }; },
    pending() { return inFlight.size; },
    async settled() { while (inFlight.size > 0) await Promise.allSettled([...inFlight]); },
  });
}

function increment(value: number) { return Math.min(Number.MAX_SAFE_INTEGER, value + 1); }

export function classifyBookmarkCaptureFailure(error: unknown): BookmarkCaptureFailureCode {
  const candidate = error instanceof Error ? error.message : undefined;
  return candidate && CAPTURE_FAILURE_CODES.has(candidate as BookmarkCaptureFailureCode)
    ? candidate as BookmarkCaptureFailureCode : 'unknown_capture_failure';
}
