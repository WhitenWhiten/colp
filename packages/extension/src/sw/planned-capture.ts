import { plannedNativeFault } from '../capture/planned.js';
import { createPlannedCaptureTask } from '../capture/planned-task.js';
import { transitionCapture } from '../capture/state.js';
import type { CaptureTask } from '../capture/contracts.js';
import { captureCoordinator, captureStore, CAPTURE_ALARM } from './capture.js';
import { currentCaptureScope, recoverNativeCapture } from './capture-native.js';
import { captureTarget } from './capture-target.js';
import { captureDeviceId } from './capture-history.js';
import { createBookmarkCreatePlacementStore } from '../bookmark-create-placement.js';
import { personalBookmarks, assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import { hasBookmarkPermission, workCoordinator } from './runtime.js';
import { sourceDigest } from '../site-adapters/source-db.js';
import type { NativeBinding } from '../site-adapters/contracts.js';
import type { PlannedNativeCommand, PlannedNativeResult } from '../site-adapters/planned-types.js';
export async function assertSourceRoot(binding: NativeBinding<'folder'>) {
  if (!await hasBookmarkPermission()) throw new Error('permissionRequired');
  if (binding.kind !== 'folder' || !binding.dateAdded || binding.deviceId !== await captureDeviceId()) throw new Error('nativeIdentityUnproven');
  const scope = await currentCaptureScope(), target = await captureTarget(scope, binding.nativeId);
  const node = (await chrome.bookmarks.get(binding.nativeId))[0];
  if (!node || node.url || node.dateAdded !== binding.dateAdded || !binding.proof.id) throw new Error('nativeIdentityChanged');
  return target;
}
export async function assertPlannedNative(binding: NativeBinding<'folder'>) {
  await assertSourceRoot(binding);
}
async function bookmarkResult(task: CaptureTask, command: PlannedNativeCommand): Promise<PlannedNativeResult> {
  if (task.save !== 'local-saved' || !task.nativeId || !task.nativeDateAdded) return { status: 'unknown', reason: 'nativeOutcomeUnknown' };
  const node = (await chrome.bookmarks.get(task.nativeId).catch(() => []))[0];
  if (!node || node.dateAdded !== task.nativeDateAdded || node.url !== command.bookmark?.url) return { status: 'blocked', reason: 'nativeIdentityChanged' };
  return { status: 'confirmed', native: { bindingId: command.commandId, nativeId: task.nativeId, deviceId: command.deviceId,
    kind: 'bookmark', dateAdded: task.nativeDateAdded, proof: { kind: 'writeReceipt', id: task.nativeIntentId ?? task.commandId } },
    written: { title: node.title, parentId: node.parentId!, url: node.url! } };
}
export async function recoverPlannedNative(command: PlannedNativeCommand, digest: string): Promise<PlannedNativeResult | null> {
  const record = await captureStore.plannedCommand(command.commandId);
  if (!record) return null;
  if (record.kind !== command.kind || (record.kind === 'folder' ? record.digest !== digest : record.task?.planned?.resolvedDigest !== digest)) throw new Error('capture_command_reused');
  if (record.kind === 'folder') {
    if (!record.native) return record.state === 'reserved' ? null : { status: 'unknown', reason: 'nativeOutcomeUnknown' };
    if (record.recovery) {
      const node = (await chrome.bookmarks.get(record.native.nativeId).catch(() => []))[0];
      if (!node || node.url || node.dateAdded !== record.native.dateAdded || node.parentId !== command.parent.nativeId || node.title !== command.title
        || record.native.deviceId !== await captureDeviceId()) return { status: 'blocked', reason: 'nativeIdentityChanged' };
    }
    return { status: 'confirmed', native: record.native };
  }
  if (!record.task) throw new Error('capture_not_found');
  let task = record.task;
  if (task.save === 'unknown') {
    const receipt = await recoverNativeCapture(task);
    if (receipt) {
      const next = transitionCapture(task, { kind: 'saved', ...receipt }, Date.now()); await captureStore.update(next, task.revision); task = next;
    }
  }
  return bookmarkResult(task, command);
}
const activeFolders = new Set<string>();
export async function executePlannedNative(command: PlannedNativeCommand, digest: string, authorize: () => Promise<void>): Promise<PlannedNativeResult> {
  if (command.kind !== 'folder') return executePlannedNativeInner(command, digest, authorize);
  if (activeFolders.has(command.commandId)) throw new Error('nativeOperationInProgress');
  activeFolders.add(command.commandId);
  try { return await executePlannedNativeInner(command, digest, authorize); } finally { activeFolders.delete(command.commandId); }
}
async function executePlannedNativeInner(command: PlannedNativeCommand, digest: string, authorize: () => Promise<void>): Promise<PlannedNativeResult> {
  if (sourceDigest(command) !== digest) throw new Error('capture_command_reused');
  const old = await recoverPlannedNative(command, digest);
  if (old?.status === 'confirmed') return old;
  await authorize(); await assertPlannedNative(command.parent);
  chrome.alarms.create(CAPTURE_ALARM, { when: Date.now() + 30000 });
  if (command.kind === 'folder') {
    const record = await captureStore.claimFolder(command.commandId, command, digest);
    if (record.state !== 'reserved') return { status: 'unknown', reason: 'nativeOutcomeUnknown' };
    await authorize(); await assertPlannedNative(command.parent);
    await captureStore.updateFolder(command.commandId, 'reserved', 'submitted');
    try {
      const node = await personalBookmarks.create({ parentId: command.parent.nativeId, title: command.title });
      await plannedNativeFault('afterFolderCreate', command.commandId);
      if (!node.dateAdded) { await captureStore.updateFolder(command.commandId, 'submitted', 'unknown'); return { status: 'unknown', reason: 'nativeIdentityUnproven' }; }
      const native: NativeBinding<'folder'> = { bindingId: command.commandId, nativeId: node.id, kind: 'folder', deviceId: command.deviceId,
        dateAdded: node.dateAdded, proof: { kind: 'writeReceipt', id: command.commandId } };
      await captureStore.updateFolder(command.commandId, 'submitted', 'confirmed', native); return { status: 'confirmed', native };
    } catch { await captureStore.updateFolder(command.commandId, 'submitted', 'unknown').catch(() => undefined); return { status: 'unknown', reason: 'nativeOutcomeUnknown' }; }
  }
  const task = await captureCoordinator.start(createPlannedCaptureTask(command, digest));
  const saved = await workCoordinator.run('local-bookmark', () => captureCoordinator.resume(task.scope, task.captureId));
  return bookmarkResult(saved, command);
}
/** Explicit confirmation of an absent result is retained before another create is allowed. */
export async function retryPlannedFolder(command: PlannedNativeCommand, digest: string) {
  if (activeFolders.has(command.commandId)) throw new Error('nativeOperationInProgress');
  activeFolders.add(command.commandId);
  try {
    if (command.kind !== 'folder' || command.managed || command.local?.reuse || sourceDigest(command) !== digest) throw new Error('capture_command_reused');
    await assertSourceRoot(command.parent);
    if (command.deviceId !== await captureDeviceId()) throw new Error('nativeIdentityChanged');
    const children = await chrome.bookmarks.getChildren(command.parent.nativeId);
    if (children.some(node => !node.url && node.title === command.title)) throw new Error('nativeFolderCandidateExists');
    await captureStore.retryPlannedFolder(command.commandId, digest);
  } finally { activeFolders.delete(command.commandId); }
}
/** An explicit user selection adopts one verified folder; it never issues a create. */
export async function adoptPlannedFolder(command: PlannedNativeCommand, digest: string, nativeId: string, dateAdded: number) {
  if (activeFolders.has(command.commandId)) throw new Error('nativeOperationInProgress');
  activeFolders.add(command.commandId);
  try { return await adoptPlannedFolderInner(command, digest, nativeId, dateAdded); } finally { activeFolders.delete(command.commandId); }
}
async function adoptPlannedFolderInner(command: PlannedNativeCommand, digest: string, nativeId: string, dateAdded: number) {
  if (command.kind !== 'folder' || command.managed || command.local?.reuse || sourceDigest(command) !== digest) throw new Error('capture_command_reused');
  const record = await captureStore.plannedCommand(command.commandId);
  if (!record || record.kind !== 'folder' || record.digest !== digest || !['submitted', 'unknown', 'confirmed'].includes(record.state)) throw new Error('nativeOutcomeNotUnknown');
  await assertSourceRoot(command.parent);
  if (command.deviceId !== await captureDeviceId()) throw new Error('nativeIdentityChanged');
  await assertPersonalNativeAllowed(nativeId);
  const node = (await chrome.bookmarks.get(nativeId).catch(() => []))[0];
  if (!node || node.url || node.parentId !== command.parent.nativeId || node.title !== command.title || !dateAdded || node.dateAdded !== dateAdded)
    throw new Error('nativeIdentityChanged');
  const native: NativeBinding<'folder'> = { bindingId: command.commandId, nativeId, deviceId: command.deviceId, kind: 'folder', dateAdded,
    proof: { kind: 'explicitAdoption', id: command.commandId } };
  await captureStore.adoptPlannedFolder(command.commandId, digest, native);
  return native;
}
export async function acknowledgePlannedNative(command: PlannedNativeCommand, digest: string) {
  const intentId = await captureStore.acknowledgePlanned(command.commandId, digest);
  if (intentId) await createBookmarkCreatePlacementStore().acknowledge(intentId);
}
