import { childOrderFromProjection, sameChildOrder } from './bookmark-reorder-diff.js';
import type { BookmarkEventNode } from './bookmark-event-codec.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Apply a captured placement to the known order without reading a newer native tree. */
export function placedChildOrder(previous: readonly string[], nativeId: string,
  anchor: { readonly afterNativeId?: string; readonly beforeNativeId?: string; readonly index?: number }): string[] {
  const next = previous.filter(id => id !== nativeId);
  const after = anchor.afterNativeId ? next.indexOf(anchor.afterNativeId) : -1;
  const before = anchor.beforeNativeId ? next.indexOf(anchor.beforeNativeId) : -1;
  const index = after >= 0 ? after + 1 : before >= 0 ? before
    : anchor.index === undefined ? 0 : Math.min(anchor.index, next.length);
  next.splice(Math.max(0, index), 0, nativeId); return next;
}

/** Additions/removals alone do not prove that existing siblings were reordered. */
export function relativeChildOrderChanged(previous: readonly string[], next: readonly string[]): boolean {
  const before = new Set(previous); const after = new Set(next);
  return !sameChildOrder(previous.filter(id => after.has(id)), next.filter(id => before.has(id)));
}

/** Recover only from two matching reads; a moving tree is retried on the next wake. */
export async function recoverChildOrder(input: {
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope;
  readonly parentNativeId: string;
  readonly readChildren: (id: string) => Promise<readonly BookmarkEventNode[]>;
  readonly reordered: (id: string, children: readonly string[]) => Promise<unknown>;
}): Promise<void> {
  const mapping = await input.store.getMappingByNativeId(input.scope, input.parentNativeId);
  if (!mapping) return;
  const previous = childOrderFromProjection(mapping.projection);
  const first = (await input.readChildren(input.parentNativeId)).map(node => node.id);
  const second = (await input.readChildren(input.parentNativeId)).map(node => node.id);
  if (!sameChildOrder(first, second)) return;
  if (previous && relativeChildOrderChanged(previous, second)) {
    await input.reordered(input.parentNativeId, second); return;
  }
  // A legacy profile has no historical ordering evidence. Seed its first stable
  // observation without inventing a move; future missed callbacks are recoverable.
  if (sameChildOrder(previous, second)) return;
  const current = await input.store.getMappingByNativeId(input.scope, mapping.nativeId);
  if (!current || !sameChildOrder(previous ?? [], childOrderFromProjection(current.projection) ?? [])) return;
  const { scopeKey: _key, ...rest } = current;
  await input.store.putMapping(input.scope, { ...rest,
    projection: { ...current.projection, childrenOrder: second } } satisfies MappingInput);
}
