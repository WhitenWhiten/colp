import type { CaptureTask } from './contracts.js';
export interface CaptureEditRequest {
  readonly kind: 'known.capture.edit'; readonly captureId: string; readonly commandId: string; readonly parentNativeId: string;
  readonly aiDestinationPolicyDigest?: string; readonly originalParentNativeId: string; readonly tags: readonly string[]; readonly userGesture: true;
}
/**
 * Explicit abandon/replace entry point for a correction whose outcome is
 * unknown. Without it a stuck command could only be cleared by UI state, and a
 * new command was refused as `capture_edit_pending` forever.
 */
export interface CaptureEditCancelRequest {
  readonly kind: 'known.capture.edit.cancel'; readonly captureId: string; readonly commandId: string;
  readonly editCommandId: string; readonly userGesture: true;
}
export function validCaptureEdit(value: unknown): value is CaptureEditRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.kind === 'known.capture.edit' && raw.userGesture === true && Object.keys(raw).every(k => ['kind','captureId','commandId','parentNativeId','originalParentNativeId','tags','userGesture','aiDestinationPolicyDigest'].includes(k))
    && (raw.aiDestinationPolicyDigest === undefined || typeof raw.aiDestinationPolicyDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(raw.aiDestinationPolicyDigest))
    && [raw.captureId, raw.commandId].every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id))
    && [raw.parentNativeId, raw.originalParentNativeId].every(id => typeof id === 'string' && /^[\w.-]{1,128}$/u.test(id))
    && Array.isArray(raw.tags) && raw.tags.length <= 64 && raw.tags.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 64);
}
export function validCaptureEditCancel(value: unknown): value is CaptureEditCancelRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.kind === 'known.capture.edit.cancel' && raw.userGesture === true && Object.keys(raw).length === 5
    && [raw.captureId, raw.commandId, raw.editCommandId]
      .every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/u.test(id));
}

/** The tags the cloud decision put on this bookmark; the only tags a folder correction can carry. */
export const decisionTags = (task: CaptureTask): readonly string[] => task.editIntent?.execution === 'native' && task.editIntent.completed
  ? task.editIntent.tags : task.automatic?.decision?.tags ?? [];

/**
 * A folder correction for one saved bookmark, shared by the History detail and
 * anything else that changes where a capture lives. The same request is sent
 * again on a retry (one durable command per folder-and-tags choice), so a
 * correction whose outcome was never confirmed is never applied twice, and the
 * worker's own "stuck command" can be released explicitly with `abandon`.
 */
export function createCaptureCorrection(task: CaptureTask) {
  let commandId: string | undefined, commandKey = '', submitting = false;
  const stuck = task.editIntent && !task.editIntent.completed ? task.editIntent : undefined;
  return {
    /** The previous correction that never confirmed, if the worker still holds one. */
    stuck,
    /** Sends the correction. Resolves with the updated task; rejects with the worker's error code. */
    async submit(parentNativeId: string, originalParentNativeId: string, chips: readonly string[]): Promise<CaptureTask | undefined> {
      if (submitting) throw new Error('capture_edit_busy');
      const wanted = new Set(chips.map(tag => tag.toLowerCase()));
      const tags = task.decisionId ? decisionTags(task).filter(tag => wanted.has(tag.toLowerCase())) : chips;
      const key = JSON.stringify([parentNativeId, originalParentNativeId, tags]);
      if (key !== commandKey) { commandKey = key; commandId = crypto.randomUUID(); }
      submitting = true;
      try {
        const message: CaptureEditRequest = { kind: 'known.capture.edit', captureId: task.captureId, commandId: commandId!, parentNativeId,
          originalParentNativeId, tags: [...new Set(tags)], userGesture: true };
        const reply = await chrome.runtime.sendMessage(message) as { ok?: boolean; error?: string; task?: CaptureTask };
        if (!reply?.ok) throw new Error(reply?.error ?? 'capture_edit_failed');
        return reply.task;
      } finally { submitting = false; }
    },
    /** Releases a correction whose outcome is unknown so a new one can be admitted. */
    async abandon(): Promise<void> {
      if (!stuck) return;
      const message: CaptureEditCancelRequest = { kind: 'known.capture.edit.cancel', captureId: task.captureId,
        commandId: crypto.randomUUID(), editCommandId: stuck.commandId, userGesture: true };
      const reply = await chrome.runtime.sendMessage(message) as { ok?: boolean; error?: string };
      if (!reply?.ok) throw new Error(reply?.error ?? 'capture_edit_failed');
      commandId = undefined; commandKey = '';
    },
  };
}
export const isEditConflict = (error: unknown): boolean => error instanceof Error && /precondition|conflict|changed/u.test(error.message);
