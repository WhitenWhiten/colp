import { validSubscriptionSender } from './bookmark-subscriptions/commands.js';
import { validateCommand as validSubscriptionRequest } from './bookmark-subscriptions/commands.js';
import { handleSubscriptionRequest } from './bookmark-subscriptions/worker.js';
import { acceptExternalReference } from './bookmark-subscriptions/external.js';
import { SUBSCRIPTION_ALARM, wakeSubscriptions } from './bookmark-subscriptions/runtime.js';
import { loadConfig as loadSubscriptionConfig } from './sw/scope.js';
import { validCaptureLinks, captureLinks } from './sw/capture-links.js';
import { validCaptureControlRequest } from './capture/runtime-control.js';
import { handleCaptureControl } from './sw/capture-control.js';
import { validCaptureLearning, handleCaptureLearning } from './sw/capture-learning.js';
import { validCaptureRequest, validCapturePanelRequest } from './capture/messages.js';
import { handleCapturePanel } from './sw/capture-feedback.js';
import { validCaptureEdit, validCaptureEditCancel } from './capture/editor.js';
import { handleCaptureEdit, handleCaptureEditCancel } from './sw/capture-editor.js';
import { flushCaptureFeedback } from './sw/capture-feedback-upload.js';
import { validCaptureNavigation, handleCaptureNavigation } from './sw/capture-navigation.js';
import { validCaptureHistory, handleCaptureHistory, captureCloudAvailable } from './sw/capture-history.js';
import { captureDiagnostics } from './sw/capture-diagnostics.js';
import { flushCaptureReports } from './sw/capture-report.js';
import { validCaptureBatchRequest } from './capture/batch.js';
import { handleCaptureBatch, openCaptureBatch, wakeCaptureBatches } from './sw/capture-batch.js';
import { CAPTURE_ALARM, handleCaptureRequest, wakeCaptures } from './sw/capture.js';
import { flushBookmarkPreferences, handleBookmarkPreferencesRequest } from './sw/bookmark-preferences.js';
import { installClassificationAuthorityListener, retireClassificationConfirmations } from './sw/classification-authority.js';
import { validClassificationRequest } from './classification-messages.js';
import { validFolderDescriptionNotice } from './folder-description-native.js';
import { validBookmarkAnnotationNotice } from './bookmark-annotation-notice.js';
import { handleClassificationRequest } from './sw/classification.js';
import { validReplicaRebuildRequest } from './replica-rebuild.js';
import { replicaRebuilder } from './sw/scope-rebuild.js';
import { writeAuthSnapshot } from './auth-snapshot.js';
import { FAVICON_SIDECAR_ALARM } from './favicon-sidecar-store.js';
import { handle, onExtensionInstalled } from './sw/auth.js';
import { handleServerDisconnect, validServerDisconnectRequest } from './sw/server-disconnect.js';
import { browserPersonalSyncPolicy } from './personal-sync-policy.js';
import { configurePersonalSyncTransport } from './personal-sync-fetch.js';
import { validPersonalSyncCommand, trustedLifecyclePage } from './personal-sync-commands.js';
import { onBeforePersonalSyncDisconnect, personalSyncLifecycle } from './sw/personal-sync.js';
import { validDeviceHistoryClear } from './device-history-clear.js';
import { browserHistoryStore } from './capture/browser-history-store.js';
import { validMetadataReassociationCommand } from './metadata-reassociation-commands.js';
import { handleMetadataReassociation } from './sw/metadata-reassociation.js';
import { configureLibraryMetadata } from './sw/library-metadata.js';
import { validMetadataPolicyConfigureRequest, validMetadataPolicyStatusRequest, readMetadataPolicyStatus } from './metadata-policy-status.js';
import { browserMetadataSyncPolicy } from './metadata-sync-policy.js';
import { bookmarkListenerLifecycle, recoverBookmarkEventsAfterEngineSettles } from './sw/bookmarks.js';
import { FOLDERS_FIRST_ALARM, installNativeFoldersFirst, installNativeFoldersFirstStorageListener,
  scheduleNativeFoldersFirst } from './sw/bookmark-folders-first.js';
