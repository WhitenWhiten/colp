import type { BookmarkPreferencesResponse } from '../types.js';
import type { CaptureTask } from './contracts.js';
import { createCaptureResultPanel } from './result-panel.js';
import { createResultActions } from '../popup-result-actions.js';
import { bindResultFields } from '../popup-result-fields.js';
import { bindResultSuggestions } from '../popup-result-suggestions.js';
import { paintCaptureAlert } from '../popup-shell.js';
import { t } from '../i18n.js';
import type { PopupNote } from '../popup-note.js';
import type { PopupFields } from '../popup-fields.js';
import type { bindSaveFolderPicker } from '../save-folder-ui.js';
import type { SavedPinToggle } from '../popup-pin.js';

/** What the shared popup shell hands the automatic result: the same folder picker, fields and note line the manual save uses. */
export interface ResultShell {
  readonly folders: ReturnType<typeof bindSaveFolderPicker>;
  readonly fields: PopupFields;
  readonly note: PopupNote;
  /** The Folder row's pin toggle: shows the saved bookmark's pin and changes it on Done. */
  readonly pin?: SavedPinToggle;
  readonly getManagedPrice?: () => Promise<{ readonly priceVersion: string; readonly unitPoints: number }>;
  /** Registers who hears about folder picks while the result is on screen. */
  readonly onPick: (handler: ((nativeId: string) => void | Promise<void>) | undefined) => void;
}

async function request(message: unknown): Promise<{ task?: CaptureTask; actionPopup?: boolean; ok: boolean; error?: string }> {
  const reply = await chrome.runtime.sendMessage(message) as { ok: boolean; task?: CaptureTask; actionPopup?: boolean; error?: string };
  if (!reply?.ok) throw new Error(reply?.error ?? 'capture_unavailable'); return reply;
}
export async function initializeCapturePopup(shell?: ResultShell): Promise<boolean> {
  const surfaceUrl = new URL(location.href);
  if (!/^[0-9a-f-]{36}$/u.test(surfaceUrl.searchParams.get('surface') ?? '')) {
    surfaceUrl.searchParams.set('surface', crypto.randomUUID());
    // MessageSender.url is the initial navigation URL, even after replaceState.
    // A real navigation gives this document an immutable, unique sender URL.
    location.replace(surfaceUrl.href); return true;
  }
  if (!document.getElementById('capture') || !shell) return false;
  const params = new URLSearchParams(location.search), preview = params.get('preview'), resume = params.get('resumeOnly');
  if (preview) document.documentElement.dataset.preview = preview;
  const preferences = preview ? null : await chrome.runtime.sendMessage({ kind: 'known.bookmark.preferences.local' })
    .catch(() => null) as BookmarkPreferencesResponse | null;
  const automatic = preferences?.ok && preferences.preferences.captureMode === 'automatic';
  if (!automatic && !preview && !resume) { document.body.dataset.captureMode = 'manual'; return false; }
  if (!preview && !resume) {
    const context = await request({ kind: 'known.capture.context' }).catch(() => null);
    if (!context?.actionPopup) { document.body.dataset.captureMode = 'manual'; return false; }
  }
  document.body.dataset.captureMode = 'automatic';
  let task: CaptureTask | undefined, stopped = false, reading = false, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
  const resultFields = bindResultFields({ folders: shell.folders, fields: shell.fields, preview: Boolean(preview), ...(shell.pin ? { pin: shell.pin } : {}) });
  let suggestions: ReturnType<typeof bindResultSuggestions> | undefined;
  const show = (next: CaptureTask) => { if (panel.removed()) return; task = next; panel.show(next);
    void resultFields.sync(next).then(() => suggestions?.sync(next)); };
  const actions = createResultActions({ preview: Boolean(preview), request, current: () => task, show, note: shell.note,
    fields: shell.fields, resultFields, folders: shell.folders, ...(shell.pin ? { pin: shell.pin } : {}),
    close: () => { if (preview) document.body.dataset.exiting = 'false'; else window.close(); } });
  shell.onPick(async (id) => { suggestions?.picked(); await actions.pick(id); });
  const panel = createCaptureResultPanel({
    duration: preferences?.ok ? preferences.preferences.resultPanelAutoDismissMs ?? 3000 : 3000, preview: Boolean(preview), note: shell.note,
    suggestionsActive: () => suggestions?.active() ?? false,
    ...actions,
  });
  suggestions = bindResultSuggestions({ preview: Boolean(preview), current: () => task, fields: shell.fields, note: shell.note,
    folders: shell.folders, getManagedPrice: shell.getManagedPrice, apply: actions.pick, onApplied: resultFields.markSuggested, pause: panel.pause });
  async function poll() {
    if (stopped || !task) return;
    if (reading) { dirty = true; return; }
    reading = true; dirty = false; clearTimeout(timer);
    try { const response = await request({ kind: 'known.capture.get', captureId: task.captureId }); if (response.task) show(response.task); }
    catch { /* Keep the last confirmed state through a transient worker restart. */ }
    reading = false;
    if (!stopped) timer = setTimeout(() => void poll(), dirty ? 100 : 750);
  }
  const invalidated = (message: unknown) => {
    if ((message as { kind?: string } | null)?.kind !== 'known.capture.invalidated' || stopped || !task) return false;
    if (reading) dirty = true;
    else if (!dirty) { dirty = true; clearTimeout(timer); timer = setTimeout(() => void poll(), 100); }
    return false;
  };
  if (!preview) chrome.runtime.onMessage.addListener(invalidated);
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); chrome.runtime.onMessage.removeListener(invalidated); suggestions?.dispose(); panel.dispose(); }, { once: true });
  if (preview) {
    const sample = previewTask(preview);
    show(sample);
    await resultFields.sync(sample);
    // Sample tags stand in for the AI's, so the preview shows the field as users get it.
    if (preview !== 'pending') shell.fields.annotation.write({ tags: [t('capture_previewTagWeb', 'Web'), t('capture_previewTagPerformance', 'Performance')], note: '' });
    if (preview === 'expanded') await shell.folders.open();
    return true;
  }
  try {
    if (resume) task = (await request({ kind: 'known.capture.get', captureId: resume })).task;
    else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) throw new Error('capture_page_unavailable');
      // Toolbar activation is authorized by POPUP document identity, not a fabricated userGesture.
      task = (await request({ kind: 'known.capture.start', commandId: crypto.randomUUID(), trigger: 'action-popup',
        url: tab.url, title: tab.title ?? tab.url, saveAnother: false, allowUnverifiedCloud: true })).task;
    }
    if (!task) throw new Error('capture_task_unavailable');
    show(task); void poll();
  } catch (error) {
    document.body.dataset.captureError = error instanceof Error && /^[a-z_]{1,64}$/u.test(error.message) ? error.message : 'capture_unavailable';
    panel.reveal();
    paintCaptureAlert(error instanceof Error && error.message === 'permission_required'
      ? t('capture_bookmarkAccessRequiredOpen', 'Bookmark access is required. Open mode settings to enable it.') : t('capture_captureCouldNotStart', 'Capture could not start. Open mode settings or retry from the toolbar.'));
  }
  return true;
}

