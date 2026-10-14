import { freezeCaptureTabs, type CaptureBatch, type CaptureBatchRequest } from '../capture/batch.js';
import { assertCaptureScope, captureExistence, currentCaptureScope } from './capture-native.js';
import { startCapture, resumeCapture, captureStore } from './capture.js';
const prefix = 'known.capture.batch.v1.';
let lane: Promise<unknown> = Promise.resolve();

async function read(id: string): Promise<CaptureBatch> {
  const batch = (await chrome.storage.local.get(prefix + id))[prefix + id] as CaptureBatch | undefined;
  if (!batch) throw new Error('capture_batch_not_found');
  await assertCaptureScope(batch.scope); return batch;
}
async function write(batch: CaptureBatch): Promise<void> {
  await assertCaptureScope(batch.scope);
  await chrome.storage.local.set({ [prefix + batch.batchId]: batch });
}
export async function previewCaptureBatch(selection: 'all' | 'selected', windowId?: number): Promise<CaptureBatch> {
  const scope = await currentCaptureScope();
  const tabsPermission = await chrome.permissions.contains({ permissions: ['tabs'] });
  const tabs = await chrome.tabs.query({ ...(windowId === undefined ? { currentWindow: true } : { windowId }),
    ...(selection === 'selected' ? { highlighted: true } : {}) });
  if (tabs.length > 1000) throw new Error('capture_batch_too_large');
  const items = freezeCaptureTabs(tabs, () => crypto.randomUUID());
  const batch: CaptureBatch = { batchId: crypto.randomUUID(), scope, windowId: windowId ?? tabs[0]?.windowId ?? null,
    selection, tabsPermission, createdAt: Date.now(), confirmed: false, selectedIds: [], saveAnotherIds: [], targetNativeId: null,
    items: await Promise.all(items.map(async item => ({ ...item, existence: item.reason || !item.url ? null
      : await captureExistence({ scope, url: item.url }) }))) };
  await write(batch); return batch;
}

export async function openCaptureBatch(selection: 'all' | 'selected', windowId?: number): Promise<void> {
  const batch = await previewCaptureBatch(selection, windowId);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`capture-tabs.html?batch=${batch.batchId}`) });
}

async function execute(batch: CaptureBatch, allowUnverifiedCloud: boolean): Promise<CaptureBatch> {
  const confirmedNativeIds: string[] = [];
  for (const original of batch.items) {
    if (!batch.selectedIds.includes(original.itemId) || original.reason || !original.url) continue;
    await assertCaptureScope(batch.scope);
    try {
    let task = original.captureId ? await captureStore.get(batch.scope, original.captureId) : null;
    if (!task) task = await startCapture({ commandId: original.commandId, source: 'batch', batchId: batch.batchId,
      url: original.url, title: original.title, tabId: original.tabIds[0], parentNativeId: batch.targetNativeId!, folderChoice: batch.folderChoice ?? 'explicit',
      saveAnother: batch.saveAnotherIds.includes(original.itemId), allowUnverifiedCloud, resumeNativeIds: confirmedNativeIds });
    batch = { ...batch, items: batch.items.map(item => item.itemId === original.itemId ? { ...item, captureId: task!.captureId, error: undefined } : item) };
    await write(batch);
    // Every item has its own receipt. Completed items never run a new command on retry.
    const result = await resumeCapture(task).catch(() => task);
    if (result.nativeId) confirmedNativeIds.push(result.nativeId);
    } catch {
      batch = { ...batch, items: batch.items.map(item => item.itemId === original.itemId ? { ...item, error: 'capture_item_unavailable' } : item) };
      await write(batch);
    }
  }
  return batch;
}

export async function wakeCaptureBatches(): Promise<void> {
  const values = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(prefix) || !value || typeof value !== 'object' || !('confirmed' in value)) continue;
    const batch = value as CaptureBatch;
    if (batch.confirmed && batch.items.some(item => batch.selectedIds.includes(item.itemId) && !item.captureId && !item.error)) {
      await handleCaptureBatch({ kind: 'known.capture.batch.resume', batchId: batch.batchId }).catch(() => undefined);
    }
  }
}

export function handleCaptureBatch(request: CaptureBatchRequest): Promise<unknown> {
  if (request.kind === 'known.capture.batch.preview') return previewCaptureBatch(request.selection, request.windowId).then(batch => ({ ok: true, batch }));
  if (request.kind === 'known.capture.batch.get') return read(request.batchId).then(async batch => ({ ok: true, batch,
    tasks: await Promise.all(batch.items.filter(item => item.captureId).map(item => captureStore.get(batch.scope, item.captureId!))) }));
  const run = async () => {
    let batch = await read(request.batchId);
    const permissionKey = `${prefix}${batch.batchId}.allow-cloud-unknown`;
    if (request.kind === 'known.capture.batch.confirm') {
      if (batch.confirmed) return { ok: true, batch };
      if (request.selectedIds.some(id => !batch.items.some(item => item.itemId === id && !item.reason))
        || request.saveAnotherIds.some(id => !request.selectedIds.includes(id))) throw new Error('capture_batch_selection_invalid');
      batch = { ...batch, confirmed: true, selectedIds: [...new Set(request.selectedIds)],
        saveAnotherIds: [...new Set(request.saveAnotherIds)], targetNativeId: request.targetNativeId, folderChoice: request.folderChoice ?? 'explicit' };
      await chrome.storage.local.set({ [permissionKey]: request.allowUnverifiedCloud });
      await write(batch);
    }
    if (!batch.confirmed) throw new Error('capture_batch_not_confirmed');
    const allowed = (await chrome.storage.local.get(permissionKey))[permissionKey] === true;
    return { ok: true, batch: await execute(batch, allowed) };
  };
  const result = lane.then(run, run); lane = result.catch(() => undefined); return result;
}
