import { digestJson } from './bookmark-event-codec.js';
import { recordIngressDiagnostic } from './bookmark-event-ingress.js';
import { childOrderFromProjection, diffChildOrder, planReorderPlacements,
  sameChildOrder } from './bookmark-reorder-diff.js';
import { projectChildrenReordered } from './bookmark-reorder-projection.js';
import { nativeIsLocallyExcluded } from './remote-delete-exclusion.js';
import type { BookmarkEventRecord, JsonObject, MappingInput, SyncScope,
  createSyncStateStore } from './sync-state-store.js';

/**
 * SR-08: the same-parent reorder uplink.
 *
 * Chrome reports a drag as a *burst* of `onChildrenReordered` events, one per
 * intermediate order. Staging a `move_node` batch per event would push several
 * contradictory orders and, because every same-parent move bumps the parent's
 * `childrenRevision` server-side, every extra batch costs stale-revision retry
 * cycles. The uplink therefore persists one target order per parent and
 * merges the burst into a single batch inside `flush()` (the queue's existing
 * "stage, then commit" rhythm); the injected `scheduleFlush` only decides when
 * that flush happens, so tests drive the window deterministically.
 *
 * A reorder that produces no authorable move (unchanged order, unmapped
 * children, or a Pull-apply echo) is recorded locally right away with an honest
 * diagnostic instead of entering the durable buffer.
 */
export interface ReorderUplinkIdentity {
  readonly nativeId: string;
  readonly colpId: string;
  readonly revision: string;
  readonly childrenRevision?: string;
  readonly rootNativeId: string;
  readonly content: JsonObject | null;
  readonly nodeKind?: MappingInput['nodeKind'];
  readonly parentNativeId?: string;
}

export interface ReorderUplinkHost {
  readonly store: ReturnType<typeof createSyncStateStore>;
  readonly scope: SyncScope;
  readonly uuid: () => string;
  identityFor(nativeId: string, events?: readonly BookmarkEventRecord[]): Promise<ReorderUplinkIdentity | null>;
  /** Stages one `move_node` inbox event without flushing (the drain already runs inside `flush()`). */
  stageMove(nativeId: string, details: JsonObject, eventId: string): Promise<{ readonly outcome: string }>;
  /** `moved()`'s Pull-apply echo guard, keyed exactly like the applier's own correlation digest. */
  hasApplyIntent(nativeId: string, details: JsonObject): Promise<boolean>;
  listPendingEvents(): Promise<readonly BookmarkEventRecord[]>;
  /** Called once per buffered window; the host decides the delay (injectable in tests). */
  scheduleFlush(): void;
}

interface ReorderMove {
  readonly nativeId: string; readonly index: number; readonly previousIndex: number | undefined;
  readonly anchor: { readonly afterNativeId?: string; readonly beforeNativeId?: string };
}

interface MovePlan {
  readonly moves: readonly ReorderMove[];
  readonly retained: readonly string[];
  readonly unmapped: readonly string[];
  readonly excluded: readonly string[];
  readonly reserved: readonly string[];
  readonly identities: ReadonlyMap<string, ReorderUplinkIdentity>;
}

export const REORDER_DEBOUNCE_MS = 300;

/**
 * Closes the reorder merge window. `setTimeout` is only the production default:
 * the host may inject `scheduleReorderFlush` (tests fire the window by hand, so
 * no assertion depends on wall-clock timing).
 */
export function reorderFlushTimer(flush: () => Promise<void>,
  schedule?: (flush: () => void, delayMs: number) => void, delayMs = REORDER_DEBOUNCE_MS): void {
  const arm = schedule ?? ((work: () => void, delay: number) => { setTimeout(work, delay); });
  arm(() => { void flush(); }, delayMs);
}