import { installWorkerMetadataWake } from './sw/metadata-sync-wake.js';
import { bindLibraryOnStartup } from './sw/library.js';
import { handleSyncEngineRequest, scheduleSyncEngineWake } from './sw/engine.js';
import { readHealthDeliveryFailure } from './sw/health-delivery-status.js';
import { syncWatchdog } from './sw/sync-watchdog-runtime.js';
import { REPLICA_HEALTH_ALARM, REPLICA_HEALTH_PERIOD_MINUTES, reportReplicaDisconnected, reportReplicaHealth } from './sw/replica-health.js';
import { handleSyncStateEvidence } from './sw/evidence.js';
import { clearFaviconForCurrentScope, drainFaviconSidecarsForCurrentScope, readFaviconPolicyForCurrentScope, resolveFaviconSaveContext, resolveLocalSaveContext } from './sw/favicon.js';
import { handleFirstRunRequest, handleScopeCommand } from './sw/first-run.js';
import { handleBatchRequest } from './sw/batch.js';
import { validOrganizeRequest } from './bookmark-organizer.js';
import { handleOrganizeRequest } from './sw/bookmark-organizer.js';
import { validPinRequest } from './bookmark-pin-messages.js';
import { handlePinRequest, PIN_PLACEMENT_ALARM, placeDeferredUnpins } from './sw/bookmark-pins.js';
import { handleNativeWaitRequest, type NativeWaitAuthority, type NativeWaitDeps } from './sw/native-wait.js';
import { handleRemoteDeleteRequest } from './sw/remote-delete.js';
import { handleImportRequest } from './sw/import.js';
import { handleIngressDiagnosticsRequest, type IngressDiagnosticsDeps } from './sw/ingress-diagnostics.js';
import { handleSyncAttentionRequest, type SyncAttentionDeps } from './sw/sync-attention.js';
import { handleSyncProgressRequest } from './sw/sync-progress.js';
import { validBatchRequest, validConnectivityRequest, validFaviconRequest, validFirstRunRequest, validImportRequest,
  validIngressDiagnosticsRequest,
  validBookmarkPreferencesRequest, validNativeSaveRequest, validNativeWaitRequest, validRemoteDeleteRequest, validRequest, validRootRequest,
  validSaveStatusRequest, validScopeCommandRequest, validSender, validSyncAttentionRequest, validSyncEngineRequest, validSyncRetryRequest,
  validSyncProgressRequest,
  validSyncStateEvidenceRequest } from './sw/messages.js';
import { handleRootRequest, resumeBookmarksAfterPermissionGrant } from './sw/roots.js';
import { ensurePeriodicAlarm } from './sw/reconcile-alarm.js';
import { purgeLegacyLocalAuthority } from './sw/credential-storage.js';
import { BOOKMARK_RECONCILE_ALARM, BOOKMARK_RECONCILE_PERIOD_MINUTES, BOOKMARK_RECOVERY_ALARM,
  hasBookmarkPermission, safeError, store, sw, syncState, workCoordinator } from './sw/runtime.js';
