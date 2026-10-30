import type { CaptureTask } from './contracts.js';
import { createPanelClock } from './panel-clock.js';
import { element, setHidden } from '../popup-dom.js';
import type { PopupNote } from '../popup-note.js';
import { paintCaptureAlert, paintStatusLine, setFooterMode, type StatusLine } from '../popup-shell.js';
import { localized, t } from '../i18n.js';
import { automationSaveLine } from '../save-status.js';

let reasons: Record<string, string>;
localized(() => {
  reasons = {
  cloud_destination_policy_unsupported: 'Saved. This server cannot enforce source folder exclusions. Choose a folder manually or use your configured local AI service.',
  destination_policy_changed: 'Saved. Folder eligibility changed. Ask for a new suggestion.',
  destination_policy_needs_rebind: 'Saved. Rebind the source root in Site adapters before asking for suggestions.',
  policy_unavailable: t('capture_savedAutomaticClassificationAwaiting', 'Saved. Folder suggestions are unavailable right now.'),
  authorization_required: t('capture_savedEnableClassificationAuthorization', 'Saved. Set a spending limit under AI suggestions to get folder suggestions.'),
  paused: t('capture_savedAutomaticClassificationPaused', 'Saved. Folder suggestions are paused on this browser.'),
  manual: t('capture_savedAutomaticClassificationOff', 'Saved. Folder suggestions are off.'),
  offline: t('capture_savedBrowserClassificationWill', 'Saved on this browser. The folder suggestion will finish when you are back online.'),
  target_not_mapped: t('capture_savedChooseFolderAvailable', 'Saved. Choose a folder available in this browser.'),
  insufficient_credits: t('capture_savedClassificationNeedsMore', 'Saved. Not enough credits for a folder suggestion.'),
  period_credit_limit: t('capture_savedClassificationSpendingLimit', 'Saved. Your daily spending limit was reached.'),
  application_result_unknown: t('capture_savedCheckingSubmittedClassification', 'Saved. Checking the suggestion result.'),
  local_key_required: t('capture_savedLocalKeyRequired', 'Saved. Add your AI service key under AI suggestions in settings.'),
  local_key_rejected: t('capture_savedLocalKeyRejected', 'Saved. Your AI service rejected the key.'),
  local_provider_unavailable: t('capture_savedLocalProviderUnavailable', 'Saved. The suggestion could not be completed. Try again.'),
  local_call_in_progress: t('capture_savedLocalCallInProgress', 'Saved. A suggestion is already running. Try again when it finishes.'),
  local_request_failed: t('capture_savedLocalRequestFailed', 'Saved. Your AI service rejected the request or replied in an unexpected format.'),
  local_rate_limited: t('capture_savedLocalRateLimited', 'Saved. Your AI service is busy or rate limited. Try again shortly.'),
  local_timeout: t('capture_savedLocalTimeout', 'Saved. The suggestion timed out. Try again.'),
  local_settings_changed: t('capture_savedLocalSettingsChanged', 'Saved. Your AI service settings changed. Try again.'),
  local_request_too_large: t('capture_savedLocalRequestTooLarge', 'Saved. The page and folder list are too large to send.'),
  local_taxonomy_too_large: t('capture_savedLocalTaxonomyTooLarge', 'Saved. There are too many folders for a suggestion.'),
  local_no_folder: t('capture_savedLocalNoFolder', 'Saved. No folder fit this page.'),
  local_no_folders: t('capture_savedLocalNoFolders', 'Saved. Create a bookmark folder for suggestions to choose from.'),
  local_result_unknown: t('capture_savedLocalInterrupted', 'Saved. The suggestion was interrupted.'),
  local_classification_failed: t('capture_savedLocalFailed', "Saved. The suggestion couldn't run. Choose a folder instead."),
  manually_edited: t('capture_savedKeptYourChange', 'Saved. Your change was kept.'),
  classification_corrected: t('capture_savedKeptYourChange', 'Saved. Your change was kept.'),
};
});

/** Reasons that are only information; every other one needs the user's eye and gets the alert. */
const CALM_REASONS: ReadonlySet<string> = new Set(['manually_edited', 'classification_corrected', 'offline']);

/** Where a result lives: this browser only, syncing, or in your library (Know-N's or a COLP Server's). Copy follows the task's sync state. */
function syncMeta(task: CaptureTask): string {
  switch (task.sync) {
    case 'confirmed': return t('capture_syncedToLibrary', 'Synced to your library');
    case 'pending': case 'syncing': return task.scope.accountId ? t('capture_syncingToLibrary', 'Syncing to your library') : t('capture_onThisBrowser', 'On this browser');
    case 'attention': return t('capture_syncNeedsAttention', 'Sync needs attention');
    default: return t('capture_onThisBrowser', 'On this browser');
  }
}

