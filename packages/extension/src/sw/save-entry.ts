import { openCaptureBatch } from './capture-batch.js';
import { startCapture, resumeCapture } from './capture.js';
import { presentSaveFeedback } from '../save-feedback.js';
import { automationSaveLine } from '../save-status.js';
import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import { type NativeSavePage } from '../save-entry.js';
import {
  runNativeSave, SAVE_PAGE_MENU_ID, SAVE_WINDOW_COMMAND, SAVE_WINDOW_MENU_ID, type NativeSaveKind,
  type NativeSaveResult,
} from '../save-native.js';
import { COLLECTION_BINDING, hasBookmarkPermission, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';
import { readEffectiveBookmarkPreferences } from './bookmark-preferences.js';
import { initI18n, onUiLanguageChanged, t } from '../i18n.js';

export { SAVE_PAGE_MENU_ID, SAVE_WINDOW_COMMAND, SAVE_WINDOW_MENU_ID };

export function installNativeSaveEntries(): void {
  try {
    chrome.commands.onCommand.addListener((command) => {
      if (command === SAVE_WINDOW_COMMAND) void openCaptureBatch('all').catch(() => presentSaveFeedback({ code: 'no_page', entry: 'window' }));
    });
  } catch { /* Commands are optional; the popup shortcut still opens the same save path. */ }
  try {
    if (!('contextMenus' in chrome) || !chrome.contextMenus) return;
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === SAVE_WINDOW_MENU_ID || info.menuItemId === 'known-save-selected-tabs') {
        void openCaptureBatch(info.menuItemId === SAVE_WINDOW_MENU_ID ? 'all' : 'selected', tab?.windowId)
          .catch(() => presentSaveFeedback({ code: 'no_page', entry: 'window' }));
      } else if (info.menuItemId === SAVE_PAGE_MENU_ID || info.menuItemId === 'known-save-link') {
        const link = info.menuItemId === 'known-save-link';
        const url = link ? info.linkUrl : info.pageUrl ?? tab?.url;
        const title = link ? info.selectionText?.trim() || url : tab?.title || url;
        if (!url || !title) return;
        void startCapture({ commandId: crypto.randomUUID(), source: link ? 'context-link' : 'context-page',
          url, title, tabId: tab?.id, allowUnverifiedCloud: true }).then(resumeCapture).then(task => presentSaveFeedback({
          code: task.save === 'local-saved' || task.disposition === 'existing' ? 'saved' : 'busy', entry: 'page',
          message: task.disposition === 'existing' ? t('save_alreadySavedOpenCapture', 'Already saved. Open capture history to choose its location.')
            : task.save === 'unknown' ? t('save_checkingPreviousSaveResult', 'Checking the previous save result. Open capture history for details.')
              : task.save === 'local-saved' ? automationSaveLine(task.automation)?.text ?? t('save_savedBrowserPeriod', 'Saved to this browser.')
                : t('save_couldNotSaveOpen', 'Could not save. Open capture history to review the task.'),
          ...(task.nativeId ? { nativeId: task.nativeId } : {}),
        })).catch(error => presentSaveFeedback({ code: error instanceof Error && error.message === 'capture_target_required'
          ? 'folder_required' : 'permission_required', entry: 'page' }));
      }
    });
    /* Titles follow the catalog in force: menus persist across worker sleeps,
       so they re-create after the stored language resolves and on every change. */
    const installMenuTitles = () => chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: SAVE_PAGE_MENU_ID, title: t('save_savePage', 'Save this page'), contexts: ['page'] });
      chrome.contextMenus.create({ id: 'known-save-link', title: t('save_saveLink', 'Save this link'), contexts: ['link'] });
      chrome.contextMenus.create({ id: 'known-save-selected-tabs', title: t('save_previewSelectedTabs', 'Preview selected tabs'), contexts: ['page', 'action'] });
      chrome.contextMenus.create({
        id: SAVE_WINDOW_MENU_ID, title: t('save_saveTabsWindow', 'Save tabs in this window'), contexts: ['page', 'action'],
      });
    });
    void initI18n().then(installMenuTitles, installMenuTitles);
    onUiLanguageChanged(installMenuTitles);
  } catch { /* contextMenus is optional; page/shortcut saves still use chrome.bookmarks.create. */ }
}

export async function saveThroughNativeEntry(
  kind: NativeSaveKind, pages?: readonly NativeSavePage[],
): Promise<NativeSaveResult> {
  const permitted = await hasBookmarkPermission();
  const queryTabs = pages ? async () => pages : undefined;
  if (!permitted) {
    return runNativeSave({ kind, hasPermission: false, mountNativeIds: [], ...(queryTabs ? { queryTabs } : {}) });
  }
  let collectionId: string | undefined;
  let mountNativeIds: readonly string[] = [];
  let privateNativeIds: readonly string[] = [];
  try {
    const scope = await currentSyncScope();
    collectionId = collectionId ?? scope.collectionId;
    const boundary = await resolveIngressBoundary(syncState, scope);
    mountNativeIds = [...boundary.selectedNative];
    privateNativeIds = [...boundary.privateNative];
  } catch { /* Offline: remembered folder + save-context cache still place the native row. */ }
  if (!collectionId) {
    const stored = (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING];
    if (typeof stored === 'string' && stored) collectionId = stored;
  }
  const preferences = await readEffectiveBookmarkPreferences().catch(() => ({ bookmarkInsertPosition: 'bottom' as const }));
  return runNativeSave({
    kind, hasPermission: true, mountNativeIds, privateNativeIds,
    insertPosition: preferences.bookmarkInsertPosition,
    ...('foldersFirst' in preferences && preferences.foldersFirst ? { foldersFirst: true } : {}),
    ...(collectionId ? { collectionId } : {}),
    ...(queryTabs ? { queryTabs } : {}),
  });
}
