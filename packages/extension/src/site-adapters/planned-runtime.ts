import { prepareLocalSourceSave } from './local-save-runtime.js';
import { executeLocalSave, recoverLocalSave } from './local-reuse-runtime.js';
import { createSourceWorkQueue } from './work-queue.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
import { createPlannedSaveExecutor } from './planned-executor.js';
import { siteLedger } from './source-runtime.js';
import { sourceKey, sourceDigest } from './source-db.js';
import type { SaveEffect, SavePlan } from './contracts.js';
import type { StoredSavePlan } from './planned-types.js';
import { installPlannedCaptureGuard, plannedNativeFault } from '../capture/planned.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { acknowledgePlannedNative, assertPlannedNative, assertSourceRoot, executePlannedNative, recoverPlannedNative } from '../sw/planned-capture.js';
import { managedSaves } from './managed-runtime.js';
import { assertSemanticSaveTask } from './semantic-authorization.js';
import { assertReconcileAuthorization } from './reconcile-authorization.js';
import { activityForSource } from './activity-runtime.js';
import { activityCode } from './activity.js';
let scheduleRecovery = (at: number) => scheduleSourceAlarm(at);
export function installSourceRecoveryScheduler(schedule: typeof scheduleRecovery) { scheduleRecovery = schedule; }
let policyAuthorize: (plan: SavePlan, effect: SaveEffect) => Promise<void> = async () => { throw new Error('sourcePolicyUnavailable'); };
/** Only host rule/import code may install this; no adapter/management RPC accepts a plan. */
export function installSourcePlanAuthorization(authorize: typeof policyAuthorize) { policyAuthorize = authorize; }
export const plannedSaveExecutor = createPlannedSaveExecutor(siteLedger.db, {
  scope: currentCaptureScope, deviceId: captureDeviceId, authorize: (plan, effect) => policyAuthorize(plan, effect),
  beforeSubmit: c => plannedNativeFault('beforeNativeSubmit', c.commandId),
  beforeSourceCommit: c => plannedNativeFault('afterNativeReceipt', c.commandId),
  assertNative: async binding => { await assertSourceRoot(binding); }, prepare: prepareLocalSourceSave,
  execute: (command, digest, authorize) => command.managed ? managedSaves.execute(command, authorize) : executeLocalSave(command, digest, authorize),
  recover: (command, digest) => command.managed ? managedSaves.recover(command) : recoverLocalSave(command, digest),
  acknowledge: (command, digest) => command.managed || command.local?.reuse ? Promise.resolve() : acknowledgePlannedNative(command, digest),
});
export function installPlannedSaveRuntime() {
  installPlannedCaptureGuard(async task => {
    if (!task.planned) return;
    if (task.planned.effectId.startsWith('reconcile:')) return assertReconcileAuthorization(task);
    if (task.planned.purpose === 'semantic') return assertSemanticSaveTask(task);
    await plannedSaveExecutor.authorize(task.planned.planId, task.planned.effectId);
    const outbox = await siteLedger.db.read<import('./planned-types.js').SourceOutbox>('outbox', task.commandId);
    if (!outbox || outbox.digest !== task.planned.resolvedDigest || sourceDigest(outbox.command) !== outbox.digest
      || outbox.command.bookmark?.url !== task.url || outbox.command.parent.nativeId !== task.targetNativeId) throw new Error('planned_command_changed');
    await assertPlannedNative(task.planned.parent);
  });
}
export async function executePlannedSave(planId: string, effectId: string, schedule = true) {
  if (schedule) scheduleRecovery(Date.now() + 30000);
  const row = await siteLedger.db.read<StoredSavePlan>('savePlans', planId), effect = row?.plan.effects.find(e => e.effectId === effectId);
  const activity = row?.plan.trigger.kind !== 'import' && row?.state === 'approved' ? await activityForSource(siteLedger.db, row.plan.connectionId).catch(() => undefined) : undefined;
  let result: Awaited<ReturnType<typeof plannedSaveExecutor.execute>>;
  try { result = await plannedSaveExecutor.execute(planId, effectId); }
  catch (error) {
    await activity?.record({ kind: 'problem', operation: 'save', taskId: planId, requestId: effectId, commandId: effect?.commandId,
      connectionId: row?.plan.connectionId, code: activityCode(error instanceof Error ? error.message : 'unavailable') }).catch(() => undefined); throw error;
  }
  if (result.status === 'confirmed') {
    if (effect?.kind === 'createBookmark') {
      await activity?.record({ kind: 'saved', operation: 'save', taskId: planId, commandId: effect.commandId, connectionId: row?.plan.connectionId,
        collectionId: effect.representation.sourceCollectionId ?? undefined, counts: { read: 1, saved: 1, skipped: 0 } }).catch(() => undefined);
      await activity?.resolve(planId, 'save').catch(() => undefined);
    }
    return result;
  }
  const state = await siteLedger.db.read<{ commandId?: string }>('effects', sourceKey(planId, effectId));
  await activity?.record({ kind: 'problem', operation: 'save', taskId: planId, requestId: effectId, commandId: state?.commandId ?? effect?.commandId,
    connectionId: row?.plan.connectionId, code: result.reason }).catch(() => undefined);
  return { ...result, commandId: state?.commandId ?? effect?.commandId };
}
/** Active work is independent of retained history and immutable plan key order. */
const recoverPlannedSaves = createSourceWorkQueue(siteLedger.db, { execute: (id, effect) => executePlannedSave(id, effect, false), schedule: at => scheduleRecovery(at) });

let recovering: Promise<void> | undefined, recoveryRequested = false;
/** All installations share the executor/outbox: coalesce wakes instead of racing its durable cursor. */
export function wakePlannedSaves(): Promise<void> {
  if (recovering) { recoveryRequested = true; return recovering; }
  return recovering = recoverPlannedSaves().finally(() => {
    recovering = undefined;
    if (recoveryRequested) { recoveryRequested = false; scheduleRecovery(Date.now() + 100); }
  });
}
