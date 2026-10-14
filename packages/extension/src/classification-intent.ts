import type { CaptureExistence, CaptureTask } from './capture/contracts.js';
import type { ClassificationPreviewRequest } from './classification-product-client.js';

/** Entry points describe intent; the worker decides whether it may dispatch. */
export type ClassificationTrigger =
  | { readonly kind: 'form-open'; readonly existence: CaptureExistence }
  | { readonly kind: 'user-request' }
  | { readonly kind: 'saved-capture'; readonly task: Pick<CaptureTask,
    'automaticIntent' | 'disposition' | 'save' | 'classification' | 'manualFence' | 'annotation' | 'annotationPersisted'> };

export type FormOpenClassificationSkip = 'already_saved' | 'existence_unavailable';
export function classificationTriggerReason(trigger: Exclude<ClassificationTrigger, { kind: 'saved-capture' }>): FormOpenClassificationSkip | null;
export function classificationTriggerReason(trigger: ClassificationTrigger): FormOpenClassificationSkip | 'manually_edited' | 'capture_not_ready' | null;
export function classificationTriggerReason(trigger: ClassificationTrigger) {
  switch (trigger.kind) {
    case 'user-request': return null;
    case 'form-open':
      if (trigger.existence.exact.length) return 'already_saved';
      return trigger.existence.coverage.local === 'complete' ? null : 'existence_unavailable';
    case 'saved-capture': {
      const task = trigger.task;
      // A bookmark created by THIS task remains eligible after native save.
      if (task.disposition !== 'new') return 'already_saved';
      if (task.manualFence) return 'manually_edited';
      if (!task.automaticIntent || task.save !== 'local-saved' || !['waiting', 'running'].includes(task.classification)
        || task.annotation && !task.annotationPersisted) return 'capture_not_ready';
      return null;
    }
  }
}

export interface ClassificationDocumentOptions {
  readonly tags: boolean;
  /** False when a rule already chose the folder: the request asks for tags only (callers send nothing when tags are off). */
  readonly folder?: boolean;
  readonly billing?: { readonly priceVersion: string; readonly maxPoints: number };
  readonly rejectedFolderIds?: readonly string[];
  readonly requireCandidate?: boolean;
}

/** Incoming page content is independent of the save task's optional node identity. */
export function classificationDocument(
  page: { readonly title: string; readonly url: string },
  options: ClassificationDocumentOptions,
): ClassificationPreviewRequest {
  return {
    source: 'extension',
    bookmark: { title: page.title, url: page.url, description: null },
    requested: options.folder === false ? { folder: false, tags: true } : { folder: true, tags: options.tags },
    ...(options.billing ? { billing: { ...options.billing } } : {}),
    ...(options.requireCandidate ? { folderSelectionMode: 'require_candidate' as const } : {}),
    ...(options.rejectedFolderIds?.length ? { rejectedFolderIds: [...options.rejectedFolderIds] } : {}),
  };
}
