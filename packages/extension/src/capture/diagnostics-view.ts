import { createIcon } from '../icons.js';
import { t } from '../i18n.js';
export function createCaptureDiagnosticsView(host: HTMLElement) {
  // One notice says what the check found; the link inside it (hidden until a diagnostic names where to go) is the next step.
  const alert = document.createElement('div'); alert.className = 'inline-alert';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  // Hidden until a diagnostic names where to go; before that it is an empty pill with no href.
  const link = document.createElement('a'); link.className = 'btn btn-ghost btn-sm'; link.hidden = true;
  alert.append(createIcon('info'), message, link);
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'btn btn-ghost btn-sm'; refresh.textContent = t('common_recheck', 'Recheck');
  const download = document.createElement('button'); download.type = 'button'; download.className = 'btn btn-ghost btn-sm'; download.textContent = t('capture_downloadRedactedJson', 'Download redacted JSON');
  const actions = document.createElement('div'); actions.className = 'section-commands'; actions.append(refresh, download);
  const detail = document.createElement('details'), summary = document.createElement('summary'), output = document.createElement('pre');
  detail.className = 'disclosure diagnostics-technical';
  summary.textContent = t('capture_redactedDiagnosticDetails', 'Redacted diagnostic details'); detail.append(summary, output);
  let diagnostic: Record<string, unknown> | undefined, generation = 0;
  host.replaceChildren(alert, actions, detail);
  const copy: Record<string, readonly [string, string, string]> = {
    permission_required: [t('capture_bookmarkAccessOffExisting', 'Bookmark access is off. Existing bookmarks remain in your browser.'), '#general', t('capture_openBookmarkPermissions', 'Open bookmark permissions')],
    sign_in_required: [t('capture_signInForCloud', 'Saving works on this browser without an account. Sign in to use sync and Know-N suggestions.'), '#account?return=help', t('common_signIn', 'Sign in')],
    offline: [t('capture_browserOfflineConfirmedLocal', 'This browser is offline. Confirmed local bookmarks are saved.'), '#history?status=progress', t('capture_viewPendingTasks', 'View pending tasks')],
    preferences_conflict: [t('capture_accountPreferencesChangedElsewhere', 'Account preferences changed elsewhere. Review both values.'), '#saving', t('capture_resolvePreferenceConflict', 'Resolve preference conflict')],
    save_result_unknown: [t('capture_previousSaveNeedsVerification', 'A previous save needs verification before another create.'), '#history?status=attention', t('capture_checkSaveResults', 'Check save results')],
    sync_attention: [t('capture_someChangesNeedSync', 'Some changes need your sync confirmation.'), '#sync/center', t('capture_openSyncStatus', 'Open Sync › Status')],
    paused: [t('capture_automaticClassificationPausedBrowser', 'Automatic classification is paused on this browser. Saving and sync continue.'), '#ai', t('capture_openClassificationControls', 'Open classification controls')],
    authorization_required: [t('capture_automaticCaptureNeedsClassification', 'Automatic capture needs a classification spending authorization. Saved bookmarks are preserved.'), '#ai', t('common_reviewAuthorization', 'Review authorization')],
    credits_required: [t('capture_classificationWaitingCreditsSpending', 'Classification is waiting for credits or a spending limit review. Saved bookmarks are preserved.'), '#account/credits', t('common_openCredits', 'Open credits')],
    policy_unavailable: [t('capture_automaticFolderPlacementAwaiting', 'Automatic folder placement is awaiting quality approval. Choose folders manually for saved bookmarks.'), '#history', t('capture_reviewSavedTasks', 'Review saved tasks')],
    target_not_mapped: [t('capture_defaultFolderOutsideBrowsers', 'The default folder is outside this browser’s sync scope. Local saves remain available.'), '#ai', t('capture_reviewDefaultTarget', 'Review the default target')],
    policy_unknown: [t('capture_classificationAvailabilityCouldNot', 'Classification availability could not be verified. Existing bookmarks are preserved.'), '#ai', t('capture_recheckClassificationControls', 'Recheck classification controls')],
    credits_unavailable: [t('capture_creditsCouldNotVerified', 'Credits could not be verified. Existing bookmarks are preserved.'), '#account/credits', t('common_reviewCredits', 'Review credits')],
    status_unavailable: [t('capture_partRuntimeStatusCould', 'Part of the runtime status could not be read.'), '#saving', t('capture_recheckRuntimeStatus', 'Recheck runtime status')],
    manual: [t('capture_manualCaptureSelectedAutomatic', 'Manual capture is selected. Automatic classification is not dispatched.'), '#saving', t('capture_reviewCaptureMode', 'Review capture mode')],
    automatic: [t('capture_automaticClassificationReadyUnder', 'Automatic classification is ready under the current authorization.'), '#history', t('capture_viewHistory', 'View history')],
    ready: [t('capture_noIssueFoundChecked', 'No issue found in the checked local state.'), '#history', t('capture_viewHistory', 'View history')],
  };
  async function activate() {
    const current = ++generation; refresh.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ kind: 'known.capture.diagnostics' }) as { ok: boolean; diagnostic?: Record<string, unknown> };
      if (current !== generation) return;
      if (!response.ok || !response.diagnostic) throw new Error();
      diagnostic = response.diagnostic; const found = copy[String(diagnostic.reason)] ?? copy.status_unavailable!;
      // An unreadable timestamp is left out rather than printed as "Invalid Date".
      const checkedAt = new Date(String(diagnostic.checkedAt));
      message.textContent = Number.isNaN(checkedAt.getTime()) ? found[0] : t('capture_checked', '$1 Checked $2.', found[0], checkedAt.toLocaleTimeString());
      // Not signed in is a normal local-first state: a neutral note, not a warning.
      alert.dataset.tone = ['ready', 'automatic', 'manual'].includes(String(diagnostic.reason)) ? 'ok'
        : diagnostic.reason === 'sign_in_required' ? 'info' : 'warning';
      link.href = found[1]; link.textContent = found[2]; link.hidden = false; output.textContent = JSON.stringify(diagnostic, null, 2);
    } catch { if (current === generation) { message.textContent = t('capture_diagnosticsCouldNotRefreshed', 'Diagnostics could not be refreshed. The last available details are retained.'); alert.dataset.tone = 'warning'; } }
    finally { if (current === generation) refresh.disabled = false; }
  }
  refresh.addEventListener('click', () => { void activate(); });
  download.addEventListener('click', () => {
    if (!diagnostic) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'known-capture-diagnostics.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return { activate, deactivate() { generation++; refresh.disabled = false; } };
}
