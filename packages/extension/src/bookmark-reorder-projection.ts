import { applyLocalReorder, type LocalReorderResult } from './bookmark-event-ingress.js';
import { childOrderFromProjection } from './bookmark-reorder-diff.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

/**
 * SR-08: what one reorder did on this replica, in wire terms.
 *
 * `staged` counts the `move_node` operations that were durably staged for this
 * order, `unmapped`/`excluded` name the children that could not be authored
 * (no mapped identity / locally excluded from sync), and `reserved` names the
 * children whose move was the echo of an in-flight Pull apply and therefore
 * must not be pushed back.
 */
export interface ReorderUplinkReport {
  readonly changed: boolean;
  readonly staged: number;
  readonly retained: number;
  readonly unmapped: readonly string[];
  readonly excluded: readonly string[];
  readonly reserved: readonly string[];
}

export interface ReorderUplinkContext {
  readonly parentNativeId: string;
  readonly childIds: readonly string[];
  readonly previousOrder: readonly string[] | undefined;
}

export type ReorderProjectionCode = 'uplink_staged' | 'unmapped_children' | 'excluded_children'
  | 'reserved_by_pull' | 'no_change' | 'local_projection_only';

/** The diagnostic code that matches the report: never claim more than what happened. */
export function reorderProjectionCode(report: ReorderUplinkReport | undefined): ReorderProjectionCode {
  if (!report) return 'local_projection_only';
  if (report.staged > 0) return 'uplink_staged';
  if (report.unmapped.length > 0) return 'unmapped_children';
  if (report.excluded.length > 0) return 'excluded_children';
  if (report.reserved.length > 0) return 'reserved_by_pull';
  return 'no_change';
}

/**
 * Records a `children_reordered` observation locally and, when an uplink is
 * injected, lets it author the `move_node` batch *before* the projection
 * baseline is rewritten — the uplink diffs the new order against the baseline
 * this function is about to replace.
 *
 * The local projection update is deliberately unconditional (a replica that
 * cannot upload still benefits from a consistent local order), and the
 * diagnostic states exactly what the uplink did (`local_projection_only` is now
 * reserved for callers that did not attempt an uplink at all).
 */
export async function projectChildrenReordered(input: {
  readonly scope: SyncScope; readonly store: ReturnType<typeof createSyncStateStore>;
  readonly parentNativeId: string; readonly childIds: readonly string[];
  readonly uplink?: (context: ReorderUplinkContext) =>
    Promise<ReorderUplinkReport | undefined> | ReorderUplinkReport | undefined;
}): Promise<{ readonly outcome: 'projected' | 'filtered'; readonly code: ReorderProjectionCode;
  readonly local: LocalReorderResult }> {
  const mapping = await input.store.getMappingByNativeId(input.scope, input.parentNativeId);
  if (!mapping) return { outcome: 'filtered', code: 'local_projection_only',
    local: { outcome: 'unmapped', changed: false } };
  const previousOrder = childOrderFromProjection(mapping.projection);
  const report = await input.uplink?.({ parentNativeId: input.parentNativeId,
    childIds: [...input.childIds], previousOrder });
  const local = await applyLocalReorder(input.store, input.scope, input.parentNativeId, input.childIds,
    report ? { staged: report.staged, unmapped: report.unmapped, excluded: report.excluded } : undefined);
  const code = reorderProjectionCode(report);
  await input.store.putScopeDiagnostic(input.scope, { kind: 'children_reordered', code,
    nativeId: input.parentNativeId, details: { childCount: input.childIds.length,
      ...(report ? { moveCount: report.staged, retainedCount: report.retained,
        unmappedCount: report.unmapped.length, excludedCount: report.excluded.length,
        reservedCount: report.reserved.length } : {}) } });
  return { outcome: 'projected', code, local };
}
