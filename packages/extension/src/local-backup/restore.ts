import { createFolderDescriptionStore } from '../folder-description-store.js';
import { assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import type { LocalImportItem, LocalImportPlan } from '../local-import/contracts.js';
import { restoreItemAnnotations } from '../local-import/annotations.js';
import { backupHistoryStore } from '../sw/capture-history.js';
import { assertCaptureOwner } from '../sw/capture-native.js';
import { restoreDeviceBookmarkPreferences } from '../sw/bookmark-preferences.js';
import { FOLDER_DEFAULT_BINDING, DEVICE_FOLDER_SCOPE } from '../save-folder.js';
import { setUiLanguage } from '../i18n.js';
import { clearLocalClassificationContext, storedLocalClassification, LOCAL_CLASSIFICATION_DRAFT, LOCAL_CLASSIFICATION_ENABLED } from '../classification-local-session.js';
import { restorePortableSources } from '../site-adapters/portable.js';
import { siteLedger } from '../site-adapters/source-runtime.js';

/** Retrying this phase only repeats local idempotent writes, never native creates or old commands. */
export async function restoreBackupMetadata(plan: LocalImportPlan, items: readonly LocalImportItem[]) {
  const data = plan.backup, owner = plan.restoreOwner;
  if (!data || !owner) throw new Error('backup_restore_unavailable');
  await assertCaptureOwner(owner);
  const nativeIds = new Map<string, string>(), descriptions = createFolderDescriptionStore();
  try {
    for (const item of items) {
      if (!item.nativeId) throw new Error('local_import_item_missing');
      if (item.sourceId) nativeIds.set(item.sourceId, item.nativeId);
      if (item.description !== undefined) {
        await assertPersonalNativeAllowed(item.nativeId);
        const [node] = await chrome.bookmarks.get(item.nativeId);
        if (!node || node.url !== undefined || node.unmodifiable) throw new Error('capture_target_unavailable');
        await descriptions.save(node, item.description);
      }
    }
    await restoreItemAnnotations(items);
    await assertCaptureOwner(owner);
    await backupHistoryStore.restore(owner, plan.commandId, data.history, nativeIds);
    if (data.siteAdapters) await restorePortableSources(siteLedger.db, plan.commandId, data.siteAdapters, nativeIds);
    if (plan.restoreSettings) {
      await assertCaptureOwner(owner);
      await restoreDeviceBookmarkPreferences({ ...data.preferences, captureMode: 'manual' });
      const defaultFolder = data.defaultFolderSourceId ? nativeIds.get(data.defaultFolderSourceId) : undefined;
      if (defaultFolder) await chrome.storage.local.set({ [FOLDER_DEFAULT_BINDING]: { collectionId: DEVICE_FOLDER_SCOPE, folderNativeId: defaultFolder } });
      const existingKey = await storedLocalClassification();
      await clearLocalClassificationContext();
      if (!existingKey) {
        await chrome.storage.local.set({ [LOCAL_CLASSIFICATION_ENABLED]: false });
        if (data.aiConfig) await chrome.storage.local.set({ [LOCAL_CLASSIFICATION_DRAFT]: data.aiConfig });
        else await chrome.storage.local.remove(LOCAL_CLASSIFICATION_DRAFT);
      }
      await setUiLanguage(data.language);
    }
  } finally { descriptions.close(); }
}
