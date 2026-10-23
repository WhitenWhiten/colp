import { assertPersonalNativeAllowed, personalBookmarks } from '../bookmark-subscriptions/guards.js';
import { previewNetscapeBookmarkImport } from '../import-preview.js';
import { localImportItems, type LocalImportRequest, type LocalImportResponse } from '../local-import/contracts.js';
import { createLocalImportStore } from '../local-import/store.js';
import { createLocalImporter } from '../local-import/coordinator.js';
import { hasBookmarkPermission } from './runtime.js';
import { ensurePeriodicAlarm } from './reconcile-alarm.js';
import { decodeLocalBackup, MAX_BACKUP_BYTES } from '../local-backup/codec.js';
import { digestJson } from '../bookmark-event-codec.js';
import { restoreBackupMetadata } from '../local-backup/restore.js';
import { restoreItemAnnotations } from '../local-import/annotations.js';
import { currentCaptureScope } from './capture-native.js';
export const LOCAL_IMPORT_ALARM = 'known-local-import-recovery';
const journal = createLocalImportStore();
async function assertFolder(nativeId: string) {
  await assertPersonalNativeAllowed(nativeId);
  const [node] = await chrome.bookmarks.get(nativeId);
  if (!node || node.url !== undefined || node.unmodifiable || !node.parentId) throw new Error('capture_target_unavailable');
}
const importer = createLocalImporter({ store: journal, hasPermission: hasBookmarkPermission, assertFolder,
  create: input => personalBookmarks.create(input),
  get: async id => (await chrome.bookmarks.get(id).catch(() => []))[0],
  restoreMetadata: (plan, items) => plan.backup ? restoreBackupMetadata(plan, items) : restoreItemAnnotations(items),
});
let lane: Promise<unknown> = Promise.resolve();
const stopRequests = new Set<string>();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = lane.then(work, work); lane = result.catch(() => undefined); return result;
}
export function wakeLocalImports(): Promise<void> {
  return serial(async () => {
    let plan = await journal.plan();
    if (plan?.state === 'running') await ensurePeriodicAlarm(chrome, LOCAL_IMPORT_ALARM, 1);
    while (plan?.state === 'running' && !stopRequests.has(plan.commandId)) plan = await importer.run(plan.commandId, 1);
    if (plan?.state !== 'running') await chrome.alarms.clear(LOCAL_IMPORT_ALARM);
  });
}
export async function handleLocalImport(request: LocalImportRequest): Promise<LocalImportResponse> {
  if (request.kind === 'known.localImport.status') return { ok: true, status: await importer.status() };
  if (request.kind === 'known.localImport.preview') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(request.base64)) throw new Error('input_invalid');
    const binary = atob(request.base64);
    if (binary.length > (request.format === 'backup' ? MAX_BACKUP_BYTES : 4 * 1024 * 1024)) throw new Error('input_too_large');
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (request.format === 'backup') {
      const backup = decodeLocalBackup(bytes), digest = digestJson(JSON.stringify(backup));
      await serial(() => journal.previewBackup(backup, digest));
      return { ok: true, preview: { digest, creates: backup.nodes.length + 1, roots: backup.nodes.filter(node => node.parentIndex === null).map(node => node.title),
        warnings: [], format: 'backup', historyCount: backup.history.length } };
    }
    const conversion = previewNetscapeBookmarkImport(bytes);
    await serial(() => journal.preview(conversion));
    return { ok: true, preview: { digest: conversion.digest, creates: localImportItems(conversion, '', '').length,
      roots: conversion.tree.map(node => node.title ?? node.kind), warnings: conversion.preview.warnings.map(warning => warning.message) } };
  }
  if (request.kind === 'known.localImport.cancel') stopRequests.add(request.commandId);
  await ensurePeriodicAlarm(chrome, LOCAL_IMPORT_ALARM, 1);
  const plan = await serial(async () => {
    if (request.kind === 'known.localImport.commit') {
      if (!await hasBookmarkPermission()) throw new Error('permission_required');
      await assertFolder(request.targetNativeId);
      return journal.start({ ...request, ...(request.restoreSettings === undefined ? {} : { restoreOwner: await currentCaptureScope() }) });
    }
    if (request.kind === 'known.localImport.cancel') {
      const current = await journal.plan(request.commandId);
      if (!current) throw new Error('local_import_not_found');
      if (current.state === 'completed' || current.state === 'cancelled') return current;
      return journal.state(current, 'cancelled', null);
    }
    if (request.kind === 'known.localImport.resolve') return importer.resolve(request.commandId, request.nativeId);
    stopRequests.delete(request.commandId);
    return importer.resume(request.commandId);
  });
  void wakeLocalImports().catch(() => undefined);
  return { ok: true, status: plan };
}
