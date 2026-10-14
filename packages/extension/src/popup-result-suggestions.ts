import type { CaptureTask } from './capture/contracts.js';
import { bindPopupClassification } from './popup-classification.js';
import { element } from './popup-dom.js';
import type { PopupFields } from './popup-fields.js';
import type { PopupNote } from './popup-note.js';
import type { bindSaveFolderPicker } from './save-folder-ui.js';

const RETRYABLE_REASONS = new Set([
  'local_key_required', 'local_key_rejected', 'local_call_in_progress', 'local_provider_unavailable',
  'local_request_failed', 'local_rate_limited', 'local_timeout', 'local_result_unknown', 'local_settings_changed',
  'local_classification_failed', 'low_confidence', 'contract_drift', 'credentials', 'rate_limited', 'deadline',
  'outcome_unknown', 'classification_unavailable',
]);

/** Suggestions for an already-saved capture use the same preview lane, then its durable correction. */
export function bindResultSuggestions(deps: {
  readonly preview: boolean;
  readonly current: () => CaptureTask | undefined;
  readonly fields: PopupFields;
  readonly note: PopupNote;
  readonly folders: ReturnType<typeof bindSaveFolderPicker>;
  readonly getManagedPrice?: () => Promise<{ readonly priceVersion: string; readonly unitPoints: number }>;
  readonly apply: (nativeId: string) => Promise<boolean>;
  readonly onApplied: () => void;
  readonly pause: () => void;
}) {
  let seeded = false, loading = false, stopped = false, epoch = 0;
  const title = element('tab-title') as HTMLTextAreaElement;
  const binding = deps.preview ? undefined : bindPopupClassification({
    fields: [title], chip: element('folder-suggest') as HTMLButtonElement, chipLabel: element('folder-suggest-label'),
    retry: element('folder-retry') as HTMLButtonElement, retryOnly: true,
    note: deps.note, tags: deps.fields.tags, getManagedPrice: deps.getManagedPrice,
    input: () => {
      const task = deps.current();
      return !task || stopped ? null : { collectionId: task.scope.collectionId ?? undefined,
        title: title.value.trim() || task.title, url: task.url };
    },
    inScope: async () => Boolean(deps.current()?.scope.collectionId),
    async chooseFolder(nativeId) {
      if (stopped || !await deps.apply(nativeId)) return false;
      await deps.folders.adopt(nativeId);
      return true;
    },
    onApplied: deps.onApplied, onRequest: deps.pause,
  });

  return {
    /** Polling must not overwrite the suggestion lane's result, error or cost note. */
    active: () => seeded && !stopped,
    async sync(task: CaptureTask): Promise<void> {
      const later = task.classification === 'manual' && task.local?.state === 'later' && task.reason === 'local_no_folder'
        && task.local.folderCandidateCount !== 0;
      const failed = task.automaticIntent && ['manual', 'failed'].includes(task.classification)
        && RETRYABLE_REASONS.has(task.reason ?? '');
      const retry = !task.manualFence && (later || failed);
      // A rule owns this folder: the result never offers a model's folder in its place.
      if (!binding || stopped || seeded || loading || task.disposition !== 'new' || task.classification !== 'applied' && !retry
        || !task.nativeId || !task.local && task.sync !== 'confirmed' || deps.folders.userPicked() || task.automation) return;
      loading = true;
      const at = epoch;
      try {
        if (retry) {
          await binding.refresh(task.scope.collectionId ?? undefined);
          if (!stopped && at === epoch && deps.current()?.captureId === task.captureId && !deps.folders.userPicked()) {
            seeded = binding.seedRetry({ requireCandidate: later || task.reason === 'low_confidence' });
          }
          return;
        }
        const [bookmark] = await chrome.bookmarks.get(task.nativeId);
        if (!bookmark?.parentId) return;
        const [folder] = await chrome.bookmarks.get(bookmark.parentId);
        if (!folder || folder.url !== undefined || folder.unmodifiable) return;
        const folderId = task.automatic?.decision?.parentId ?? undefined;
        if (task.local) {
          if (task.local.folderNativeId !== folder.id) return;
        } else {
          if (!task.scope.collectionId || !folderId) return;
          const reply = await chrome.runtime.sendMessage({ kind: 'known.classification.folder', collectionId: task.scope.collectionId,
            folderId, userGesture: true }) as { ok?: boolean; nativeFolder?: { nativeId: string } };
          if (!reply?.ok || reply.nativeFolder?.nativeId !== folder.id) return;
        }
        await binding.refresh(task.scope.collectionId ?? undefined);
        if (stopped || at !== epoch || deps.current()?.captureId !== task.captureId || deps.folders.userPicked()) return;
        seeded = binding.seedApplied({ nativeId: folder.id, title: folder.title, folderId });
      } catch { /* A missing bookmark, mapping or provider leaves the saved result and manual picker available. */ }
      finally { loading = false; }
    },
    picked() { epoch++; seeded = false; stopped = true; binding?.reset(); },
    dispose() { epoch++; stopped = true; binding?.reset(); },
  };
}
