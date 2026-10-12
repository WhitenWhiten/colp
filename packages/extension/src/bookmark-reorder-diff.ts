/**
 * SR-08 planning for a same-parent reorder, without any storage or Chrome access.
 *
 * A Chrome drag reorders the local tree as a *sequence*: every child keeps its
 * identity and only relative positions change. The wire, however, can only
 * express one placement at a time (`newParentId` + `afterId`/`beforeId`), and
 * every redundant `move_node` costs a push round trip (and, for the same
 * parent, a stale `childrenRevision` retry). The planner therefore answers two
 * questions with the smallest defensible op set:
 *
 * - which children actually need a `move_node` (everything outside a longest
 *   increasing subsequence of the new order relative to the last known order),
 * - and which children cannot be authored at all (no mapped identity).
 *
 * Convergence argument for the emitted set (`planReorderPlacements`): the
 * retained ids keep their relative order on every replica, every moved id is
 * placed against a retained id (never against a sibling that also moves), and
 * the per-gap emission order below makes those placements compose into exactly
 * the target order. A replica already at the target order treats every op as a
 * no-op.
 */

/** The projection field that records the last order this replica authored/saw. */
export const CHILD_ORDER_FIELD = 'childrenOrder';

/** One child whose position has to be asserted on the wire. */
export interface ChildOrderMove {
  readonly nativeId: string;
  /** Position in the order passed to `diffChildOrder`. */
  readonly index: number;
  /** Position in the previously known order, or undefined when it was unknown. */
  readonly previousIndex: number | undefined;
}

export interface ChildOrderPlan {
  readonly changed: boolean;
  readonly moves: readonly ChildOrderMove[];
  /** Ids that keep their relative order (a longest increasing subsequence). */
  readonly retained: readonly string[];
}

/** One moved child and the retained child it is placed against. */
export interface ChildOrderPlacement {
  readonly nativeId: string;
  readonly anchor: { readonly afterNativeId?: string; readonly beforeNativeId?: string };
}

/**
 * Reads the persisted sibling order from a mapping projection. Anything that is
 * not a plain string array is treated as "no baseline" instead of crashing a
 * capture: an upgraded or corrupt profile simply re-asserts the full order.
 */
export function childOrderFromProjection(content: unknown): readonly string[] | undefined {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return undefined;
  const value = (content as Record<string, unknown>)[CHILD_ORDER_FIELD];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return value as readonly string[];
}

export function sameChildOrder(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined || left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

/**
 * Indices of one longest strictly increasing subsequence of `values`
 * (patience sorting; O(n log n)). Ties resolve toward the earliest values,
 * which keeps the retained set stable for equal-cost choices.
 */
export function longestIncreasingSubsequence(values: readonly number[]): number[] {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    let low = 0; let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1; else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  }
  const result: number[] = [];
  let cursor = tails.length > 0 ? tails[tails.length - 1]! : -1;
  while (cursor >= 0) { result.push(cursor); cursor = previous[cursor]!; }
  return result.reverse();
}

/**
 * Minimal move set that turns `previousOrder` into `nextOrder`.
 *
 * `undefined` means "this replica has no recorded order for the parent": then
 * nothing is known to stay put, and the plan degenerates to a chain from the
 * first child (the minimal way to re-assert a total order). The retained set is
 * never empty while something moves — it is the anchor set, and a moved child
 * with no retained sibling left would have nothing stable to be placed against.
 */
export function diffChildOrder(previousOrder: readonly string[] | undefined,
  nextOrder: readonly string[]): ChildOrderPlan {
  const positions = new Map((previousOrder ?? []).map((nativeId, index) => [nativeId, index] as const));
  const known: number[] = []; const knownAt: number[] = [];
  nextOrder.forEach((nativeId, index) => {
    const position = positions.get(nativeId);
    if (position === undefined) return;
    known.push(position); knownAt.push(index);
  });
  const retained = new Set(longestIncreasingSubsequence(known).map((index) => nextOrder[knownAt[index]!]!));
  if (retained.size === 0 && nextOrder.length > 0) retained.add(nextOrder[0]!);
  const moves = nextOrder.flatMap((nativeId, index) => retained.has(nativeId) ? []
    : [{ nativeId, index, previousIndex: positions.get(nativeId) }]);
  return { changed: moves.length > 0, moves, retained: [...retained] };
}

/**
 * Anchors every moved child to a child that does *not* move, and returns them in
 * the order they must be applied.
 *
 * Anchoring to a sibling that is itself part of the batch cannot work: `moved()`
 * resolves an anchor through its optimistic identity, so a node whose mapping
 * still carries the just-committed `local-*` revision holds the next operation
 * (`dependency_pending`) until a receipt confirms it — and a "B before C" +
 * "C after B" pair never moves either of them past the retained children.
 *
 * Placement rule per gap: the children in the gap *before* the first retained
 * child are placed forward (`m1 before S`, then `m2 before S`, ...), and the
 * children in a gap *after* a retained child are placed in reverse target order
 * (rightmost first), because every one of them is inserted directly after that
 * same retained child.
 */
export function planReorderPlacements(input: { readonly order: readonly string[]; readonly retained: readonly string[];
  readonly moved: readonly string[] }): readonly ChildOrderPlacement[] {
  const at = new Map(input.order.map((nativeId, index) => [nativeId, index] as const));
  const stayers = input.retained.map((nativeId) => ({ nativeId, at: at.get(nativeId) ?? -1 }))
    .filter((stayer) => stayer.at >= 0).sort((left, right) => left.at - right.at);
  const first = stayers[0];
  if (!first) return input.moved.map((nativeId) => ({ nativeId, anchor: {} }));
  const gap0: ChildOrderPlacement[] = [];
  const gaps = new Map<string, ChildOrderPlacement[]>();
  for (const nativeId of input.moved) {
    const index = at.get(nativeId) ?? -1;
    const preceding = [...stayers].reverse().find((stayer) => stayer.at < index);
    if (!preceding) { gap0.push({ nativeId, anchor: { beforeNativeId: first.nativeId } }); continue; }
    const gap = gaps.get(preceding.nativeId) ?? [];
    gap.push({ nativeId, anchor: { afterNativeId: preceding.nativeId } });
    gaps.set(preceding.nativeId, gap);
  }
  const placement = [...gap0];
  for (const stayer of stayers) placement.push(...(gaps.get(stayer.nativeId) ?? []).reverse());
  return placement;
}