/** The status line for a task: saved, already saved, or what is still going on. */
export function resultStatus(task: CaptureTask, preview = false): StatusLine {
  if (task.disposition === 'existing') return { icon: 'bookmark', tone: 'neutral', text: t('common_alreadySaved', 'Already saved') };
  if (task.save === 'local-saved') {
    return { icon: 'check-circle', text: preview ? t('capture_previewSaved', 'Preview · Saved') : t('common_saved', 'Saved'), meta: syncMeta(task) };
  }
  if (task.save === 'failed') return { icon: 'alert', tone: 'danger', text: t('capture_couldNotSave', 'Could not save') };
  return { icon: 'clock', tone: 'neutral', text: task.save === 'unknown' ? t('capture_checkingSaveResult', 'Checking save result') : t('common_saving', 'Saving…') };
}

export interface ResultPanelOptions {
  /** Auto-close time; 0 means the user closes the popup (no progress line). */
  readonly duration: number;
  /** The Options preview: nothing is saved, nothing closes, nothing is sent. */
  readonly preview?: boolean;
  readonly note: PopupNote;
  readonly suggestionsActive?: () => boolean;
  present(task: CaptureTask): Promise<void>;
  /** The progress line ran out: send the implicit rating, then the panel closes. */
  timedOut(task: CaptureTask): Promise<void>;
  /** The popup lost focus or is going away without an explicit choice. */
  dismissed(task: CaptureTask): void;
  /** Done: resolve true to close. */
  done(task: CaptureTask): Promise<boolean>;
  /** Undo: resolve true once the bookmark is gone. */
  undo(task: CaptureTask): Promise<boolean>;
  /** Remove an existing bookmark through the library's reversible deletion journal. */
  remove(task: CaptureTask): Promise<boolean>;
  /** Restore the existing bookmark just removed, then close this stale result. */
  restore(): Promise<boolean>;
  history(task: CaptureTask): void;
  close(): void;
}

/**
 * The automatic result in the popup shell: status line, alert/note, the
 * footer's Undo · History · Done and the auto-close progress line. The page
 * block and the Folder/Tags/Note rows are the shared ones (popup-result-fields.ts
 * keeps them in step with the task). The progress line pauses for good once
 * the pointer or focus enters, and closes the popup when it runs out.
 */
