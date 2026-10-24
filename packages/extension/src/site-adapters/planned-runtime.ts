import { createPlannedSaveExecutor } from './planned-executor.js';
import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { sourceKey, sourceDigest } from './source-db.js';
import { cursorPage } from '../sync-state/idb.js';
import type { SaveEffect, SavePlan } from './contracts.js';
import type { StoredSavePlan } from './planned-types.js';
import { installPlannedCaptureGuard, plannedNativeFault } from '../capture/planned.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { acknowledgePlannedNative, assertPlannedNative, executePlannedNative, recoverPlannedNative } from '../sw/planned-capture.js';
let policyAuthorize: (plan: SavePlan, effect: SaveEffect) => Promise<void> = async () => { throw new Error('sourcePolicyUnavailable'); };
/** Only host rule/import code may install this; no adapter/management RPC accepts a plan. */
export function installSourcePlanAuthorization(authorize: typeof policyAuthorize) { policyAuthorize = authorize; }
export const plannedSaveExecutor = createPlannedSaveExecutor(siteLedger.db, {
  scope: currentCaptureScope, deviceId: captureDeviceId, authorize: (plan, effect) => policyAuthorize(plan, effect),
  beforeSubmit: c => plannedNativeFault('beforeNativeSubmit', c.commandId),
  beforeSourceCommit: c => plannedNativeFault('afterNativeReceipt', c.commandId),
  assertNative: assertPlannedNative, execute: executePlannedNative, recover: recoverPlannedNative, acknowledge: acknowledgePlannedNative,
});
export function installPlannedSaveRuntime() {
  installPlannedCaptureGuard(async task => {
    if (!task.planned) return;
    await plannedSaveExecutor.authorize(task.planned.planId, task.planned.effectId);
    const outbox = await siteLedger.db.read<import('./planned-types.js').SourceOutbox>('outbox', task.commandId);
    if (!outbox || outbox.digest !== task.planned.resolvedDigest || sourceDigest(outbox.command) !== outbox.digest
      || outbox.command.bookmark?.url !== task.url || outbox.command.parent.nativeId !== task.targetNativeId) throw new Error('planned_command_changed');
    await assertPlannedNative(task.planned.parent);
  });
}
export async function executePlannedSave(planId: string, effectId: string) {
  chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 30000 });
  return plannedSaveExecutor.execute(planId, effectId);
}
/** Bounded startup/alarm recovery. Unknown commands retain their identities and remain visible. */
export async function wakePlannedSaves() {
  const cursor = await siteLedger.db.read<{ planId: string; exclusive: boolean; offset: number }>('meta', 'planRecoveryCursor');
  const page = await siteLedger.db.transaction(['savePlans'], 'readonly', tx => cursorPage<StoredSavePlan>(tx.objectStore('savePlans'),
    cursor ? IDBKeyRange.lowerBound(cursor.planId, cursor.exclusive) : null, 2));
  const row = page[0]; let next: typeof cursor;
  if (row) {
    const byId = new Map(row.plan.effects.map(e => [e.effectId, e])), ordered: SaveEffect[] = [], visited = new Set<string>();
    const visit = (e: SaveEffect) => { if (visited.has(e.effectId)) return; visited.add(e.effectId); for (const id of e.dependsOn) { const parent = byId.get(id); if (parent) visit(parent); } ordered.push(e); };
    for (const e of row.plan.effects) visit(e);
    const offset = cursor?.planId === row.plan.id && !cursor.exclusive ? cursor.offset : 0;
    for (const effect of ordered.slice(offset, offset + 20)) {
      const state = await siteLedger.db.read<{ state: string; commandId?: string }>('effects', sourceKey(row.plan.id, effect.effectId));
      const outbox = state?.commandId ? await siteLedger.db.read<import('./planned-types.js').SourceOutbox>('outbox', state.commandId) : undefined;
      if ((state?.state !== 'confirmed' || outbox && !outbox.executorAcknowledged) && row.state !== 'draft') await plannedSaveExecutor.execute(row.plan.id, effect.effectId);
    }
    if (offset + 20 < ordered.length) next = { planId: row.plan.id, exclusive: false, offset: offset + 20 };
    else if (page.length > 1) next = { planId: row.plan.id, exclusive: true, offset: 0 };
  }
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
    if (next) tx.objectStore('meta').put(next, 'planRecoveryCursor'); else tx.objectStore('meta').delete('planRecoveryCursor');
  });
  if (next) chrome.alarms.create(SITE_RECOVERY_ALARM, { when: Date.now() + 30000 });
}
