import { readNativeFolderDescriptions } from '../folder-description-native.js';
import { supportedBookmarkTree } from '../bookmark-folder-policy.js';
import { readNativeBookmarkAnnotations } from '../bookmark-annotation-native.js';
import { readDefaultFolder } from '../save-folder.js';
import { readUiLanguage } from '../i18n.js';
import { devicePreferencePatch } from '../device-bookmark-preferences.js';
import { storedLocalClassificationForm } from '../classification-local-session.js';
import { exclusionIds } from '../bookmark-subscriptions/guards.js';
import { listBrowserCaptureHistory } from '../capture/local-history.js';
import { browserHistoryStore } from '../capture/browser-history-store.js';
import { currentCaptureScope, assertCaptureOwner } from '../sw/capture-native.js';
import { captureStore } from '../sw/capture.js';
import { backupHistoryStore } from '../sw/capture-history.js';
import { readEffectiveBookmarkPreferences } from '../sw/bookmark-preferences.js';
import { hasBookmarkPermission } from '../sw/runtime.js';
import { bookmarkUrl } from '../generated/import-preview-validators.js';
import { supportedBackupNodes } from './export-supported.js';
import { backupHistory, backupNativeNodes, bookmarkHtml, MAX_BACKUP_BYTES, parseBackupAiConfig, parseLocalBackup, type BackupAiConfig, type BackupHistory } from './codec.js';
import { exportPortableSources } from '../site-adapters/portable.js';
import { siteLedger } from '../site-adapters/source-runtime.js';

/** Optional connection settings must never leak URL credentials or prevent a data backup. */
async function readBackupAiConfig(): Promise<BackupAiConfig | null> {
  try {
    const credential = await storedLocalClassificationForm();
    if (!credential) return null;
    const config = parseBackupAiConfig({ presetId: credential.presetId, endpoint: credential.endpoint, model: credential.model,
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
      ...(credential.gatewayId === undefined ? {} : { gatewayId: credential.gatewayId }) });
    if (!config) return null;
    const endpoint = new URL(config.endpoint);
    // Any query or fragment may carry a credential. Omit the whole connection
    // instead of stripping URL parts and silently changing provider semantics.
    return endpoint.search || endpoint.hash ? null : config;
  } catch {
    return null;
  }
}

export type BackupExportRequest = { readonly kind: 'known.localBackup.export'; readonly format: 'html' | 'json' };
export function validBackupExportRequest(value: unknown): value is BackupExportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return Object.keys(raw).length === 2 && raw.kind === 'known.localBackup.export' && ['html', 'json'].includes(String(raw.format));
}
export async function exportLocalBackup(request: BackupExportRequest) {
  if (!await hasBookmarkPermission()) throw new Error('permission_required');
  const tree = supportedBookmarkTree(await chrome.bookmarks.getTree()), descriptions = await readNativeFolderDescriptions(tree);
  const annotations = await readNativeBookmarkAnnotations(tree);
  const excluded = await exclusionIds();
  const nativeNodes = backupNativeNodes(tree[0]?.children ?? [], descriptions, excluded, annotations);
  const nodes = request.format === 'json' ? supportedBackupNodes(nativeNodes) : nativeNodes;
  const skippedBookmarks = nativeNodes.length - nodes.length;
  let skippedHistory = 0;
  let content: string;
  if (request.format === 'html') content = bookmarkHtml(nodes);
  else {
    const scope = await currentCaptureScope(), history: BackupHistory[] = [];
    let before: readonly [number, string] | undefined;
    for (;;) {
      const page = await listBrowserCaptureHistory(captureStore, scope, before, backupHistoryStore, browserHistoryStore);
      history.push(...page.map(backupHistory));
      if (history.length > 100_000) throw new Error('node_limit');
      const last = page.at(-1); if (!last || page.length < 50) break;
      before = [last.createdAt, last.captureId];
    }
    const [preferences, language, folder, aiConfig] = await Promise.all([
      readEffectiveBookmarkPreferences(), readUiLanguage(), readDefaultFolder(), readBackupAiConfig(),
    ]);
    await assertCaptureOwner(scope);
    const supportedHistory = history.filter(item => bookmarkUrl(item.url));
    skippedHistory = history.length - supportedHistory.length;
    const siteAdapters = await exportPortableSources(siteLedger.db, new Set(nodes.map(n => n.sourceId)));
    content = JSON.stringify(parseLocalBackup({ format: 'known-browser-backup', version: 1, exportedAt: Date.now(), nodes, history: supportedHistory,
      ...(siteAdapters ? { siteAdapters } : {}),
      preferences: devicePreferencePatch(preferences), language, defaultFolderSourceId: nodes.some(node => node.sourceId === folder?.folderNativeId) ? folder!.folderNativeId : null, aiConfig }), null, 2);
  }
  if (new TextEncoder().encode(content).byteLength > MAX_BACKUP_BYTES) throw new Error('input_too_large');
  return { ok: true, content, skippedBookmarks, skippedHistory,
    filename: `known-bookmarks-${new Date().toISOString().slice(0, 10)}.${request.format}`, mime: request.format === 'html' ? 'text/html' : 'application/json' };
}