import { installNativeSaveEntries, saveThroughNativeEntry } from './sw/save-entry.js';
import { initI18n } from './i18n.js';
import { logBackgroundFailure } from './sw/background-failure.js';
import { validLocalImportRequest } from './local-import/contracts.js';
import { handleLocalImport, LOCAL_IMPORT_ALARM, wakeLocalImports } from './sw/local-import.js';
import { exportLocalBackup, validBackupExportRequest } from './local-backup/export.js';
import { handleSaveStatus } from './sw/save-status.js';
import { isBrowserConfigCommand, isBrowserRulesetCommand, isBrowserRunCommand, validAutomationRequest, validBrowserRuleCommand } from './automation/messages.js';
import { handleBrowserRuleCommand } from './sw/automation-browser.js';
import { handleConfigCommand } from './sw/automation-config.js';
import { handleRulesetCommand } from './sw/automation-ruleset.js';
import { handleRunCommand } from './sw/automation-run.js';
import { handleSubscriptionCommand, installRuleSubscriptions, refreshDueSubscriptions, RULE_SUBSCRIPTION_ALARM } from './sw/automation-subscriptions.js';
import { isSubscriptionCommand } from './automation/subscription-messages.js';
import { handleRiskCommand, refreshDueRiskLists } from './sw/risk.js';
import { installRiskBrowsing } from './sw/risk-browse.js';
import { POPUP_RISK_KINDS, validRiskCommand } from './risk/risk-messages.js';
import { accountLink, AUTOMATION_ALARM, handleAutomationRequest, installAutomationRuntime, refreshAutomation } from './sw/automation.js';
import { installObservedCreates, resumeObservedCreates } from './sw/automation-observed.js';
import { currentSyncScope, stateAfterFailure } from './sw/scope.js';
import { createSyncEffectAuthority } from './sync-effect-authority.js';
import { createChromePullBookmarkApi } from './pull-bookmark-api.js';
import type { BatchResponse, ExtensionResponse, ImportResponse,
  IngressDiagnosticsResponse, NativeSaveResponse, NativeWaitResponse, RemoteDeleteResponse, RootResponse,
  SaveStatusResponse, SyncAttentionResponse, SyncProgressResponse, FirstRunOrScopeResponse, FirstRunRequest } from './types.js';

