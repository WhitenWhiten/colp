import { managedLibraryKey } from './copy-identity.js';
import { siteLedger } from './source-runtime.js';
import { get, put, sourceDigest } from './source-db.js';
import { localSourceCopyKey, localTransferKey, transferOwner, type LocalCopyTransfer } from './local-identity.js';
import { sourceSlotForPlan } from './managed-runtime.js';
import type { SourceMount } from './layout.js';
import type { PlannedNativeCommand, PlannedNativeResult } from './planned-types.js';
import type { SaveEffect, SavePlan } from './contracts.js';
import type { ManagedSlot } from './managed-client.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { assertSourceRoot } from '../sw/planned-capture.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
export async function prepareLocalSlot(command: PlannedNativeCommand, slot: ManagedSlot, root = command.parent) {
  const scope = await currentCaptureScope(), target = await assertSourceRoot(root);
  return { ...command, local: { slot, root, owner: target.inRange ? transferOwner(scope) : null } };
}
export async function prepareLocalSourceSave(command: PlannedNativeCommand, plan: SavePlan, effect: SaveEffect) {
  const mounts = await siteLedger.db.transaction(['mounts'], 'readonly', async tx => {
    if (!plan.mount) return undefined;
    const request = tx.objectStore('mounts').index('id').get(plan.mount.id);
    return new Promise<SourceMount | undefined>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  });
  const slot = await sourceSlotForPlan(plan, effect), root = mounts?.root ?? command.parent;
  const prepared = await prepareLocalSlot(command, slot, root);
  const policy = await siteLedger.db.read<import('./layout.js').SourcePolicyRecord>('meta', `policy:${plan.connectionId}`);
  // A disconnected mapping retains its original target; a later login cannot retag this work.
  return { ...prepared, local: { ...prepared.local, owner: transferOwner(mounts?.destination) ?? prepared.local.owner, ...(policy ? { copyPolicy: policy.policy.copies } : {}) } };
}
export async function rememberLocalSourceSave(command: PlannedNativeCommand, result: PlannedNativeResult) {
  if (!command.local || result.status !== 'confirmed') return result;
  const local = command.local, now = Date.now(), key = localTransferKey(command.commandId);
  const transfer: LocalCopyTransfer = { version: 1, commandId: command.commandId, connectionId: command.connectionId, ...(local.owner ? { ownerKey: managedLibraryKey(local.owner) } : {}), key: localSourceCopyKey(local.root, local.slot),
    native: result.native, parent: command.parent, title: command.title, url: command.bookmark?.url ?? null, slot: local.slot,
    owner: local.owner, ...(local.copyPolicy ? { copyPolicy: local.copyPolicy } : {}), state: 'pending', createdAt: now, updatedAt: now };
  await siteLedger.db.transaction(['meta', 'transfers', 'unboundTransfers'], 'readwrite', async tx => {
    const old = await get<LocalCopyTransfer>(tx, 'meta', key);
    if (old && (old.key !== transfer.key || sourceDigest(old.native) !== sourceDigest(transfer.native))) throw new Error('localReceiptChanged');
    if (!old) {
      put(tx, 'meta', key, transfer);
      if (transfer.owner) put(tx, 'transfers', transfer.commandId, { ...transfer, dueAt: 0, attempts: 0 });
      else put(tx, 'unboundTransfers', transfer.commandId, { ...transfer, dueAt: 0 });
    }
  });
  scheduleSourceAlarm(now + 50);
  return result;
}
