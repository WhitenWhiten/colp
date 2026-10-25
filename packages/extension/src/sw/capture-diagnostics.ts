import { collectSyncDiagnostics } from '../sync-diagnostics.js';
import { currentSyncScope } from './scope.js';
import { syncState } from './runtime.js';
import { readHealthDeliveryFailure } from './health-delivery-status.js';
import { readWatchdogFacts } from './sync-watchdog.js';
import { handleSyncProgressRequest } from './sync-progress.js';
import { captureRuntimeView } from './capture-control.js';
import { currentCaptureScope, assertCaptureOwner } from './capture-native.js';
import { captureStore } from './capture.js';
import { handleBookmarkPreferencesRequest } from './bookmark-preferences.js';
import { readCaptureControl } from '../capture/control.js';
export async function captureDiagnostics() {
  const scope = await currentCaptureScope();
  const results = await Promise.allSettled([
    chrome.permissions.contains({ permissions: ['bookmarks'] }), chrome.permissions.contains({ permissions: ['tabs'] }),
    handleBookmarkPreferencesRequest({ kind: 'known.bookmark.preferences.local' }), readCaptureControl(scope),
    captureStore.listForOwner(scope), captureRuntimeView(),
    currentSyncScope({ allowStopped: true }).then(scope => collectSyncDiagnostics(syncState, scope)),
    handleSyncProgressRequest(),
    // The facts Status shows and Copy details copies, so the three never tell different stories (C-18).
    currentSyncScope({ allowStopped: true }).then(scope => readHealthDeliveryFailure(chrome.storage.local, scope, Date.now())),
    currentSyncScope({ allowStopped: true }).then(scope => readWatchdogFacts(chrome.storage.local, scope)),
  ]);
  await assertCaptureOwner(scope);
  const bookmarks = results[0].status === 'fulfilled' ? results[0].value : null;
  const tabs = results[1].status === 'fulfilled' ? results[1].value : null;
  const preferences = results[2].status === 'fulfilled' && results[2].value.ok ? results[2].value : null;
  const control = results[3].status === 'fulfilled' ? results[3].value : null;
  const tasks = results[4].status === 'fulfilled' ? results[4].value : [];
  const sync = results[6].status === 'fulfilled' ? results[6].value : null;
  const syncAttention = sync?.engine.phase === 'error' || sync?.engine.recoveryFrozen && sync.engine.errorCode !== null;
  const reason = bookmarks === false ? 'permission_required' : !scope.accountId ? 'sign_in_required' : !navigator.onLine ? 'offline'
    : preferences?.conflict ? 'preferences_conflict' : tasks.some(task => task.save === 'unknown') ? 'save_result_unknown'
      : syncAttention || tasks.some(task => task.sync === 'attention') ? 'sync_attention' : control?.paused ? 'paused' : 'ready';
  const classificationReason = results[5].status === 'fulfilled' ? results[5].value.state : 'status_unavailable';
  return { ok: true, diagnostic: { version: 1, checkedAt: new Date().toISOString(), reason: reason === 'ready' ? classificationReason : reason, online: navigator.onLine,
    signedIn: Boolean(scope.accountId), permissions: { bookmarks, tabs }, paused: control?.paused ?? null,
    preferences: preferences ? { mode: preferences.preferences.captureMode ?? 'manual', pending: preferences.pending,
      conflict: preferences.conflict, learning: preferences.preferences.learnFromCorrections !== false } : null,
    sync,
    progress: results[7].status === 'fulfilled' && results[7].value.ok ? results[7].value.progress : null,
    syncHealth: { reportsFailing: results[8].status === 'fulfilled' ? results[8].value ?? null : null,
      ...(results[9].status === 'fulfilled' && results[9].value ? results[9].value : {}) },
    inspectedRecentTasks: tasks.length,
    // Allowlist only: never serialize task URLs, titles, account ids, cookies or bearer state.
    tasks: tasks.map(task => ({ captureId: task.captureId, save: task.save, classification: task.classification, sync: task.sync, reason: task.reason })),
  } };
}
