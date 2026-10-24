import { moveSuggestedBookmark } from './classification-destination-client.js';
import { personalBookmarks } from './bookmark-subscriptions/guards.js';
import type { CaptureTask, FeedbackKind } from './capture/contracts.js';
import type { CaptureEditRequest } from './capture/editor.js';
import { openOptionsRoute } from './popup-footer.js';
import { saveAnnotation } from './popup-annotations.js';
import type { PopupNote } from './popup-note.js';
import { decisionTags, resultBookmarkId, type bindResultFields } from './popup-result-fields.js';
import type { PopupFields } from './popup-fields.js';
import type { bindSaveFolderPicker } from './save-folder-ui.js';
import { t } from './i18n.js';
import type { ResultPanelOptions } from './capture/result-panel.js';
import { removePopupBookmark, undoPopupBookmark } from './popup-bookmark-delete.js';
import type { PublicBatchStatus } from './types.js';
import { requestPin } from './bookmark-pin-messages.js';
import type { SavedPinToggle } from './popup-pin.js';

type Reply = { readonly ok: boolean; readonly task?: CaptureTask; readonly error?: string };

export interface ResultActionDeps {
  readonly preview: boolean;
  readonly request: (message: unknown) => Promise<Reply>;
  /** The latest task as the panel shows it. */
  readonly current: () => CaptureTask | undefined;
  readonly show: (task: CaptureTask) => void;
  readonly note: PopupNote;
  readonly fields: PopupFields;
  readonly resultFields: ReturnType<typeof bindResultFields>;
  readonly folders: ReturnType<typeof bindSaveFolderPicker>;
  readonly pin?: SavedPinToggle;
  readonly close: () => void;
}

/**
 * What the automatic result's buttons and the folder pill do. Nothing here
 * invents a new protocol: ratings, corrections and presentation use the same
 * capture messages the rating buttons and the correction form always used, and
 * Undo is the native remove that the popup's Remove uses.
 */
