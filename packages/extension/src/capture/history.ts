import { aggregateCaptures, captureNeedsAttention, type CaptureStatisticFact } from './statistics.js';
import { FIRST_RUN_LOCAL_ONLY } from '../first-run-draft.js';
import type { CaptureTask } from './contracts.js';
import type { LocalHistoryItem } from './local-history.js';
import { localized, t } from '../i18n.js';
export { aggregateCaptures };
export type HistoryStatus = 'all' | 'attention' | 'progress' | 'completed';
export function captureFact(task: LocalHistoryItem): CaptureStatisticFact {
  return { captureId: task.captureId, revision: task.revision, createdAt: task.createdAt, disposition: task.disposition,
    save: task.save, automaticIntent: task.automaticIntent, originalApplied: task.historyAutomaticApplied ?? task.automatic?.decision?.automaticApplied ?? Boolean(task.appliedRevision), feedback: task.feedbackKind ?? null,
    sync: task.sync, reason: task.reason, needsAttention: captureNeedsAttention(task.save, task.sync, task.reason),
    saveDurationMs: task.savedAt === undefined ? null : task.savedAt - task.createdAt,
    classificationDurationMs: task.classificationAppliedAt === undefined || task.savedAt === undefined ? null : task.classificationAppliedAt - task.savedAt };
}
export function captureHistoryStatus(task: CaptureTask): Exclude<HistoryStatus, 'all'> {
  if (captureFact(task).needsAttention) return 'attention';
  if (task.disposition !== 'new') return 'completed';
  return task.save === 'unsubmitted' || task.save === 'unknown' || task.classification === 'waiting' || task.classification === 'running'
    || task.sync === 'pending' || task.sync === 'syncing' ? 'progress' : 'completed';
}
export let CAPTURE_SAVE_COPY: Record<CaptureTask['save'], string>;
localized(() => {
  CAPTURE_SAVE_COPY = { unsubmitted: t('common_notSubmitted', 'Not submitted'), 'local-saved': t('capture_savedBrowser3', 'Saved on this browser'), unknown: t('capture_saveResultNeedsVerification', 'Save result needs verification'), failed: t('common_saveFailed', 'Save failed') };
});
export let CAPTURE_CLASS_COPY: Record<CaptureTask['classification'], string>;
localized(() => {
  CAPTURE_CLASS_COPY = { none: t('common_manualCapture', 'No suggestion'), waiting: t('capture_waitingClassification', 'Waiting for a suggestion'), running: t('common_classifying', 'Suggesting'), applied: t('common_automaticallyClassified', 'Folder suggested'), manual: t('common_manualReview', 'Manual review'), failed: t('capture_suggestionFailed', 'Suggestion failed') };
});
export let CAPTURE_SYNC_COPY: Record<CaptureTask['sync'], string>;
localized(() => {
  CAPTURE_SYNC_COPY = { 'local-only': FIRST_RUN_LOCAL_ONLY, pending: t('common_pendingSync', 'Pending sync'), syncing: t('common_syncing', 'Syncing'), confirmed: t('common_synced', 'Synced'), attention: t('capture_syncNeedsAttention', 'Sync needs attention') };
});

export const captureClassificationCopy = (task: LocalHistoryItem): string => task.classification === 'applied' && (task.historyAutomaticApplied ?? task.automatic?.decision?.automaticApplied) === false ? t('capture_suggestionApplied', 'Suggestion applied by you') : CAPTURE_CLASS_COPY[task.classification];