configurePersonalSyncTransport(browserPersonalSyncPolicy());
void bindLibraryOnStartup().catch((error) => logBackgroundFailure('startup.bind-library', error));
void wakeSubscriptions('startup');
bookmarkListenerLifecycle.install();
installNativeFoldersFirst();
installNativeFoldersFirstStorageListener();
installWorkerMetadataWake();
scheduleNativeFoldersFirst();
installClassificationAuthorityListener();
void initI18n();
installNativeSaveEntries();
installAutomationRuntime();
installRuleSubscriptions();
installRiskBrowsing();
installObservedCreates();
void wakeLocalImports().catch((error) => logBackgroundFailure('startup.local-imports', error));
chrome.runtime.onStartup.addListener(() => {
  void flushBookmarkPreferences().catch((error) => logBackgroundFailure('startup.bookmark-preferences', error));
  void wakeCaptures().catch((error) => logBackgroundFailure('startup.captures', error));
  void wakeCaptureBatches().catch((error) => logBackgroundFailure('startup.capture-batches', error));
  void flushCaptureFeedback().catch((error) => logBackgroundFailure('startup.capture-feedback', error));
  void flushCaptureReports().catch((error) => logBackgroundFailure('startup.capture-reports', error));
});
chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.permissions?.includes('bookmarks')) {
    installNativeFoldersFirst();
    void resumeBookmarksAfterPermissionGrant().finally(() => scheduleNativeFoldersFirst());
  }
});
chrome.runtime.onStartup.addListener(() => { void recoverBookmarkEventsAfterEngineSettles('startup'); });
// An upgraded profile still holds the pre-split plaintext bearer in
// `storage.local`; nothing reads it any more, but leaving it there would keep
// the exposure the split was meant to end.
void purgeLegacyLocalAuthority(chrome.storage.local).catch((error) => logBackgroundFailure('startup.legacy-authority-purge', error));
// Registered on every worker boot as well as at install: the alarm is
// idempotent, and re-creating it repairs a registration the platform dropped.
ensureBookmarkReconcileAlarm();
void ensurePeriodicAlarm(chrome, REPLICA_HEALTH_ALARM, REPLICA_HEALTH_PERIOD_MINUTES);
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') void retireClassificationConfirmations().catch((error) => logBackgroundFailure('install.classification-confirmations', error));
  return onExtensionInstalled(details);
});
// No action.onClicked listener: the manifest declares default_popup, so the
// toolbar click always opens the popup and that event never fires.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FOLDERS_FIRST_ALARM) scheduleNativeFoldersFirst();
  if (alarm.name === PIN_PLACEMENT_ALARM) void placeDeferredUnpins().catch((error) => logBackgroundFailure('alarm.pin-placement', error));
  if (alarm.name === LOCAL_IMPORT_ALARM) void wakeLocalImports().catch((error) => logBackgroundFailure('alarm.local-imports', error));
  if (alarm.name === SUBSCRIPTION_ALARM) void wakeSubscriptions('alarm');
  if (alarm.name === CAPTURE_ALARM) {
    void wakeCaptures().catch((error) => logBackgroundFailure('alarm.captures', error));
    void wakeCaptureBatches().catch((error) => logBackgroundFailure('alarm.capture-batches', error));
    void flushCaptureFeedback().catch((error) => logBackgroundFailure('alarm.capture-feedback', error));
    void flushCaptureReports().catch((error) => logBackgroundFailure('alarm.capture-reports', error));
  }
  if (alarm.name === 'known-sync-engine') scheduleSyncEngineWake('alarm');
  if (alarm.name === REPLICA_HEALTH_ALARM) void reportReplicaHealth();
  if (alarm.name === FAVICON_SIDECAR_ALARM) void drainFaviconSidecarsForCurrentScope();
  if (alarm.name === BOOKMARK_RECOVERY_ALARM) void recoverBookmarkEventsAfterEngineSettles('alarm');
  if (alarm.name === BOOKMARK_RECONCILE_ALARM) void recoverBookmarkEventsAfterEngineSettles('alarm');
  // Rule sets and risk lists refresh on the same hourly tick, each list on its own interval.
  if (alarm.name === RULE_SUBSCRIPTION_ALARM) {
    void refreshDueSubscriptions().catch((error) => logBackgroundFailure('alarm.subscriptions', error));
    void refreshDueRiskLists().catch((error) => logBackgroundFailure('alarm.risk-lists', error));
  }
  if (alarm.name === AUTOMATION_ALARM) {
    void refreshAutomation().catch((error) => logBackgroundFailure('alarm.automation', error));
    void resumeObservedCreates().catch((error) => logBackgroundFailure('alarm.observed-creates', error));
  }
});
self.addEventListener('online', (event) => {
  if (event.isTrusted && navigator.onLine === true) {
    void wakeSubscriptions('online');
    scheduleSyncEngineWake('online', 0, true);
    void wakeCaptures().catch((error) => logBackgroundFailure('online.captures', error));
    void wakeCaptureBatches().catch((error) => logBackgroundFailure('online.capture-batches', error));
    void flushBookmarkPreferences().catch((error) => logBackgroundFailure('online.bookmark-preferences', error));
    void flushCaptureFeedback().catch((error) => logBackgroundFailure('online.capture-feedback', error));
    void flushCaptureReports().catch((error) => logBackgroundFailure('online.capture-reports', error));
  }
});

/** S1 / B0-1: production dependencies for the native-wait confirmation handler. */
const nativeWaitDeps: NativeWaitDeps = {
  scope: currentSyncScope, store: syncState, permissionGranted: hasBookmarkPermission,
  wake: () => { scheduleSyncEngineWake('manual'); },
};

/** S7 / B2 (SR-09·SR-11·SR-13): the read-only attention read shared by popup and options. */
const syncAttentionDeps: SyncAttentionDeps = { scope: currentSyncScope, store: syncState,
  rebuildPending: () => replicaRebuilder().hasPending(), bookmarkPermission: hasBookmarkPermission,
  healthDelivery: scope => readHealthDeliveryFailure(chrome.storage.local, scope, Date.now()), watchdog: syncWatchdog };