export function createReorderUplink(input: ReorderUplinkHost) {
  let tail: Promise<unknown> = Promise.resolve();
  let flushScheduled = false;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work); tail = next.catch(() => undefined); return next;
  };

  /**
   * The capture half: decide whether this order needs an uplink at all. The
   * plan (and its Pull-apply echo guard) is computed now so the returned
   * outcome is honest, then merged with any later order for the same parent.
   */
  async function capture(parentNativeId: string, childIds: readonly string[]):
  Promise<{ readonly outcome: 'staged' | 'filtered' }> {
    const mapping = await input.store.getMappingByNativeId(input.scope, parentNativeId);
    const previousOrder = childOrderFromProjection(mapping?.projection);
    if (sameChildOrder(previousOrder, childIds)) {
      await input.store.deletePendingReorder(input.scope, parentNativeId); return { outcome: 'filtered' };
    }
    // Legacy baselines (pre-`childrenOrder` builds) stored only this digest.
    if (previousOrder === undefined && mapping?.projection.digest === digestJson([...childIds])) {
      await input.store.deletePendingReorder(input.scope, parentNativeId); return { outcome: 'filtered' };
    }
    const identity = await input.identityFor(parentNativeId);
    if (!identity) {
      await input.store.deletePendingReorder(input.scope, parentNativeId);
      await recordIngressDiagnostic(input.store, input.scope, 'reorder_children_unmapped');
      return { outcome: 'filtered' };
    }
    const plan = await planMoves(parentNativeId, childIds, previousOrder);
    if (plan.moves.length === 0) {
      await input.store.deletePendingReorder(input.scope, parentNativeId);
      await recordPlanOnly(parentNativeId, childIds, plan);
      return { outcome: 'filtered' };
    }
    const moves = plan.moves.flatMap(move => {
      const child = plan.identities.get(move.nativeId); if (!child) return [];
      const eventId = input.uuid();
      return [{ nativeId: move.nativeId, eventId,
        details: moveDetails(parentNativeId, identity, child, anchorWire(move, plan.identities), eventId) }];
    });
    await input.store.putPendingReorder(input.scope, { parentNativeId, childIds: [...childIds],
      version: input.uuid(), moves, retained: plan.retained.length, unmapped: plan.unmapped,
      excluded: plan.excluded, reserved: plan.reserved });
    if (!flushScheduled) { flushScheduled = true; input.scheduleFlush(); }
    return { outcome: 'staged' };
  }

  /**
   * Out-of-boundary parents keep their previous behaviour (the local projection
   * stays consistent) without ever authoring an operation.
   */
  async function captureLocalOnly(parentNativeId: string, childIds: readonly string[]): Promise<void> {
    await input.store.deletePendingReorder(input.scope, parentNativeId);
    await projectChildrenReordered({ scope: input.scope, store: input.store, parentNativeId,
      childIds: [...childIds] });
  }

  /**
   * The flush half: one merged batch per parent, staged before the queue's
   * commit loop reads the inbox so the moves commit in this same round.
   */
  async function drain(): Promise<boolean> {
    flushScheduled = false;
    let staged = false;
    for (const entry of await input.store.listPendingReorders(input.scope)) {
      let count = 0;
      for (const move of entry.moves) {
        const result = await input.stageMove(move.nativeId, move.details, move.eventId);
        if (result.outcome !== 'staged' && result.outcome !== 'duplicate') throw new Error('reorder_stage_deferred');
        count += 1;
      }
      await projectChildrenReordered({ scope: input.scope, store: input.store, parentNativeId: entry.parentNativeId,
        childIds: entry.childIds, uplink: () => ({ changed: true, staged: count, retained: entry.retained,
          unmapped: entry.unmapped, excluded: entry.excluded, reserved: entry.reserved }) });
      await input.store.deletePendingReorder(input.scope, entry.parentNativeId, entry.version);
      staged ||= count > 0;
    }
    return staged;
  }

  async function planMoves(parentNativeId: string, childIds: readonly string[],
    previousOrder: readonly string[] | undefined): Promise<MovePlan> {
    const events = await input.listPendingEvents();
    const identities = new Map<string, ReorderUplinkIdentity>();
    const eligible: string[] = []; const unmapped: string[] = []; const excluded: string[] = [];
    for (const nativeId of childIds) {
      if (identities.has(nativeId)) { eligible.push(nativeId); continue; }
      const identity = await input.identityFor(nativeId, events);
      if (!identity) { unmapped.push(nativeId); continue; }
      if (await nativeIsLocallyExcluded(input.store, input.scope, nativeId, [parentNativeId])) {
        excluded.push(nativeId); continue;
      }
      identities.set(nativeId, identity); eligible.push(nativeId);
    }
    const previousEligible = previousOrder?.filter((nativeId) => identities.has(nativeId));
    const plan = diffChildOrder(previousOrder === undefined ? undefined : previousEligible, eligible);
    // The wire position and the Pull-applier correlation both live in the *full*
    // child order (Chrome indexes every sibling, mapped or not); the LIS ran on
    // the eligible subsequence, so map back before staging.
    const fullIndex = new Map(childIds.map((nativeId, index) => [nativeId, index] as const));
    const previousIndex = new Map((previousOrder ?? []).map((nativeId, index) => [nativeId, index] as const));
    const reserved: string[] = []; const stagedable = new Set<string>();
    for (const move of plan.moves) {
      const index = fullIndex.get(move.nativeId) ?? move.index;
      const prior = previousIndex.get(move.nativeId);
      if (prior !== undefined && await input.hasApplyIntent(move.nativeId, { parentId: parentNativeId,
        index, oldParentId: parentNativeId, oldIndex: prior })) {
        reserved.push(move.nativeId); continue;
      }
      stagedable.add(move.nativeId);
    }
    const moves = planReorderPlacements({ order: childIds, retained: plan.retained,
      moved: plan.moves.map((move) => move.nativeId).filter((nativeId) => stagedable.has(nativeId)) })
      .map((placement) => ({ ...placement, index: fullIndex.get(placement.nativeId) ?? 0,
        previousIndex: previousIndex.get(placement.nativeId) }));
    return { moves, retained: plan.retained, unmapped, excluded, reserved, identities };
  }

  /**
   * `placement()`'s wire shape (`afterId`/`beforeId` over colpIds plus the
   * `moved()` context fields), resolved from the event's own order instead of a
   * second Chrome read: the event *is* the target order, and re-reading Chrome at
   * flush time could anchor this batch against a tree another operation already
   * changed. Which sibling to anchor to is `planReorderPlacements`' decision.
   */
  function anchorWire(move: ReorderMove, identities: ReadonlyMap<string, ReorderUplinkIdentity>):
  { readonly wire: JsonObject; readonly afterNativeId?: string; readonly beforeNativeId?: string } {
    const colpId = (nativeId: string) => identities.get(nativeId)?.colpId;
    const after = move.anchor.afterNativeId === undefined ? undefined : colpId(move.anchor.afterNativeId);
    const before = move.anchor.beforeNativeId === undefined ? undefined : colpId(move.anchor.beforeNativeId);
    return { wire: { ...(after ? { afterId: after } : {}), ...(before ? { beforeId: before } : {}) },
      ...(move.anchor.afterNativeId ? { afterNativeId: move.anchor.afterNativeId } : {}),
      ...(move.anchor.beforeNativeId ? { beforeNativeId: move.anchor.beforeNativeId } : {}) };
  }

  /** Same operation/context/mapping shape as `moved()`, with source === target parent. */
  function moveDetails(parentNativeId: string, parent: ReorderUplinkIdentity, identity: ReorderUplinkIdentity,
    relative: { readonly wire: JsonObject; readonly afterNativeId?: string; readonly beforeNativeId?: string },
    eventId: string): JsonObject {
    return { operation: { type: 'move_node', targetId: identity.colpId, baseRevision: identity.revision,
      dependencies: [], payload: { newParentId: parent.colpId, ...relative.wire,
        baseSourceParentRevision: parent.childrenRevision ?? `local-${eventId}`,
        baseTargetParentRevision: parent.childrenRevision ?? `local-${eventId}` } },
    context: { sourceParentNativeId: parentNativeId, targetParentNativeId: parentNativeId,
      ...(relative.afterNativeId ? { afterNativeId: relative.afterNativeId } : {}),
      ...(relative.beforeNativeId ? { beforeNativeId: relative.beforeNativeId } : {}) },
    mapping: { nativeId: identity.nativeId, colpId: identity.colpId, rootNativeId: parent.rootNativeId,
      ...(identity.nodeKind ? { nodeKind: identity.nodeKind } : {}), parentNativeId,
      projection: { revision: `local-${eventId}`,
        ...(identity.childrenRevision ? { childrenRevision: identity.childrenRevision } : {}),
        digest: identity.content ? digestJson(identity.content) : 'sha256:projection-unknown',
        ...(identity.content ? { content: identity.content } : {}) } } };
  }

  /** Records the order locally with the report of why nothing was authored. */
  async function recordPlanOnly(parentNativeId: string, childIds: readonly string[],
    plan: MovePlan): Promise<void> {
    await projectChildrenReordered({ scope: input.scope, store: input.store, parentNativeId, childIds: [...childIds],
      uplink: () => ({ changed: true, staged: 0, retained: plan.retained.length, unmapped: plan.unmapped,
        excluded: plan.excluded, reserved: plan.reserved }) });
  }

  return Object.freeze({
    capture: (parent: string, children: readonly string[]) => serial(() => capture(parent, children)),
    captureLocalOnly: (parent: string, children: readonly string[]) => serial(() => captureLocalOnly(parent, children)),
    drain: () => serial(drain),
  });
}
