import { digestJson } from './bookmark-event-codec.js';
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
  return {
    current,
    prepare: (before: readonly string[], after: readonly string[]) => save({
      expectedDigest: digestJson([...before]), pendingAfterDigest: digestJson([...after]) }),
    complete: (after: readonly string[]) => save({ expectedDigest: digestJson([...after]) }),
  };
}

function withoutScope(record: ScopeCommandPlanRecord) {
  const { scopeKey: _key, ...value } = record; return value;
}
