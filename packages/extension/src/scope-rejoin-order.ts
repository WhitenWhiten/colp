import { digestJson } from './bookmark-event-codec.js';
import { placedChildOrder, relativeChildOrderChanged } from './bookmark-child-order.js';
import { remoteChildren, remoteFactsDigest, rejoinAuthority, rejoinBoundaryDigest, rejoinAttemptDigest } from './scope-rejoin-authority.js';
import { childOrderFromProjection, sameChildOrder } from './bookmark-reorder-diff.js';
import { applyRejoinMutation, type RejoinChrome } from './scope-rejoin-mutation.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { rejoinOrderProgress } from './scope-rejoin-order-progress.js';
import type { MappingInput, MountBindingRecord, RemoteObservationRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

export type RejoinOrderInput = RejoinChrome & {
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope; readonly mount: MountBindingRecord;
};
export interface RejoinOrderPlan {
  readonly parent: MappingInput; readonly baseline: readonly string[];
  readonly local: readonly string[]; readonly remote: readonly string[];
  readonly commandId: string; readonly token: string; readonly conflict: boolean;
  readonly authorityDigest: string | null; readonly childrenRevision?: string; readonly boundaryDigest: string;
  readonly nativeParentId?: string | null;
}

/** Compare relative ordering as a separate domain from bookmark title/url and parent identity. */
export async function planRejoinOrders(input: RejoinOrderInput, mappings: readonly MappingInput[],
  observations: readonly RemoteObservationRecord[], includeParentId?: string): Promise<RejoinOrderPlan[]> {
  if (!input.getChildren) return [];
  const byColp = new Map(mappings.map(row => [row.colpId, row]));
  const snapshot = await rejoinAuthority(input);
  const recorded = await input.store.getScope(input.scope);
  const boundaryDigest = rejoinBoundaryDigest(recorded);
  const plans: RejoinOrderPlan[] = [];
  const deleted = new Set(observations.filter(row => row.kind === 'tombstone').map(row => row.colpId));
  for (const parent of mappings) {
    // A proven cloud deletion is a local disposition decision. A missing
    // parent in an incomplete/unknown snapshot alone does not prove deletion.
    if (deleted.has(parent.colpId)) continue;
    const baseline = childOrderFromProjection(parent.projection);
    if (!baseline || parent.nodeKind !== 'folder' || isNonChromeNativeId(parent.nativeId)) continue;
    const nativeParent = await input.getNative(parent.nativeId);
    if (!nativeParent) continue;
    const moves = observations.filter(row => row.payload.parentId === parent.colpId
      && (row.payload.afterId !== undefined || row.payload.beforeId !== undefined));
    // Per-node latest placements lose history, even when their timestamps differ.
    // They establish that a comparison is needed; only a complete snapshot supplies order.
    if (!snapshot && !moves.length) continue;
    const local = (await input.getChildren(parent.nativeId)).map(node => node.id);
    const remoteParent = snapshot?.remoteFacts.find(row => row.nodeId === parent.colpId);
    const children = snapshot && remoteParent ? remoteChildren(snapshot, parent.colpId) : undefined;
    const remote = children?.flatMap(row => {
      const mapping = byColp.get(row.nodeId);
      return mapping && !isNonChromeNativeId(mapping.nativeId) ? [mapping.nativeId] : [];
    }) ?? [];
    const authorityDigest = children && remoteParent ? remoteFactsDigest([remoteParent, ...children]) : null;
    if (authorityDigest && !relativeChildOrderChanged(baseline, remote) && parent.colpId !== includeParentId) continue;
    const conflict = !authorityDigest || relativeChildOrderChanged(baseline, local) && relativeChildOrderChanged(remote, local);
    plans.push({ parent, baseline, local, remote, conflict, authorityDigest, boundaryDigest,
      nativeParentId: nativeParent.parentId ?? null,
      ...(remoteParent?.childrenRevision ? { childrenRevision: remoteParent.childrenRevision } : {}),
      commandId: `rejoin-order:${input.mount.mountId}:${parent.colpId}:${rejoinAttemptDigest(input.mount, recorded).slice(7, 23)}`,
      token: digestJson({ pause: input.mount.pauseBaseline ? { ...input.mount.pauseBaseline } : null, parentId: parent.colpId,
        baseline: [...baseline], local, authorityDigest, boundaryDigest, nativeParentId: nativeParent.parentId ?? null }) });
  }
  return plans;
}

export async function assertRejoinOrderAuthority(input: RejoinOrderInput, plan: RejoinOrderPlan): Promise<void> {
  const snapshot = await rejoinAuthority(input);
  const parent = snapshot?.remoteFacts.find(row => row.nodeId === plan.parent.colpId);
  if (!snapshot || !parent || !plan.authorityDigest
    || rejoinBoundaryDigest(await input.store.getScope(input.scope)) !== plan.boundaryDigest
    || remoteFactsDigest([parent, ...remoteChildren(snapshot, parent.nodeId)]) !== plan.authorityDigest) {
    throw new Error('preview_stale');
  }
}

export async function applyRejoinOrder(input: RejoinOrderInput, plan: RejoinOrderPlan,
  target: readonly string[], commandId?: string): Promise<void> {
  if (!input.getChildren || !input.moveNative) throw new Error('rejoin_order_api_unavailable');
  await assertRejoinOrderAuthority(input, plan);
  const liveIds = new Set(plan.local);
  // Preserve unrelated/new local children while ordering the common known siblings.
  const wanted = target.filter(id => liveIds.has(id));
  const progress = await rejoinOrderProgress(input, plan, commandId);
  let expected = progress.current;
  if (expected.some(id => !liveIds.has(id)) || expected.length !== plan.local.length) throw new Error('rejoin_order_changed');
  for (let index = 0; index < wanted.length; index++) {
    const current = (await input.getChildren(plan.parent.nativeId)).map(node => node.id);
    if (!sameChildOrder(current, expected)) throw new Error('rejoin_order_changed');
    const nativeId = wanted[index]!;
    if (current[index] === nativeId) continue;
    const mapping = await input.store.getMappingByNativeId(input.scope, nativeId);
    const before = await input.getNative(nativeId);
    if (!mapping || !before) throw new Error('rejoin_order_changed');
    const next = placedChildOrder(current, nativeId, { index });
    await progress.prepare(current, next);
    await applyRejoinMutation(input, mapping, 'move', { parentId: plan.parent.nativeId, index }, before,
      () => progress.assertCurrent(current));
    input.crash?.('after_rejoin_order_native');
    if (!sameChildOrder((await input.getChildren(plan.parent.nativeId)).map(row => row.id), next)) throw new Error('rejoin_order_changed');
    await progress.complete(next); expected = next;
  }
  await progress.assertCurrent(expected);
  const current = await input.store.getMappingByNativeId(input.scope, plan.parent.nativeId);
  if (!current) throw new Error('rejoin_order_changed');
  const { scopeKey: _key, ...rest } = current;
  await input.store.putMapping(input.scope, { ...rest, projection: { ...current.projection, childrenOrder: expected,
    ...(plan.childrenRevision ? { childrenRevision: plan.childrenRevision } : {}) } });
}

export async function reconcileRejoinOrders(input: RejoinOrderInput, mappings: readonly MappingInput[],
  observations: readonly RemoteObservationRecord[]): Promise<number> {
  let conflicts = 0;
  for (const plan of await planRejoinOrders(input, mappings, observations)) {
    if (plan.conflict) {
      const prior = await input.store.getScopeCommandPlan(input.scope, plan.commandId);
      if (!prior || prior.phase === 'pending') await input.store.putScopeCommandPlan(input.scope, { commandId: plan.commandId, kind: 'rejoin',
        confirmationVersion: input.mount.boundaryVersion, baselineDigest: plan.token, phase: 'pending',
        dependencies: [], mountId: input.mount.mountId, retryReason: 'rejoin_order_conflict', updatedAt: Date.now(),
        rejoinDecision: { kind: 'order', parentId: plan.parent.colpId, title: String(plan.parent.projection.content?.title ?? ''),
          affectedCount: plan.local.length, authorityDigest: plan.authorityDigest, boundaryDigest: plan.boundaryDigest,
          localOrder: [...plan.local], remoteOrder: [...plan.remote],
          attemptDigest: rejoinAttemptDigest(input.mount, await input.store.getScope(input.scope)),
          baseline: [...plan.baseline], childrenRevision: plan.childrenRevision ?? null } });
      conflicts++; continue;
    }
    await applyRejoinOrder(input, plan, plan.remote);
  }
  return conflicts;
}