export function createResultActions(deps: ResultActionDeps): Pick<ResultPanelOptions, 'present' | 'timedOut' | 'dismissed' | 'done' | 'undo' | 'remove' | 'restore' | 'history' | 'close'> & {
  /** The user picked a folder in the shared picker: correct the AI's choice. */
  pick(parentNativeId: string): Promise<boolean>;
} {
  const { preview, note } = deps;
  let rating: { kind: FeedbackKind; eventId: string } | undefined, edit: { key: string; id: string } | undefined;
  let pendingPolicy: string | undefined;
  let negativeSent = false, closeBlocked = false, removed = false, pendingParent: string | undefined;
  let deletion: PublicBatchStatus | undefined;

  async function feedback(task: CaptureTask, kind: FeedbackKind): Promise<void> {
    // Local results have no server decision to rate; the folder itself is the record.
    if (preview || !task.decisionId) return;
    if (!rating || rating.kind !== kind) rating = { kind, eventId: crypto.randomUUID() };
    await deps.request({ kind: 'known.capture.feedback', captureId: task.captureId, nodeRevision: task.appliedRevision,
      eventId: rating.eventId, feedback: kind });
    rating = undefined;
  }

  /** Title, folder (of an already-saved page) and tags/note edits made in the popup. */
  async function applyEdits(task: CaptureTask): Promise<boolean> {
    const id = resultBookmarkId(task);
    const title = deps.resultFields.editedTitle(task);
    if (id && title) await personalBookmarks.update(id, { title });
    if (id && pendingParent) { if (pendingPolicy) await moveSuggestedBookmark(id, pendingParent, pendingPolicy, crypto.randomUUID()); else await personalBookmarks.move(id, { parentId: pendingParent }); }
    const edited = deps.resultFields.editedAnnotation();
    if (edited) {
      const saved = await saveAnnotation(edited.bookmark, edited.annotation, edited.base);
      if (saved === null) return false;
      if (!saved) throw new Error('annotation_unavailable');
    }
    // After any move, so the worker places the bookmark in the folder it now lives in.
    const pinned = deps.pin?.change();
    if (id && pinned !== undefined && !(await requestPin({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: id, pinned })).ok) {
      throw new Error('pin_failed');
    }
    return true;
  }

  return {
    async present(task) {
      if (!preview && task.decisionId) await deps.request({ kind: 'known.capture.presented', captureId: task.captureId, nodeRevision: task.appliedRevision });
    },
    async timedOut(task) { await feedback(task, 'implicit_positive'); },
    dismissed(task) {
      if (task.classification === 'applied' && !task.feedbackKind && !preview && !removed) void feedback(task, 'dismissed_unrated').catch(() => undefined);
    },
    async done(task) {
      if (preview) return true;
      // The AI's folder stands: Done is the same "right folder" rating the old button sent.
      if (task.classification === 'applied' && !deps.resultFields.wasCorrected()) {
        try { await feedback(task, 'explicit_positive'); }
        catch {
          note.set('feedback', t('capture_feedbackCouldNotSaved', 'Your feedback could not be saved. Keep this panel open and retry.'), 'error');
          if (!closeBlocked) { closeBlocked = true; return false; }
        }
      }
      try { if (!await applyEdits(task)) return false; }
      catch {
        note.set('feedback', t('popup_couldntSaveChanges', "Couldn't save the changes. Try again."), 'error');
        return false;
      }
      return true;
    },
    async undo(task) {
      const id = resultBookmarkId(task);
      if (!id) return false;
      try { await personalBookmarks.remove(id); }
      catch { note.set('feedback', t('popup_couldntRemoveBookmark', "Couldn't remove the bookmark. Try again."), 'error'); return false; }
      removed = true;
      // History must stop listing the capture as saved. The bookmark is already gone, so a worker
      // that cannot record it does not undo the removal; the capture simply stays as it was.
      if (!preview) await deps.request({ kind: 'known.capture.remove', captureId: task.captureId, userGesture: true }).catch(() => undefined);
      return true;
    },
    async remove(task) {
      const exact = task.existence?.exact;
      if (preview || task.disposition !== 'existing' || exact?.length !== 1 || !exact[0]?.writable || !exact[0].nativeId) return false;
      try {
        deletion ??= await removePopupBookmark(exact[0].nativeId);
        removed = true;
        note.set('feedback', t('popup_removedUndo', 'Bookmark removed. Undo is available here or in the library for five minutes.'));
        return true;
      } catch { note.set('feedback', t('popup_couldntRemoveBookmark', "Couldn't remove the bookmark. Try again."), 'error'); return false; }
    },
    async restore() {
      if (!deletion || preview) return false;
      try { await undoPopupBookmark(deletion); return true; }
      catch { note.set('feedback', t('popup_couldntRestoreBookmark', "Couldn't restore the bookmark. Try again."), 'error'); return false; }
    },
    history() { if (!preview) openOptionsRoute('#history'); },
    close: deps.close,
    async pick(parentNativeId: string, aiDestinationPolicyDigest?: string) {
      const task = deps.current();
      const id = task ? resultBookmarkId(task) : null;
      if (!task || !id || preview) return false;
      note.set('feedback', undefined);
      if (task.disposition === 'existing' && !task.contentIntent) { pendingParent = parentNativeId; pendingPolicy = aiDestinationPolicyDigest; return true; }
      const [node] = await chrome.bookmarks.get(id).catch(() => []);
      const original = node?.parentId;
      if (!original) return false;
      if (original === parentNativeId) return true;
      const chips = deps.fields.tags.tags().map((tag) => tag.toLowerCase());
      const tags = task.decisionId ? decisionTags(task).filter((tag) => chips.includes(tag.toLowerCase())) : deps.fields.tags.tags();
      try {
        if (task.classification === 'applied' && !negativeSent) { await feedback(task, 'explicit_negative'); negativeSent = true; }
        const key = JSON.stringify([task.captureId, parentNativeId, original, tags]);
        if (edit?.key !== key) edit = { key, id: crypto.randomUUID() };
        const message: CaptureEditRequest = { kind: 'known.capture.edit', captureId: task.captureId, commandId: edit.id,
          parentNativeId, originalParentNativeId: original, tags, ...(aiDestinationPolicyDigest ? { aiDestinationPolicyDigest } : {}), userGesture: true };
        const reply = await deps.request(message);
        if (!reply.ok) throw new Error(reply.error ?? 'capture_edit_unavailable');
        deps.resultFields.markCorrected();
        if (reply.task) deps.show(reply.task);
        return true;
      } catch (error) {
        // A definite conflict means nothing moved; any other failure may have, so the pick stays and a retry is the same request.
        const conflict = error instanceof Error && /precondition|conflict|changed/u.test(error.message);
        if (conflict) await deps.folders.adopt(original);
        note.set('feedback', conflict
          ? t('capture_bookmarkChangedReopen', 'This bookmark changed. Close and reopen to choose again.')
          : t('capture_updateNotConfirmedPickAgain', "The update isn't confirmed. Pick the folder again to retry."), 'error');
        return false;
      }
    },
  };
}