export function createCaptureResultPanel(options: ResultPanelOptions) {
  const progress = element('capture-progress');
  const doneButton = element('capture-done') as HTMLButtonElement;
  const undoButton = element('capture-undo') as HTMLButtonElement;
  const historyButton = element('capture-history') as HTMLButtonElement;
  const removeButton = element('remove-bookmark') as HTMLButtonElement;
  const fieldRows = element('pp-fields');
  let task: CaptureTask | undefined, clock: ReturnType<typeof createPanelClock> | undefined, presented: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined, generation = 0, disposed = false, working = false, removed = false;

  const interact = () => { clock?.pause('interaction'); progress.setAttribute('data-paused', ''); };
  document.documentElement.addEventListener('pointerenter', interact);
  document.addEventListener('focusin', interact);
  /** The skeleton gives way to the result as soon as there is something to show. */
  function reveal(): void {
    document.body.dataset.captureMode = 'automatic';
    setFooterMode('result');
    setHidden(element('popup-foot'), false);
    setHidden(element('capture'), false);
  }

  async function exit(own: number, delay = 0): Promise<void> {
    if (disposed || own !== generation) return;
    clearInterval(timer); clock?.stop();
    if (delay > 0) await new Promise((resolve) => { setTimeout(resolve, delay); });
    if (!disposed && own === generation) options.close();
  }
  const busy = async (work: () => Promise<void>) => {
    if (working) return;
    working = true; doneButton.disabled = undoButton.disabled = removeButton.disabled = true;
    try { await work(); } finally { working = false; doneButton.disabled = undoButton.disabled = removeButton.disabled = false; }
  };
  doneButton.addEventListener('click', () => {
    if (!task) return;
    const own = ++generation, current = task;
    clock?.stop();
    void busy(async () => { if (removed || await options.done(current)) await exit(own); });
  });
  removeButton.addEventListener('click', () => {
    if (!task || options.preview || working) return;
    const current = task, own = ++generation;
    clock?.stop();
    void busy(async () => {
      if (removed) { if (await options.restore()) await exit(own); return; }
      if (!await options.remove(current)) return;
      removed = true;
      paintStatusLine({ icon: 'check-circle', text: t('capture_removed', 'Removed'), tone: 'neutral' });
      setHidden(fieldRows, true);
      undoButton.hidden = true;
      removeButton.textContent = t('common_undo', 'Undo');
    });
  });
  undoButton.addEventListener('click', () => {
    if (!task || options.preview) return;
    const own = ++generation, current = task;
    clock?.stop();
    void busy(async () => {
      if (!await options.undo(current)) return;
      removed = true;
      paintStatusLine({ icon: 'check-circle', text: t('capture_removed', 'Removed'), tone: 'neutral' });
      setHidden(fieldRows, true); undoButton.hidden = true;
      await exit(own, 900);
    });
  });
  historyButton.addEventListener('click', () => { if (task) options.history(task); });
  const dismiss = () => { clock?.stop(); if (task) options.dismissed(task); };
  window.addEventListener('blur', dismiss); window.addEventListener('pagehide', dismiss, { once: true });

  function paintMessages(next: CaptureTask): void {
    const classifying = !next.reason && next.automaticIntent && next.save === 'local-saved' && ['waiting', 'running'].includes(next.classification);
    const message = next.reason ? reasons[next.reason] ?? t('capture_savedSomethingNeedsAttention', 'Saved. Something needs your attention: open Details.')
      // A rule chose the folder before the save; the user's own AI only suggests tags for it.
      : classifying ? next.automation ? t('capture_suggestingTags', 'Suggesting tags…') : t('capture_choosingFolder', 'Choosing a folder…') : '';
    const attention = Boolean(next.reason) && !CALM_REASONS.has(next.reason!);
    // What the rules did, in one line: a placement is calm, a rule that could not act needs the user's eye.
    const rule = next.save === 'local-saved' && next.disposition === 'new' ? automationSaveLine(next.automation) : null;
    paintCaptureAlert(attention ? message : rule?.attention ? rule.text : undefined);
    options.note.set('rule', rule && !rule.attention ? rule.text : undefined);
    if (!options.suggestionsActive?.()) options.note.set('classify', attention ? undefined : message);
    // Only a signed-in, synced save has a cloud copy worth checking for.
    const unverified = next.existence && ['partial', 'unavailable'].includes(next.existence.coverage.cloud) && !next.reason
      && next.scope.accountId && next.sync !== 'local-only';
    options.note.set('status', unverified ? t('capture_cloudStatusUnverified', 'Cloud status could not be verified.') : undefined);
  }

  function startClock(next: CaptureTask): void {
    clock = createPanelClock(options.duration, () => performance.now());
    if (document.documentElement.matches(':hover')) interact();
    if (document.body.contains(document.activeElement) && document.activeElement !== document.body) interact();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (disposed || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      void options.present(next).then(() => {
        if (disposed || document.visibilityState !== 'visible' || !document.hasFocus()) return;
        clock?.present();
        if (options.duration > 0) {
          progress.style.animationDuration = `${options.duration}ms`;
          setHidden(progress, false);
        }
      }).catch(() => { options.note.set('feedback', t('capture_resultReadyClosePanel', 'Result ready. Close this panel when you are done.')); });
    }));
    timer = setInterval(() => {
      if (!task || options.preview || document.visibilityState !== 'visible' || !document.hasFocus() || !clock?.finish()) return;
      const own = generation;
      void options.timedOut(task).then(() => exit(own)).catch(() => { options.note.set('feedback', t('capture_couldNotSaveFeedback', 'Could not save feedback. Close when ready.'), 'error'); });
    }, 100);
  }

  return {
    reveal,
    pause: interact,
    show(next: CaptureTask) {
      // Once Undo removed the bookmark, a late poll must not paint the old result back.
      if (removed) return;
      reveal();
      task = next;
      paintStatusLine(resultStatus(next, options.preview));
      paintMessages(next);
      const saved = next.save === 'local-saved';
      const existing = next.disposition === 'existing';
      setHidden(undoButton, !saved || existing);
      setHidden(removeButton, !existing || next.existence?.exact.length !== 1 || !next.existence.exact[0]?.writable);
      // A local result is final once the browser bookmark moved; a cloud one once sync confirms it.
      const complete = saved && next.classification === 'none'
        || next.classification === 'applied' && (next.local ? true : next.sync === 'confirmed') && !next.automatic?.decision?.undoneAt;
      document.body.dataset.complete = String(complete);
      const result = next.decisionId ?? `local:${next.captureId}`;
      if (complete && presented !== result) { presented = result; startClock(next); }
    },
    /** The result as last shown (the action handlers read it fresh). */
    current: () => task,
    /** Undo removed the bookmark: nothing else may repaint this result. */
    removed: () => removed,
    dispose() {
      disposed = true; clock?.stop(); clearInterval(timer);
      window.removeEventListener('blur', dismiss); window.removeEventListener('pagehide', dismiss);
      document.documentElement.removeEventListener('pointerenter', interact); document.removeEventListener('focusin', interact);
    },
  };
}
