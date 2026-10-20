import { digestJson } from './bookmark-event-codec.js';
import { placedChildOrder, relativeChildOrderChanged } from './bookmark-child-order.js';
import { childOrderFromProjection, sameChildOrder } from './bookmark-reorder-diff.js';
import { applyRejoinMutation, type RejoinChrome } from './scope-rejoin-mutation.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import type { MappingInput, MountBindingRecord, RemoteObservationRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

export type RejoinOrderInput = RejoinChrome & {
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope; readonly mount: MountBindingRecord;
};
export interface RejoinOrderPlan {
  readonly parent: MappingInput; readonly baseline: readonly string[];
  readonly local: readonly string[]; readonly remote: readonly string[];
  readonly commandId: string; readonly token: string; readonly conflict: boolean;
}

/** Compare relative ordering as a separate domain from bookmark title/url and parent identity. */
export async function planRejoinOrders(input: RejoinOrderInput, mappings: readonly MappingInput[],
  observations: readonly RemoteObservationRecord[]): Promise<RejoinOrderPlan[]> {
  if (!input.getChildren) return [];
  const byColp = new Map(mappings.map(row => [row.colpId, row]));
  const plans: RejoinOrderPlan[] = [];
  for (const parent of mappings) {
    const baseline = childOrderFromProjection(parent.projection);
    if (!baseline || parent.nodeKind !== 'folder' || isNonChromeNativeId(parent.nativeId)
      || !await input.getNative(parent.nativeId)) continue;
    const moves = observations.filter(row => row.payload.parentId === parent.colpId
      && (row.payload.afterId !== undefined || row.payload.beforeId !== undefined)
      && byColp.get(row.colpId)?.parentColpId === parent.colpId)
      .sort((left, right) => left.observedAt - right.observedAt);
    if (!moves.length) continue;
    let remote = [...baseline];
    for (const move of moves) {
      const nativeId = byColp.get(move.colpId)!.nativeId;
      const after = typeof move.payload.afterId === 'string' ? byColp.get(move.payload.afterId) : undefined;
      const before = typeof move.payload.beforeId === 'string' ? byColp.get(move.payload.beforeId) : undefined;
      remote = placedChildOrder(remote, nativeId, { ...(after ? { afterNativeId: after.nativeId } : {}),
        ...(before ? { beforeNativeId: before.nativeId } : {}) });
    }
    const local = (await input.getChildren(parent.nativeId)).map(node => node.id);
    if (!relativeChildOrderChanged(baseline, remote)) continue;
    const ambiguous = moves.some((move, index) => index > 0 && moves[index - 1]!.observedAt === move.observedAt);
    const conflict = ambiguous || relativeChildOrderChanged(baseline, local) && relativeChildOrderChanged(remote, local);
    plans.push({ parent, baseline, local, remote, conflict,
      commandId: `rejoin-order:${input.mount.mountId}:${parent.colpId}`,
      token: digestJson({ pause: input.mount.pauseBaseline ? { ...input.mount.pauseBaseline } : null, parentId: parent.colpId,
        baseline: [...baseline], local, remote, observations: moves.map(row => row.sourceDigest) }) });
  }
  return plans;
}

export async function applyRejoinOrder(input: RejoinOrderInput, plan: RejoinOrderPlan,
  target: readonly string[]): Promise<void> {
  if (!input.getChildren || !input.moveNative) throw new Error('rejoin_order_api_unavailable');
  const liveIds = new Set(plan.local);
  // Preserve unrelated/new local children while ordering the common known siblings.
  const wanted = target.filter(id => liveIds.has(id));
  let expected = [...plan.local];
  for (let index = 0; index < wanted.length; index++) {
    const current = (await input.getChildren(plan.parent.nativeId)).map(node => node.id);
    if (!sameChildOrder(current, expected)) throw new Error('rejoin_order_changed');
    const nativeId = wanted[index]!;
    if (current[index] === nativeId) continue;
    const mapping = await input.store.getMappingByNativeId(input.scope, nativeId);
    const before = await input.getNative(nativeId);
    if (!mapping || !before) throw new Error('rejoin_order_changed');
    await applyRejoinMutation(input, mapping, 'move', { parentId: plan.parent.nativeId, index }, before);
    expected = placedChildOrder(current, nativeId, { index });
  }
  const current = await input.store.getMappingByNativeId(input.scope, plan.parent.nativeId);
  if (!current) throw new Error('rejoin_order_changed');
  const { scopeKey: _key, ...rest } = current;
  await input.store.putMapping(input.scope, { ...rest, projection: { ...current.projection, childrenOrder: expected } });
}

export async function reconcileRejoinOrders(input: RejoinOrderInput, mappings: readonly MappingInput[],
  observations: readonly RemoteObservationRecord[]): Promise<number> {
  let conflicts = 0;
  for (const plan of await planRejoinOrders(input, mappings, observations)) {
    if (plan.conflict) {
      await input.store.beginScopeCommandPlan(input.scope, { commandId: plan.commandId, kind: 'rejoin',
        confirmationVersion: input.mount.boundaryVersion, baselineDigest: plan.token, phase: 'pending',
        dependencies: [], mountId: input.mount.mountId, retryReason: 'rejoin_order_conflict', updatedAt: Date.now() });
      conflicts++; continue;
    }
    await applyRejoinOrder(input, plan, plan.remote);
  }
  return conflicts;
}