function previewTask(mode: string): CaptureTask {
  const applied = mode !== 'pending';
  return { version: 1, captureId: 'preview', commandId: 'preview', batchId: null,
    scope: { serverOrigin: 'https://know-n.com', accountId: null, authorityGeneration: 0, collectionId: 'preview' },
    source: 'action-popup', tabId: null, title: t('capture_understandingBrowserRendering', 'Understanding browser rendering'), url: 'https://example.org/',
    targetNativeId: 'preview', insertPosition: 'bottom', saveAnother: false, allowUnverifiedCloud: true,
    createdAt: 0, updatedAt: 0, revision: 0, policyVersion: 'capture-folder.v1', automaticIntent: true,
    disposition: 'new', save: 'local-saved', classification: applied ? 'applied' : 'waiting', sync: applied ? 'confirmed' : 'pending',
    existence: { kind: 'not-found', exact: [], similar: [], coverage: { local: 'complete', cloud: 'complete', collectionIds: ['preview'], checkedAt: 0, stale: false } },
    nativeIntentId: null, nativeId: 'preview', nodeId: null, executionId: null, decisionId: applied ? 'preview' : null,
    localLocation: { nativeId: 'preview', nodeId: null, collectionId: 'preview', collectionTitle: t('common_myCollection', 'My collection'), writable: true,
      url: 'https://example.org/', path: [t('common_myCollection', 'My collection'), t('common_development', 'Development'), t('common_frontend', 'Frontend')] },
    cloudLocation: null, appliedRevision: applied ? 'preview' : null, manualFence: 0, controlGeneration: 0,
    reason: applied ? null : 'offline' };
}

export { allowManualCapture, showManualCaptureExistence } from './manual-existence.js';
