import type { EventDependency } from './bookmark-event-heal.js';
import type { BookmarkEventParkMarker, BookmarkEventParkState } from './sync-state/types.js';
import type { BookmarkEventRecord, JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

/**
 * F003: durable quarantine bookkeeping for poison inbox events.
 *
 * A pending event that cannot be prepared is *skipped* (never a `break`), and
 * after `MAX_PREPARE_FAILURES` consecutive failed rounds — or immediately when
 * its dependency is already a permanently refused operation or a parked event —
 * it is marked `parked`. A parked event is not prepared at all, so it cannot
 * hold back the events behind it; its row is never deleted or rewritten, so no
 * data is lost and the reason/attempt count stay observable.
 *
 * The marker lives on the event's ingress diagnostic row; quarantined events
 * remain unchanged. The diagnostic id is derived from the event id, so the
 * marker upserts in place and stays bounded to one row per quarantined event.
 */
export const MAX_PREPARE_FAILURES = 5;
export const PARK_MARKER_PREFIX = 'park:';
export function bookmarkEventErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : error.message;
}
type ParkStore = Pick<ReturnType<typeof createSyncStateStore>,
  'pruneParkDiagnostics' | 'putIngressDiagnostic' | 'putScopeDiagnostic'>;

export function createBookmarkEventQuarantine(input: {
  readonly scope: SyncScope; readonly store: ParkStore; readonly now: () => string;
}) {
  /**
   * Park markers are keyed by the quarantined event id. Markers whose event has
   * left the inbox are pruned in the same call: the marker ledger is otherwise
   * one row per parked event that never goes away, and the ingress diagnostic
   * range it shares has a bounded scan budget.
   */
  async function load(liveEventIds: ReadonlySet<string>): Promise<Map<string, BookmarkEventParkMarker>> {
    return new Map(await input.store.pruneParkDiagnostics(input.scope, liveEventIds));
  }

  /** Counts a failed prepare round without isolating the event yet. */
  async function track(event: BookmarkEventRecord, decision: { readonly attempts: number;
    readonly reason: string; readonly dependency: EventDependency }): Promise<void> {
    await write(event, { ...decision, state: 'open', code: decision.reason });
  }

  /**
   * Isolates the event. Returns false when the marker could not be persisted —
   * the caller surfaces that as a real failure instead of assuming quarantine.
   */
  async function park(event: BookmarkEventRecord, decision: { readonly attempts: number;
    readonly code: string; readonly reason?: string; readonly dependency?: EventDependency;
    readonly stamp?: string }): Promise<boolean> {
    try {
      await write(event, { state: 'parked', code: decision.code, attempts: decision.attempts,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.dependency === undefined ? {} : { dependency: decision.dependency }),
        ...(decision.stamp === undefined ? {} : { stamp: decision.stamp }) });
    } catch { return false; }
    // The engine/ops attention channel. Best effort: the marker above is the
    // durable evidence even if this diagnostic write fails.
    try { await input.store.putScopeDiagnostic(input.scope, { kind: 'bookmark_event_park',
      code: decision.code, nativeId: event.nativeId, details: parkDetails(event, decision) }); }
    catch { /* the ingress marker already carries the evidence */ }
    return true;
  }

  /** Reopens a parked event whose recorded dependency stamp changed. */
  async function reopen(event: BookmarkEventRecord, marker: BookmarkEventParkMarker): Promise<void> {
    await write(event, { state: 'open', code: marker.code, attempts: 0,
      ...(marker.reason === undefined ? {} : { reason: marker.reason }),
      ...(marker.dependencyNativeId === undefined ? {} : { dependencyNativeId: marker.dependencyNativeId }),
      ...(marker.dependencyOpId === undefined ? {} : { dependencyOpId: marker.dependencyOpId }),
      ...(marker.dependencyEventId === undefined ? {} : { dependencyEventId: marker.dependencyEventId }),
      ...(marker.dependencyStamp === undefined ? {} : { stamp: marker.dependencyStamp }) });
  }

  async function write(event: BookmarkEventRecord, marker: { readonly state: BookmarkEventParkState;
    readonly code: string; readonly attempts: number; readonly reason?: string;
    readonly dependency?: EventDependency; readonly dependencyNativeId?: string; readonly dependencyOpId?: string;
    readonly dependencyEventId?: string; readonly stamp?: string }): Promise<void> {
    const dependencyNativeId = marker.dependencyNativeId ?? marker.dependency?.nativeId;
    const dependencyOpId = marker.dependencyOpId ?? marker.dependency?.opId;
    const dependencyEventId = marker.dependencyEventId ?? marker.dependency?.eventId;
    const park: BookmarkEventParkMarker = { eventId: event.eventId, state: marker.state, code: marker.code,
      attempts: marker.attempts, at: input.now(),
      ...(marker.reason === undefined ? {} : { reason: marker.reason }),
      ...(dependencyNativeId === undefined ? {} : { dependencyNativeId }),
      ...(dependencyOpId === undefined ? {} : { dependencyOpId }),
      ...(dependencyEventId === undefined ? {} : { dependencyEventId }),
      ...(marker.stamp === undefined ? {} : { dependencyStamp: marker.stamp }) };
    await input.store.putIngressDiagnostic(input.scope, { code: `${PARK_MARKER_PREFIX}${event.eventId}`, park });
  }

  function parkDetails(event: BookmarkEventRecord, decision: { readonly attempts: number;
    readonly code: string; readonly dependency?: EventDependency; readonly stamp?: string }): JsonObject {
    return { eventId: event.eventId, attempts: decision.attempts, code: decision.code,
      ...(decision.dependency?.nativeId === undefined ? {} : { dependencyNativeId: decision.dependency.nativeId }),
      ...(decision.dependency?.opId === undefined ? {} : { dependencyOpId: decision.dependency.opId }),
      ...(decision.dependency?.eventId === undefined ? {} : { dependencyEventId: decision.dependency.eventId }),
      ...(decision.stamp === undefined ? {} : { dependencyStamp: decision.stamp }) };
  }

  return Object.freeze({ load, track, park, reopen });
}

/** The dependency recorded on a marker, when it has one to wait for. */
export function markerDependency(marker: BookmarkEventParkMarker): EventDependency | undefined {
  if (marker.dependencyNativeId === undefined) return undefined;
  return { nativeId: marker.dependencyNativeId,
    ...(marker.dependencyOpId === undefined ? {} : { opId: marker.dependencyOpId }),
    ...(marker.dependencyEventId === undefined ? {} : { eventId: marker.dependencyEventId }) };
}

/**
 * The quarantine state of the *blocking* event, when the dependency is another
 * inbox event: a dependent of a parked event parks immediately, and reopens
 * when that event leaves quarantine.
 */
export function blockerParkState(markers: ReadonlyMap<string, BookmarkEventParkMarker>,
  dependency: EventDependency): BookmarkEventParkState | undefined {
  return dependency.eventId === undefined ? undefined : markers.get(dependency.eventId)?.state;
}
