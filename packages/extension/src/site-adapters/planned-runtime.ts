import { createPlannedSaveExecutor } from './planned-executor.js';
import { siteLedger, SITE_RECOVERY_ALARM } from './source-runtime.js';
import { sourceKey, sourceDigest } from './source-db.js';
import { cursorPage } from '../sync-state/idb.js';
import type { SaveEffect, SavePlan } from './contracts.js';
import type { StoredSavePlan } from './planned-types.js';
import { installPlannedCaptureGuard, plannedNativeFault } from '../capture/planned.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { acknowledgePlannedNative, assertPlannedNative, assertSourceRoot, executePlannedNative, recoverPlannedNative } from '../sw/planned-capture.js';
import { managedSaves } from './managed-runtime.js';
let scheduleRecovery = (at: number) => chrome.alarms.create(SITE_RECOVERY_ALARM, { when: at });
export function installSourceRecoveryScheduler(schedule: typeof scheduleRecovery) { scheduleRecovery = schedule; }
let policyAuthorize: (plan: SavePlan, effect: SaveEffect) => Promise<void> = async () => { throw new Error('sourcePolicyUnavailable'); };
/** Only host rule/import code may install this; no adapter/management RPC accepts a plan. */
export function installSourcePlanAuthorization(authorize: typeof policyAuthorize) { policyAuthorize = authorize; }
export const plannedSaveExecutor = createPlannedSaveExecutor(siteLedger.db, {
  scope: currentCaptureScope, deviceId: captureDeviceId, authorize: (plan, effect) => policyAuthorize(plan, effect),
  beforeSubmit: c => plannedNativeFault('beforeNativeSubmit', c.commandId),
  beforeSourceCommit: c => plannedNativeFault('afterNativeReceipt', c.commandId),
  assertNative: async binding => { await assertSourceRoot(binding); }, prepare: managedSaves.prepare,
  execute: (command, digest, authorize) => command.managed ? managedSaves.execute(command, authorize) : executePlannedNative(command, digest, authorize),
  recover: (command, digest) => command.managed ? managedSaves.recover(command) : recoverPlannedNative(command, digest),
  acknowledge: (command, digest) => command.managed ? Promise.resolve() : acknowledgePlannedNative(command, digest),
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
  scheduleRecovery(Date.now() + 30000);
  return plannedSaveExecutor.execute(planId, effectId);
}
/** Bounded startup/alarm recovery. Unknown commands retain their identities and remain visible. */
async function recoverPlannedSaves() {
  const cursor = await siteLedger.db.read<{ planId: string; exclusive: boolean; offset: number }>('meta', 'planRecoveryCursor');
  const page = await siteLedger.db.transaction(['savePlans'], 'readonly', tx => cursorPage<StoredSavePlan>(tx.objectStore('savePlans'),
    cursor ? IDBKeyRange.lowerBound(cursor.planId, cursor.exclusive) : null, 20));
  let next: typeof cursor, budget = 20, stopped = false;
  for (const row of page) {
    // Evidence fixtures are manually driven so a worker-cut test controls its exact boundary.
    if (await siteLedger.db.read('meta', `evidence-plan:${row.plan.id}`)) { next = { planId: row.plan.id, exclusive: true, offset: 0 }; continue; }
    const byId = new Map(row.plan.effects.map(e => [e.effectId, e])), ordered: SaveEffect[] = [], visited = new Set<string>();
    const visit = (e: SaveEffect) => { if (visited.has(e.effectId)) return; visited.add(e.effectId); for (const id of e.dependsOn) { const parent = byId.get(id); if (parent) visit(parent); } ordered.push(e); };
    for (const e of row.plan.effects) visit(e);
    const offset = cursor?.planId === row.plan.id && !cursor.exclusive ? cursor.offset : 0;
    for (let index = offset; index < ordered.length; index++) {
      const effect = ordered[index]!;
      const state = await siteLedger.db.read<{ state: string; commandId?: string }>('effects', sourceKey(row.plan.id, effect.effectId));
      const outbox = state?.commandId ? await siteLedger.db.read<import('./planned-types.js').SourceOutbox>('outbox', state.commandId) : undefined;
      if ((state?.state !== 'confirmed' || outbox && !outbox.executorAcknowledged) && row.state !== 'draft') {
        await plannedSaveExecutor.execute(row.plan.id, effect.effectId); budget--;
      }
      if (budget <= 0) { next = { planId: row.plan.id, exclusive: index + 1 === ordered.length, offset: index + 1 === ordered.length ? 0 : index + 1 }; stopped = true; break; }
    }
    if (stopped) break;
    next = { planId: row.plan.id, exclusive: true, offset: 0 };
  }
  if (!stopped && page.length < 20) next = undefined;
  await siteLedger.db.transaction(['meta'], 'readwrite', async tx => {
    if (next) tx.objectStore('meta').put(next, 'planRecoveryCursor'); else tx.objectStore('meta').delete('planRecoveryCursor');
  });
  if (next) scheduleRecovery(Date.now() + 100);
}

let recovering: Promise<void> | undefined, recoveryRequested = false;
/** All installations share the executor/outbox: coalesce wakes instead of racing its durable cursor. */
export function wakePlannedSaves(): Promise<void> {
  if (recovering) { recoveryRequested = true; return recovering; }
  return recovering = recoverPlannedSaves().finally(() => {
    recovering = undefined;
    if (recoveryRequested) { recoveryRequested = false; scheduleRecovery(Date.now() + 100); }
  });
}