// A deliberate disconnect tells the Sync center before this browser leaves its library (C-17d).
onBeforePersonalSyncDisconnect(reportReplicaDisconnected);

/** SR-10 / A-08: the read-only ingress-diagnostic read behind the options list. */
const ingressDiagnosticsDeps: IngressDiagnosticsDeps = { scope: currentSyncScope, store: syncState };

void workCoordinator.run('engine', () => replicaRebuilder().resume())
  .catch((error) => logBackgroundFailure('startup.replica-rebuild-resume', error))
  .then(() => recoverBookmarkEventsAfterEngineSettles('manual', { workerBoot: true }));

/**
 * Guarantees the reconciliation alarm exists, WITHOUT restarting its clock.
 *
 * `chrome.alarms.create` cancels and replaces a registration with the same name,
 * which reschedules it for a full period from now. This worker is cold-started
 * constantly while the user browses, so calling `create` unconditionally on
 * every boot pushed the alarm forward on each wake and the 180-minute
 * reconciliation could never come due. `ensurePeriodicAlarm` gets first and
 * leaves an existing registration exactly as the platform scheduled it.
 */
function ensureBookmarkReconcileAlarm(): void {
  void ensurePeriodicAlarm(chrome, BOOKMARK_RECONCILE_ALARM, BOOKMARK_RECONCILE_PERIOD_MINUTES);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!validSender(sender)) return false;
  if (validDeviceHistoryClear(message)) {
    if (!trustedLifecyclePage(sender, chrome.runtime.id)) return false;
    void browserHistoryStore.clear().then(() => respond({ ok: true }), error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validMetadataReassociationCommand(message)) {
    if (!trustedLifecyclePage(sender, chrome.runtime.id)) return false;
    void handleMetadataReassociation(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validPersonalSyncCommand(message)) {
    if (!trustedLifecyclePage(sender, chrome.runtime.id, message.kind === 'known.personalSync.status')) return false;
    void personalSyncLifecycle().handle(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validMetadataPolicyConfigureRequest(message)) {
    if (!trustedLifecyclePage(sender, chrome.runtime.id)) return false;
    void workCoordinator.run('auth', () => configureLibraryMetadata(message.enabled))
      .then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validMetadataPolicyStatusRequest(message)) {
    void (async () => {
      const context = await store.fence.capture();
      const credential = await store.loadCredential();
      const collectionId = (await chrome.storage.local.get('known.sync.collection.v1'))['known.sync.collection.v1'];
      if (!credential?.subject || typeof collectionId !== 'string') throw new Error('not_connected');
      const result = await readMetadataPolicyStatus(chrome.storage.local, {
        serverOrigin: credential.serverOrigin, accountId: credential.subject, collectionId }, browserMetadataSyncPolicy());
      await store.assertWritable(context.generation);
      return result;
    })().then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validBackupExportRequest(message)) {
    if (!validSubscriptionSender(sender, chrome.runtime.id)) return false;
    void exportLocalBackup(message).then(respond, error => respond({ ok: false, error: safeError(error) })); return true;
  }
  if (validLocalImportRequest(message)) {
    if (!validSubscriptionSender(sender, chrome.runtime.id)) return false;
    void handleLocalImport(message).then(respond, error => respond({ ok: false, error: safeError(error) })); return true;
  }
  if (validSubscriptionRequest(message)) {
    if (!validSubscriptionSender(sender, chrome.runtime.id)) return false;
    void handleSubscriptionRequest(message).then(data => respond({ok:true,data}), error => respond({ok:false,error:safeError(error)}));
    return true;
  }
  if (message && typeof message === 'object' && !Array.isArray(message) && Object.keys(message).length === 1
    && (message as { kind?: unknown }).kind === 'known.capture.diagnostics') {
    void captureDiagnostics().then(respond, error => respond({ ok: false, error: safeError(error) })); return true;
  }
  if (message && typeof message === 'object' && !Array.isArray(message) && Object.keys(message).length === 1
    && (message as { kind?: unknown }).kind === 'known.capture.cloudAvailable') {
    void captureCloudAvailable().then(respond, () => respond({ ok: true, available: false })); return true;
  }
  if (validCaptureLinks(message)) {
    void captureLinks(message.captureId).then(respond, error => respond({ ok: false, error: safeError(error) })); return true;
  }
  if (validCaptureControlRequest(message)) {
    void handleCaptureControl(message).then(respond, error => respond({ ok: false, error: safeError(error) })); return true;
  }
  if (validCaptureLearning(message)) {
    void handleCaptureLearning(message).then(respond, error => respond({ ok: false, error: safeError(error) })); return true;
  }
  if (validCaptureHistory(message)) {
    void handleCaptureHistory(message).then(respond, error => respond({ ok: false, error: safeError(error) })); return true;
  }
  if (validCaptureNavigation(message)) {
    void handleCaptureNavigation(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validCaptureEdit(message)) {
    void handleCaptureEdit(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validCaptureEditCancel(message)) {
    void handleCaptureEditCancel(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validCapturePanelRequest(message)) {
    void handleCapturePanel(message, sender).then(result => {
      respond(result); if (message.kind === 'known.capture.feedback') void flushCaptureFeedback().catch((error) => logBackgroundFailure('message.capture-feedback', error));
    }, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validCaptureBatchRequest(message)) {
    void handleCaptureBatch(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validCaptureRequest(message)) {
    void handleCaptureRequest(message, sender).then(respond,
      error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validFolderDescriptionNotice(message) || validBookmarkAnnotationNotice(message)) {
    void scheduleSyncEngineWake('manual').catch((error) => logBackgroundFailure('message.sync-engine-wake', error));
    respond({ ok: true }); return false;
  }
  if (validClassificationRequest(message)) {
    // Local previews use the user's own provider and must keep working signed out.
    void workCoordinator.run(message.kind === 'known.classification.local-preview' ? 'local-classification' : 'classification',
      context => handleClassificationRequest(message, context, sender)).then(respond,
      () => respond({ok:false,error:'reconnect_required',status:401,sameRequestRetrySafe:false}));
    return true;
  }
  if (validBookmarkPreferencesRequest(message)) {
    void handleBookmarkPreferencesRequest(message).then(respond,
      () => respond({ ok: false, error: 'preferences_unavailable' }));
    return true;
  }
  if (validConnectivityRequest(message)) {
    if (navigator.onLine !== true) { respond({ ok: true }); return false; }
    const wake = scheduleSyncEngineWake('online', 0, true);
    void flushBookmarkPreferences().catch((error) => logBackgroundFailure('message.bookmark-preferences', error));
    void wake.then(() => respond({ ok: true }), () => respond({ ok: true })); return true;
  }
  if (__KNOWN_EXTENSION_EVIDENCE__ && validSyncStateEvidenceRequest(message)) {
    void handleSyncStateEvidence(message).then(respond);
    return true;
  }
  if (validSyncRetryRequest(message)) {
    void scheduleSyncEngineWake('manual').catch((error) => logBackgroundFailure('message.sync-engine-wake', error));
    respond({ ok: true }); return false;
  }
  if (validSyncEngineRequest(message)) {
    void handleSyncEngineRequest().then(respond); return true;
  }
  if (validSyncAttentionRequest(message)) {
    // Read-only projection: no coordinator lane, no wake, no user gesture.
    void handleSyncAttentionRequest(syncAttentionDeps).then(respond,
      () => respond({ ok: false, error: 'state_unavailable' } satisfies SyncAttentionResponse));
    return true;
  }
  if (validSyncProgressRequest(message)) {
    // Read-only projection like the attention read: no lane, no wake, no gesture.
    void handleSyncProgressRequest().then(respond,
      () => respond({ ok: false, error: 'state_unavailable' } satisfies SyncProgressResponse));
    return true;
  }
  if (validIngressDiagnosticsRequest(message)) {
    // SR-10 / A-08: read-only ledger projection — same rules as the attention
    // read above (no lane, no wake, no gesture); `park:` rows never leave here.
    void handleIngressDiagnosticsRequest(ingressDiagnosticsDeps).then(respond,
      () => respond({ ok: false, error: 'state_unavailable' } satisfies IngressDiagnosticsResponse));
    return true;
  }
  if (validAutomationRequest(message)) {
    void handleAutomationRequest(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validRiskCommand(message)) {
    // Risk settings and lists are changed from Options; the popup checks a page and adds an exception from its notice.
    if (!trustedLifecyclePage(sender, chrome.runtime.id, POPUP_RISK_KINDS.has(message.kind))) return false;
    void handleRiskCommand(message).then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validBrowserRuleCommand(message)) {
    // This browser's own rules are written from Options only.
    if (!trustedLifecyclePage(sender, chrome.runtime.id)) return false;
    void (isBrowserRunCommand(message) ? handleRunCommand(message) : isBrowserConfigCommand(message) ? handleConfigCommand(message)
      : isBrowserRulesetCommand(message) ? handleRulesetCommand(message) : isSubscriptionCommand(message) ? handleSubscriptionCommand(message)
        : handleBrowserRuleCommand(message, accountLink))
      .then(respond, error => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (validSaveStatusRequest(message)) {
    void handleSaveStatus(message.nativeId).then(respond, () => respond({ ok: false, error: 'state_unavailable' } satisfies SaveStatusResponse));
    return true;
  }
  if (validNativeSaveRequest(message)) {
    if (message.entry === 'window') {
      void openCaptureBatch('all').then(() => respond({ ok: true, previewOpened: true }),
        () => respond({ ok: false, error: 'preview_unavailable' }));
      return true;
    }
    void saveThroughNativeEntry(message.entry).then(respond, () => respond({ ok: false, error: 'create_failed' } satisfies NativeSaveResponse));
    return true;
  }
  if (validImportRequest(message)) {
    const operation = workCoordinator.run('import', () => handleImportRequest(message));
    void operation.then(respond, (error) => respond({ ok: false, error: safeError(error) } satisfies ImportResponse));
    return true;
  }
  if (validRootRequest(message)) {
    const operation = workCoordinator.run('root', () => handleRootRequest(message));
    void operation.then(respond, () => respond({ ok: false, error: 'request_invalid' } satisfies RootResponse));
    return true;
  }
  if (validFaviconRequest(message)) {
    if (message.kind === 'known.favicon.save-context-local') {
      void resolveLocalSaveContext().then(respond, () => respond({ ok: false }));
      return true;
    }
    if (message.kind === 'known.favicon.save-context') {
      void resolveFaviconSaveContext().then(respond, () => respond({ ok: false }));
      return true;
    }
    if (message.kind === 'known.favicon.policy') {
      void readFaviconPolicyForCurrentScope().then(respond,
        () => respond({ ok: false, error: 'policy_unavailable' }));
      return true;
    }
    if (message.kind === 'known.favicon.clear') {
      void clearFaviconForCurrentScope(message.nativeId).then(respond,
        () => respond({ ok: false, error: 'clear_failed' }));
      return true;
    }
    void drainFaviconSidecarsForCurrentScope().then(() => respond({ ok: true }), () => respond({ ok: true }));
    return true;
  }
  if (validFirstRunRequest(message)) {
    // known.firstRun.later (KNS-02); known.firstRun.confirm / status (KNS-03 coordinator)
    void handleFirstRunRequest(message).then((response) => {
      bookmarkListenerLifecycle.install();
      if (firstRunNeedsEngine(message, response)) scheduleSyncEngineWake('manual');
      respond(response);
    }, () => respond({ ok: false, error: 'request_invalid' }));
    return true;
  }
  if (validScopeCommandRequest(message)) {
    void handleScopeCommand(message).then(respond, () => respond({ ok: false, error: 'request_invalid' }));
    return true;
  }
  if (validRemoteDeleteRequest(message)) {
    void handleRemoteDeleteRequest(message).then(respond, () => respond({ ok: false, error: 'request_invalid' } satisfies RemoteDeleteResponse));
    return true;
  }
  if (validReplicaRebuildRequest(message)) {
    void workCoordinator.run('engine', () => replicaRebuilder().handle(message)).then(respond,
      () => respond({ ok: false, code: 'rebuild_failed' }));
    return true;
  }
  if (validNativeWaitRequest(message)) {
    // Confirm can create in Chrome; serialize it with Pull/repair over the same
    // tree AND bind the native create to the live authority capability, so a
    // confirmation racing a login/logout/collection switch cannot mutate the
    // tree under the retired identity.
    const operation = message.kind === 'known.nativeWait.list' ? handleNativeWaitRequest(message, nativeWaitDeps)
      : workCoordinator.run('engine', async context => {
        const scope = await currentSyncScope();
        const authority: NativeWaitAuthority = createSyncEffectAuthority({ scope, context,
          api: createChromePullBookmarkApi(), assertWritable: generation => store.assertWritable(generation),
          currentScope: currentSyncScope });
        return handleNativeWaitRequest(message, nativeWaitDeps, authority);
      });
    void operation.then(respond,
      () => respond({ ok: false, code: 'request_invalid' } satisfies NativeWaitResponse));
    return true;
  }
  if (validBatchRequest(message)) {
    const operation = handleBatchRequest(message);
    void operation.then((response) => {
      if (response.ok && message.kind !== 'known.batch.preview' && message.kind !== 'known.batch.status') {
        scheduleSyncEngineWake('manual');
      }
      respond(response);
    }, (error) => respond({ ok: false, error: safeError(error) } satisfies BatchResponse));
    return true;
  }
  if (validOrganizeRequest(message)) {
    void handleOrganizeRequest(message).then(respond);
    return true;
  }
  if (validPinRequest(message)) {
    void handlePinRequest(message).then(respond);
    return true;
  }
  if (validServerDisconnectRequest(message)) {
    const operation = workCoordinator.run('auth', async (context) => {
      const response = await handleServerDisconnect(context, message.nextOrigin);
      try { await writeAuthSnapshot(response.state); } catch { /* snapshot is best-effort */ }
      return response;
    });
    void operation.then(respond, async (error: unknown) => {
      if (!await store.loadCredential()) sw.bindingPromise = undefined;
      respond({ ok: false, state: await stateAfterFailure(error), error: safeError(error) } satisfies ExtensionResponse);
    });
    return true;
  }
  if (!validRequest(message)) return false;
  const operation = workCoordinator.run('auth', async (context) => {
    const response = await handle(message, context);
    try { await writeAuthSnapshot(response.state); } catch { /* snapshot is best-effort */ }
    return response;
  });
  void operation.then(respond, async (error: unknown) => {
    if (!await store.loadCredential()) sw.bindingPromise = undefined;
    respond({ ok: false, state: await stateAfterFailure(error), error: safeError(error) } satisfies ExtensionResponse);
  });
  return true;
});

/** Confirm starts the first sync. Every sync label render reads status, so a
 * status read wakes the engine only while that first sync is still running. */
function firstRunNeedsEngine(message: FirstRunRequest, response: FirstRunOrScopeResponse): boolean {
  if (!response.ok) return false;
  return message.kind === 'known.firstRun.confirm'
    || message.kind === 'known.firstRun.attention.decide'
    || (message.kind === 'known.firstRun.status' && 'firstRun' in response && response.firstRun === 'running');
}

chrome.runtime.onMessageExternal.addListener((message,sender,respond)=>{
  void loadSubscriptionConfig().then(config=>acceptExternalReference(message,sender.url,config)).then(respond,()=>respond({accepted:false}));
  return true;
});
