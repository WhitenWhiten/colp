import { digestJson } from './bookmark-event-codec.js';
import { rejoinAttemptDigest, rejoinBoundaryDigest } from './scope-rejoin-authority.js';
import { sameChildOrder } from './bookmark-reorder-diff.js';
import type { RejoinOrderInput, RejoinOrderPlan } from './scope-rejoin-order.js';
import type { JsonObject, ScopeCommandPlanRecord } from './sync-state-store.js';

/** Only a recorded before/after transition can explain a partially applied order after eviction. */
export async function rejoinOrderProgress(input: RejoinOrderInput, plan: RejoinOrderPlan, commandId?: string) {
  let record = commandId ? await input.store.getScopeCommandPlan(input.scope, commandId) : null;
  if (commandId && (!record || record.retryReason !== 'keep_remote_order'
    || !['confirmed', 'applying'].includes(record.phase))) throw new Error('decision_already_made');
  let progress = record?.rejoinDecision?.orderProgress as JsonObject | undefined;
  const current = (await input.getChildren!(plan.parent.nativeId)).map(row => row.id);
  const currentDigest = digestJson(current);
  const expectedDigest = progress?.expectedDigest ?? digestJson([...plan.local]);
  if (currentDigest !== expectedDigest && currentDigest !== progress?.pendingAfterDigest) throw new Error('rejoin_order_changed');

  async function save(value: JsonObject) {
    progress = value;
    if (!record) return;
    const latest = await input.store.getScopeCommandPlan(input.scope, record.commandId);
    if (!latest || latest.baselineDigest !== record.baselineDigest || !['confirmed', 'applying'].includes(latest.phase)) {
      throw new Error('preview_stale');
    }
    record = { ...latest, phase: 'applying', rejoinDecision: { ...latest.rejoinDecision, orderProgress: value }, updatedAt: Date.now() };
    await input.store.putScopeCommandPlan(input.scope, withoutScope(record));
  }
  if (record && (!progress || currentDigest === progress.pendingAfterDigest)) await save({ expectedDigest: currentDigest });
  async function assertCurrent(expected: readonly string[]) {
    const scope = await input.store.getScope(input.scope);
    const mount = await input.store.getMountBinding(input.scope, input.mount.mountId);
    if (!mount || rejoinBoundaryDigest(scope) !== plan.boundaryDigest || mount.status !== input.mount.status
      || mount.boundaryVersion !== input.mount.boundaryVersion
      || rejoinAttemptDigest(mount, scope) !== rejoinAttemptDigest(input.mount, scope)) throw new Error('rejoin_boundary_changed');
    if (record) {
      const latest = await input.store.getScopeCommandPlan(input.scope, record.commandId);
      if (!latest || latest.baselineDigest !== record.baselineDigest || latest.retryReason !== 'keep_remote_order'
        || !['confirmed', 'applying'].includes(latest.phase)) throw new Error('preview_stale');
    }
    const parent = await input.store.getMappingByNativeId(input.scope, plan.parent.nativeId);
    if (!parent || parent.colpId !== plan.parent.colpId || parent.rootNativeId !== plan.parent.rootNativeId
      || parent.mountId !== plan.parent.mountId) throw new Error('rejoin_order_changed');
    const live = await input.getNative(parent.nativeId);
    const nativeParentId = plan.nativeParentId === undefined ? plan.parent.parentNativeId ?? null : plan.nativeParentId;
    if (!live || (live.parentId ?? null) !== nativeParentId
      || !sameChildOrder((await input.getChildren!(parent.nativeId)).map(row => row.id), expected)) throw new Error('rejoin_order_changed');
  }
  return {
    current, assertCurrent,
    prepare: (before: readonly string[], after: readonly string[]) => save({
      expectedDigest: digestJson([...before]), pendingAfterDigest: digestJson([...after]) }),
    complete: (after: readonly string[]) => save({ expectedDigest: digestJson([...after]) }),
  };
}

function withoutScope(record: ScopeCommandPlanRecord) {
  const { scopeKey: _key, ...value } = record; return value;
}
